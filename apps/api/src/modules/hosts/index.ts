/**
 * Hosts (the fleet): enrolment, listing and drain.
 *
 * Enrolment uses a one-time token created by a staff route. The token is
 * shown once and stored only as its SHA-256 hash. A host enrols with the
 * token and its Ed25519 public key and starts as `enrolled`; its first
 * verified signed request makes it `active` (proof that it holds the key).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EnrolRequest, Host } from "@softqraft/compute-contracts";
import { loadPublicKey } from "@softqraft/compute-jobs";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, HostRow, Resources, StoreTx } from "../../store/index.js";

export { registerEnrolRoute, registerFleetRoutes } from "./routes.js";

export const ENROLMENT_TOKEN_PREFIX = "sqet_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface FleetHost extends Host {
  allocated: Resources;
}

export interface Hosts {
  createEnrolmentToken(input: { hostName?: string; ttlSeconds?: number; now: Date }): Promise<{
    token: string;
    hostName: string | null;
    expiresAt: Date;
  }>;
  enrol(input: EnrolRequest, now: Date): Promise<HostRow>;
  list(): Promise<FleetHost[]>;
  drain(hostId: string): Promise<HostRow>;
  /** Record a verified agent request: last seen, and `enrolled` becomes `active`. */
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

export function createHosts(deps: {
  store: ComputeStore;
  /** Driver names this build knows (from the driver registry). */
  isKnownDriver: (name: string) => boolean;
  defaultTokenTtlSeconds: number;
}): Hosts {
  return {
    async createEnrolmentToken({ hostName, ttlSeconds, now }) {
      const token = `${ENROLMENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(now.getTime() + (ttlSeconds ?? deps.defaultTokenTtlSeconds) * 1000);
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
        const host = await tx.getHost(hostId);
        if (!host) throw new HttpError(404, "host_not_found", "Host not found");
        if (host.state === "draining") return host;
        if (host.state === "disabled") throw new HttpError(409, "host_disabled", "Host is disabled");
        const next: HostRow = { ...host, state: "draining" };
        await tx.updateHost(next);
        return next;
      });
    },

    async markSeen(tx, host, now) {
      const next: HostRow = { ...host, lastSeenAt: now, state: host.state === "enrolled" ? "active" : host.state };
      await tx.updateHost(next);
      return next;
    },
  };
}
