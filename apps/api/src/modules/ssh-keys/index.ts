/**
 * Saved SSH keys (C1d): the Create screen remembers a key after its first
 * use. Keys belong to a service instance and are public keys only, checked
 * by `parseSshPublicKey` (ed25519, or RSA of at least 3072 bits).
 *
 * Saving a key that is already saved returns the saved one, so the Create
 * screen can save on every create without making duplicates.
 */

import { randomUUID } from "node:crypto";
import { MAX_SAVED_SSH_KEYS, type SshKey } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, SshKeyRow } from "../../store/index.js";
import { parseSshPublicKey, SshKeyError } from "./parse.js";

export { parseSshPublicKey, SshKeyError, type ParsedSshKey, type SshKeyProblem } from "./parse.js";
export { registerConsoleSshKeyRoutes } from "./routes.js";

export interface SshKeys {
  list(serviceInstanceId: string): Promise<SshKey[]>;
  /** Save a key. `created` is false when it was already saved. */
  save(serviceInstanceId: string, input: { publicKey: string; name?: string }, now: Date): Promise<{ key: SshKey; created: boolean }>;
  remove(serviceInstanceId: string, id: string): Promise<void>;
}

const PROBLEMS = {
  private: () => new HttpError(400, "ssh_key_private", "This is a private key. Paste the public key instead"),
  malformed: () => new HttpError(400, "ssh_key_invalid", "This is not an OpenSSH public key"),
  unsupported: () => new HttpError(400, "ssh_key_unsupported", "Only ed25519 and RSA keys are accepted"),
  too_weak: () => new HttpError(400, "ssh_key_too_weak", "RSA keys must have at least 3072 bits"),
} as const;

export function toSshKey(row: SshKeyRow): SshKey {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    bits: row.bits,
    fingerprint: row.fingerprint,
    publicKey: row.publicKey,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createSshKeys(deps: { store: ComputeStore }): SshKeys {
  const { store } = deps;
  return {
    async list(serviceInstanceId) {
      return store.transaction(async (tx) => (await tx.listSshKeys(serviceInstanceId)).map(toSshKey));
    },

    async save(serviceInstanceId, input, now) {
      let parsed;
      try {
        parsed = parseSshPublicKey(input.publicKey);
      } catch (err) {
        if (err instanceof SshKeyError) throw PROBLEMS[err.problem]();
        throw err;
      }
      return store.transaction(async (tx) => {
        const existing = await tx.listSshKeys(serviceInstanceId);
        const same = existing.find((k) => k.fingerprint === parsed.fingerprint);
        if (same) return { key: toSshKey(same), created: false };
        if (existing.length >= MAX_SAVED_SSH_KEYS) {
          throw new HttpError(409, "ssh_key_limit", `At most ${MAX_SAVED_SSH_KEYS} keys can be saved`);
        }
        const row: SshKeyRow = {
          id: randomUUID(),
          serviceInstanceId,
          name: input.name ?? parsed.comment ?? parsed.type,
          type: parsed.type,
          bits: parsed.bits,
          fingerprint: parsed.fingerprint,
          publicKey: parsed.publicKey,
          createdAt: now,
        };
        if (!(await tx.insertSshKey(row))) {
          throw new HttpError(409, "concurrent_update", "The key was saved at the same time; retry the request");
        }
        return { key: toSshKey(row), created: true };
      });
    },

    async remove(serviceInstanceId, id) {
      const removed = await store.transaction((tx) => tx.deleteSshKey(serviceInstanceId, id));
      if (!removed) throw new HttpError(404, "ssh_key_not_found", "SSH key not found");
    },
  };
}
