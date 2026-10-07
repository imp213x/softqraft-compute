/**
 * cloud-federation-v1 §2 verification (the service side).
 *
 * Checks run in the contract's fixed order and the first failure decides:
 *   malformed → unknown_key → stale → signature → replay.
 * The nonce is stored only when every other check has passed.
 *
 * Storage is pluggable: a service supplies a `KeyRing` (usually the Map
 * returned by `parsePublicKeys`) and a `NonceStore` backed by whatever it
 * uses (Postgres, Redis, memory). Nothing here logs.
 */

import { Buffer } from "node:buffer";
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import {
  CLOCK_SKEW_SECONDS,
  FAILURE_RESPONSES,
  HEADERS_LOWER,
  NONCE_TTL_SECONDS,
  type ErrorCode,
  type VerifyFailure,
} from "./contract.js";
import {
  assertAudience,
  canonicalString,
  KEY_ID_RE,
  NONCE_RE,
  sha256Hex,
  type BodyInput,
} from "./signing.js";

const TIMESTAMP_RE = /^[0-9]{1,12}$/;
/** Ed25519 signatures are 64 bytes = 86 base64url characters without padding. */
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

/** Resolves a key id to an Ed25519 public key. A `Map<string, KeyObject>` satisfies it. */
export interface KeyRing {
  get(keyId: string): KeyObject | undefined;
}

/**
 * Remembers nonces for the replay window.
 *
 * `claim` must be an atomic check-and-set: it returns true when the nonce
 * was not held (and now holds it until `now + ttlSeconds`), and false when
 * it is still held, which is a replay.
 */
export interface NonceStore {
  claim(nonce: string, ttlSeconds: number, now: Date): Promise<boolean>;
}

/**
 * Process-local nonce store, for single-process services and tests.
 * A nonce claimed at t is held while now < t + ttl and is free again at
 * exactly t + ttl, matching the Media reference store.
 */
export class MemoryNonceStore implements NonceStore {
  private readonly held = new Map<string, number>();

  async claim(nonce: string, ttlSeconds: number, now: Date): Promise<boolean> {
    const nowMs = now.getTime();
    for (const [key, expiresAt] of this.held) {
      if (expiresAt <= nowMs) this.held.delete(key);
    }
    const expiresAt = this.held.get(nonce);
    if (expiresAt !== undefined && expiresAt > nowMs) return false;
    this.held.set(nonce, nowMs + ttlSeconds * 1000);
    return true;
  }

  /** Number of nonces currently held (for tests and metrics). */
  get size(): number {
    return this.held.size;
  }
}

export interface ParsePublicKeysOptions {
  /** Name used in error messages. Defaults to `CLOUD_FEDERATION_PUBLIC_KEYS`. */
  label?: string;
}

/**
 * Parse `{ "<keyId>": "<SPKI PEM>" }` (a JSON string or an object) into a
 * key ring. Throws on anything other than one or more Ed25519 SPKI public
 * keys. Error messages never include key material.
 */
export function parsePublicKeys(
  json: string | Record<string, unknown>,
  options: ParsePublicKeysOptions = {},
): Map<string, KeyObject> {
  const label = options.label ?? "CLOUD_FEDERATION_PUBLIC_KEYS";
  let parsed: unknown = json;
  if (typeof json === "string") {
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`${label} must be a JSON object`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`${label} must contain at least one key`);
  }
  const keys = new Map<string, KeyObject>();
  for (const [keyId, pem] of entries) {
    if (!KEY_ID_RE.test(keyId)) {
      throw new Error(`${label} key ids must be 1-64 characters of A-Z a-z 0-9 . _ -`);
    }
    if (
      typeof pem !== "string" ||
      !pem.includes("-----BEGIN PUBLIC KEY-----") ||
      pem.includes("PRIVATE KEY")
    ) {
      throw new Error(`${label}['${keyId}'] must be an SPKI public key PEM`);
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: pem, format: "pem" });
    } catch {
      throw new Error(`${label}['${keyId}'] is not a valid public key`);
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error(`${label}['${keyId}'] must be an Ed25519 public key`);
    }
    keys.set(keyId, key);
  }
  return keys;
}

export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Case-insensitive, single-valued header lookup; duplicates and arrays count as malformed. */
function singleHeader(headers: HeaderBag, name: string): string | null {
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (found !== null || typeof value !== "string") return null;
    found = value;
  }
  return found;
}

export type VerifyResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: VerifyFailure; code: ErrorCode; status: number };

export interface VerifyRequestInput {
  /** This service's audience id, e.g. `realtime-media`. */
  audience: string;
  method: string;
  /** Request path including the query string, exactly as received. */
  path: string;
  /** Exact request body bytes; undefined or empty means an empty body. */
  rawBody: BodyInput | undefined;
  headers: HeaderBag;
  keyRing: KeyRing;
  nonceStore: NonceStore;
  /** A Date, or Unix seconds (fractions allowed). Defaults to the current time. */
  now?: Date | number;
}

function fail(reason: VerifyFailure): VerifyResult {
  const response = FAILURE_RESPONSES[reason];
  return { ok: false, reason, code: response.code, status: response.status };
}

/**
 * Verify a signed Cloud → service request (contract §2, in order).
 * Throws only for a misconfigured audience; every request problem is a result.
 */
export async function verifyRequest(input: VerifyRequestInput): Promise<VerifyResult> {
  assertAudience(input.audience);
  const now =
    input.now === undefined
      ? new Date()
      : input.now instanceof Date
        ? input.now
        : new Date(input.now * 1000);
  const nowSeconds = now.getTime() / 1000;

  // 1. Headers present and well-formed.
  const keyId = singleHeader(input.headers, HEADERS_LOWER.keyId);
  const timestamp = singleHeader(input.headers, HEADERS_LOWER.timestamp);
  const nonce = singleHeader(input.headers, HEADERS_LOWER.nonce);
  const signature = singleHeader(input.headers, HEADERS_LOWER.signature);
  if (
    keyId === null ||
    timestamp === null ||
    nonce === null ||
    signature === null ||
    !KEY_ID_RE.test(keyId) ||
    !TIMESTAMP_RE.test(timestamp) ||
    !NONCE_RE.test(nonce) ||
    !SIGNATURE_RE.test(signature)
  ) {
    return fail("malformed");
  }

  // 2. Key id known.
  const key = input.keyRing.get(keyId);
  if (!key) return fail("unknown_key");

  // 3. |now − timestamp| ≤ 60s (inclusive; NaN fails).
  const skewSeconds = Math.abs(nowSeconds - Number(timestamp));
  if (!(skewSeconds <= CLOCK_SKEW_SECONDS)) return fail("stale");

  // 4. Signature over the canonical string built from the raw body bytes.
  const canonical = canonicalString({
    audience: input.audience,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodySha256: sha256Hex(input.rawBody ?? ""),
  });
  const signatureBytes = Buffer.from(signature, "base64url");
  let valid = false;
  try {
    valid =
      signatureBytes.length === 64 &&
      cryptoVerify(null, Buffer.from(canonical, "utf8"), key, signatureBytes);
  } catch {
    valid = false;
  }
  if (!valid) return fail("signature");

  // 5. Nonce not seen in the replay window; stored only on success.
  const claimed = await input.nonceStore.claim(nonce, NONCE_TTL_SECONDS, now);
  if (!claimed) return fail("replay");

  return { ok: true, keyId };
}
