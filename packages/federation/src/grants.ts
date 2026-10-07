/**
 * One-time grants and bearer session tokens (contract §3.2, §7.2, §8.2, §8.3).
 *
 * A grant is `<prefix>` + 32 random bytes in base64url (43 characters) and
 * is stored only as the SHA-256 hex of the whole string, prefix included.
 * `parseGrant` accepts exactly one kind, so a Console grant (`sqlg_`), a
 * link grant (`sqlk_`) and an operator grant (`sqog_`) can never stand in
 * for one another. Session tokens (`sqcs_`, `sqos_`) follow the same shape.
 *
 * Callers must never log a grant, a token or a URL containing one.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  GRANT_PREFIX,
  GRANT_TTL_SECONDS,
  LINK_GRANT_TTL_SECONDS,
  SESSION_PREFIX,
  type GrantKind,
  type SessionKind,
} from "./contract.js";
import { toEpochMs, type TimeInput } from "./time.js";

/** 32 bytes in base64url without padding. */
const SECRET_BODY_RE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 hex of a bearer secret (grant or session token), as stored. */
export function hashGrant(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Alias of `hashGrant` for session tokens. */
export const hashSessionToken = hashGrant;

function mintSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function parseSecret(value: unknown, prefix: string): string | null {
  if (typeof value !== "string" || value.length !== prefix.length + 43) return null;
  if (!value.startsWith(prefix)) return null;
  if (!SECRET_BODY_RE.test(value.slice(prefix.length))) return null;
  return hashGrant(value);
}

/** Default lifetime of a grant kind: 60s, or 10 minutes for `link`. */
export function grantTtlSeconds(kind: GrantKind): number {
  return kind === "link" ? LINK_GRANT_TTL_SECONDS : GRANT_TTL_SECONDS;
}

export interface MintedGrant {
  /** The secret. Goes only into the launch URL fragment; never log or store it. */
  grant: string;
  /** SHA-256 hex. This is what the service stores. */
  hash: string;
  expiresAt: Date;
}

export function mintGrant(
  kind: GrantKind,
  options: { now?: Date; ttlSeconds?: number } = {},
): MintedGrant {
  const prefix = GRANT_PREFIX[kind];
  if (!prefix) throw new Error("Unknown grant kind");
  const ttlSeconds = options.ttlSeconds ?? grantTtlSeconds(kind);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Grant TTL must be a positive number of seconds");
  }
  const now = options.now ?? new Date();
  const grant = mintSecret(prefix);
  return {
    grant,
    hash: hashGrant(grant),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
  };
}

/**
 * Parse a presented grant for one expected kind. Returns its storage hash,
 * or null for anything else: another kind's prefix, a session token, a
 * wrong length, a character outside base64url, surrounding whitespace, or a
 * non-string. The service then looks the hash up in that kind's own store.
 */
export function parseGrant(value: unknown, expectedKind: GrantKind): string | null {
  const prefix = GRANT_PREFIX[expectedKind];
  if (!prefix) return null;
  return parseSecret(value, prefix);
}

/**
 * Grant redemption rule: usable only when unused and `now < expiresAt`
 * (exclusive: a grant is dead at its expiry instant, as in Media).
 */
export function isGrantUsable(input: {
  expiresAt: TimeInput;
  usedAt?: TimeInput | null;
  now: TimeInput;
}): boolean {
  if (input.usedAt !== undefined && input.usedAt !== null) return false;
  const expiresAt = toEpochMs(input.expiresAt);
  const now = toEpochMs(input.now);
  return expiresAt > now; // NaN on either side → false
}

export interface MintedSessionToken {
  /** The bearer token. Goes only into the cookie or Authorization header. */
  token: string;
  hash: string;
}

export function mintSessionToken(kind: SessionKind): MintedSessionToken {
  const prefix = SESSION_PREFIX[kind];
  if (!prefix) throw new Error("Unknown session kind");
  const token = mintSecret(prefix);
  return { token, hash: hashGrant(token) };
}

/** Like `parseGrant`, for session tokens: returns the storage hash or null. */
export function parseSessionToken(value: unknown, expectedKind: SessionKind): string | null {
  const prefix = SESSION_PREFIX[expectedKind];
  if (!prefix) return null;
  return parseSecret(value, prefix);
}

/** Which session kind a bearer token claims to be, by prefix and shape; null if neither. */
export function sessionKindOf(value: unknown): SessionKind | null {
  if (parseSessionToken(value, "operator") !== null) return "operator";
  if (parseSessionToken(value, "console") !== null) return "console";
  return null;
}
