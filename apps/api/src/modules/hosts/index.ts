/**
 * Hosts (the fleet): enrolment, listing, drain, disable and enable.
 *
 * Enrolment uses a one-time token created by a staff route. The token is
 * shown once, stored only as its SHA-256 hash, works once and expires after
 * 30 minutes. A host enrols with the token and its Ed25519 public key and
 * starts as `enrolled`; its first verified signed request makes it
 * `active` (proof that it holds the key).
 *
 * Disable is the kill switch: the host gets no new work, its agent may
 * claim only stop jobs, and a stop is queued for every running instance on
 * it (through the injected `onDisable`). Enable reverses the first two;
 * stopped instances stay stopped.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ENROLMENT_TOKEN_TTL_SECONDS, type EnrolRequest, type Host } from "@softqraft/compute-contracts";
import { loadPublicKey } from "@softqraft/compute-jobs";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, HostRow, Resources, StoreTx } from "../../store/index.js";

export { registerEnrolRoute, registerFleetRoutes, type FleetAudit } from "./routes.js";

export const ENROLMENT_TOKEN_PREFIX = "sqet_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface FleetHost extends Host {
  allocated: Resources;
}

export interface Hosts {
  createEnrolmentToken(input: { hostName?: string; now: Date }): Promise<{
    token: string;
    hostName: string | null;
    expiresAt: Date;
  }>;
  enrol(input: EnrolRequest, now: Date): Promise<HostRow>;
  list(): Promise<FleetHost[]>;
  drain(hostId: string): Promise<HostRow>;
  /** The kill switch. Returns the host and how many stops were queued. */
  disable(hostId: string, now: Date): Promise<{ host: HostRow; stopsQueued: number }>;
  /** Back to `active` (or `enrolled` if the host has never been seen). */
  enable(hostId: string): Promise<HostRow>;
  /**
   * Record a verified agent request: last seen, and `enrolled` becomes
   * `active`. Only the host id of `host` is used: the row may be stale, and
   * the current state (for example `disabled`) is never overwritten.
   */
  markSeen(tx: StoreTx, host: HostRow, now: Date): Promise<HostRow>;
}

export function toHost(row: HostRow): Host {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    driver: row.driver,
    capacity: row.capacity,
    publicKey: row.publicKeyPem,
    enrolledAt: row.enrolledAt.toISOString(),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
  };
}

const ENROL_INVALID = () => new HttpError(401, "enrolment_invalid", "Enrolment token is invalid, used or expired");

const HOST_NOT_FOUND = () => new HttpError(404, "host_not_found", "Host not found");

export function createHosts(deps: {
  store: ComputeStore;
  /** Driver names this build knows (from the driver registry). */
  isKnownDriver: (name: string) => boolean;
  /** Queues a stop for every running instance on a host (the instances module). */
  onDisable: (tx: StoreTx, hostId: string, now: Date) => Promise<number>;
}): Hosts {
  return {
    async createEnrolmentToken({ hostName, now }) {
      const token = `${ENROLMENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(now.getTime() + ENROLMENT_TOKEN_TTL_SECONDS * 1000);
      await deps.store.transaction((tx) =>
        tx.insertEnrolmentToken({ tokenHash: hashToken(token), hostName: hostName ?? null, createdAt: now, expiresAt }),
      );
      return { token, hostName: hostName ?? null, expiresAt };
    },

    async enrol(input, now) {
      if (!deps.isKnownDriver(input.driver)) {
        throw new HttpError(400, "unknown_driver", "Driver is not supported by this API");
      }
      try {
        loadPublicKey(input.publicKey, "publicKey");
      } catch {
        throw new HttpError(400, "invalid_public_key", "publicKey must be an Ed25519 SPKI public key");
      }
      return deps.store.transaction(async (tx) => {
        const token = await tx.consumeEnrolmentToken(hashToken(input.token), now);
        // A name mismatch rolls the transaction back, so the token stays usable.
        if (!token || (token.hostName !== null && token.hostName !== input.name)) throw ENROL_INVALID();
        if (await tx.getHostByName(input.name)) {
          throw new HttpError(409, "host_name_taken", "A host with this name is already enrolled");
        }
        const host: HostRow = {
          id: randomUUID(),
          name: input.name,
          state: "enrolled",
          driver: input.driver,
          capacity: input.capacity,
          publicKeyPem: input.publicKey,
          enrolledAt: now,
          lastSeenAt: null,
        };
        await tx.insertHost(host);
        return host;
      });
    },

    async list() {
      return deps.store.transaction(async (tx) => {
        const hosts = await tx.listHosts();
        const out: FleetHost[] = [];
        for (const row of hosts) out.push({ ...toHost(row), allocated: await tx.hostAllocated(row.id) });
        return out;
      });
    },

    async drain(hostId) {
      return deps.store.transaction(async (tx) => {
        const host = await tx.lockHost(hostId);
        if (!host) throw HOST_NOT_FOUND();
        if (host.state === "draining") return host;
        if (host.state === "disabled") throw new HttpError(409, "host_disabled", "Host is disabled");
        const next: HostRow = { ...host, state: "draining" };
        await tx.updateHost(next);
        return next;
      });
    },

    async disable(hostId, now) {
      return deps.store.transaction(async (tx) => {
        // The host lock serialises the kill switch with job completions,
        // which take the same lock (see the instances module).
        const host = await tx.lockHost(hostId);
        if (!host) throw HOST_NOT_FOUND();
        const next: HostRow = { ...host, state: "disabled" };
        if (host.state !== "disabled") await tx.updateHost(next);
        // Repeating the kill switch queues stops for anything running again.
        const stopsQueued = await deps.onDisable(tx, hostId, now);
        return { host: next, stopsQueued };
      });
    },

    async enable(hostId) {
      return deps.store.transaction(async (tx) => {
        const host = await tx.lockHost(hostId);
        if (!host) throw HOST_NOT_FOUND();
        if (host.state === "active" || host.state === "enrolled") return host;
        const next: HostRow = { ...host, state: host.lastSeenAt ? "active" : "enrolled" };
        await tx.updateHost(next);
        return next;
      });
    },

    async markSeen(tx, host, now) {
      const current = await tx.touchHost(host.id, now);
      if (!current) throw HOST_NOT_FOUND();
      return current;
    },
  };
}
