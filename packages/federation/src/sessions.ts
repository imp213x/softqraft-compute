/**
 * Session policy (contract §5 and §8.4). Pure functions: storage and
 * lookup stay in the service.
 *
 * Boundaries (matching the Media reference implementation):
 * - Expiry is exclusive: valid while `now < expiresAt`; dead at expiresAt.
 * - Revocation: valid only if `createdAt > revokedAfter` (strict). A session
 *   created at the very instant of revocation is revoked.
 * - Freshness: fresh while `now − createdAt < maxAgeSeconds` (strict). With
 *   900s, age 899s is fresh and ages 900s and 901s are not.
 * - Invalid or missing times fail closed.
 *
 * A service still checks its own extra conditions (e.g. the service link is
 * `active`, operator launch is still enabled).
 */

import {
  CONTRACT_RESPONSES,
  FRESH_WRITE_SECONDS,
  type ErrorCode,
} from "./contract.js";
import { toEpochMs, type TimeInput } from "./time.js";

export type { TimeInput } from "./time.js";

export interface SessionValidityInput {
  createdAt: TimeInput;
  /** Absolute expiry. If both this and `ttlSeconds` are given, both apply. */
  expiresAt?: TimeInput | null;
  /** Absolute lifetime from `createdAt`, e.g. OPERATOR_SESSION_TTL_SECONDS. */
  ttlSeconds?: number | null;
  /** `cloud_principals.revoked_after`, when set. */
  revokedAfter?: TimeInput | null;
  now: TimeInput;
}

export type SessionEvaluation =
  | { valid: true; expiresAtMs: number }
  | { valid: false; reason: "invalid_input" | "expired" | "revoked" };

/** Like `isSessionValid`, with the reason when invalid. */
export function evaluateSession(input: SessionValidityInput): SessionEvaluation {
  const createdAt = toEpochMs(input.createdAt);
  const now = toEpochMs(input.now);
  if (Number.isNaN(createdAt) || Number.isNaN(now)) {
    return { valid: false, reason: "invalid_input" };
  }

  let expiresAtMs = Number.POSITIVE_INFINITY;
  let bounded = false;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const explicit = toEpochMs(input.expiresAt);
    if (Number.isNaN(explicit)) return { valid: false, reason: "invalid_input" };
    expiresAtMs = Math.min(expiresAtMs, explicit);
    bounded = true;
  }
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null) {
    if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
      return { valid: false, reason: "invalid_input" };
    }
    expiresAtMs = Math.min(expiresAtMs, createdAt + input.ttlSeconds * 1000);
    bounded = true;
  }
  // A session with no lifetime at all is a caller bug; fail closed.
  if (!bounded) return { valid: false, reason: "invalid_input" };

  if (!(now < expiresAtMs)) return { valid: false, reason: "expired" };

  if (input.revokedAfter !== undefined && input.revokedAfter !== null) {
    const revokedAfter = toEpochMs(input.revokedAfter);
    if (Number.isNaN(revokedAfter)) return { valid: false, reason: "invalid_input" };
    if (!(createdAt > revokedAfter)) return { valid: false, reason: "revoked" };
  }

  return { valid: true, expiresAtMs };
}

/** Contract §5 / §8.4 validity: unexpired and created after `revokedAfter` (when set). */
export function isSessionValid(input: SessionValidityInput): boolean {
  return evaluateSession(input).valid;
}

export interface FreshnessInput {
  createdAt: TimeInput;
  now: TimeInput;
  /** Defaults to FRESH_WRITE_SECONDS (900). */
  maxAgeSeconds?: number;
}

/** True while the session is younger than `maxAgeSeconds` (strict). */
export function isFresh(input: FreshnessInput): boolean {
  const createdAt = toEpochMs(input.createdAt);
  const now = toEpochMs(input.now);
  const maxAgeSeconds = input.maxAgeSeconds ?? FRESH_WRITE_SECONDS;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return false;
  return now - createdAt < maxAgeSeconds * 1000; // NaN → false
}

export type FreshResult = { ok: true } | { ok: false; status: number; code: ErrorCode };

/** `isFresh`, shaped as the §5 / §8.4 `403 reauth_required` response. */
export function requireFresh(input: FreshnessInput): FreshResult {
  if (isFresh(input)) return { ok: true };
  return {
    ok: false,
    status: CONTRACT_RESPONSES.reauthRequired.status,
    code: CONTRACT_RESPONSES.reauthRequired.code,
  };
}
