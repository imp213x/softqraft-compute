/**
 * cloud-federation-v1 §2 and §8.1: the canonical string and request signing
 * (the Cloud side).
 *
 * The canonical string is UTF-8, lines joined by "\n", no trailing newline:
 *
 *   SQCF1
 *   <audience>                      (the service id, e.g. realtime-media)
 *   <HTTP METHOD, uppercase>
 *   <path including query string, exactly as sent>
 *   <timestamp, Unix seconds>
 *   <nonce, 32 lowercase hex>
 *   <lowercase hex SHA-256 of the raw body bytes>
 *
 * Nothing here logs. Error messages never contain key material.
 */

import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { CANONICAL_PREFIX, HEADERS } from "./contract.js";
import { validateServiceId } from "./roles.js";

export type BodyInput = string | Uint8Array;

export const NONCE_RE = /^[0-9a-f]{32}$/;
export const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const METHOD_RE = /^[A-Za-z]{1,16}$/;
// Line breaks in the path would let one canonical string read as another.
const PATH_FORBIDDEN_RE = /[\r\n]/;

/** Lowercase hex SHA-256. Strings are hashed as UTF-8. */
export function sha256Hex(data: BodyInput): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return createHash("sha256").update(bytes).digest("hex");
}

/** A new nonce: 16 random bytes as 32 lowercase hex characters. */
export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Throws when an audience is not a valid service id. */
export function assertAudience(audience: unknown): asserts audience is string {
  if (!validateServiceId(audience)) {
    throw new Error("Federation audience must be a service id (2-40 characters of a-z 0-9 -)");
  }
}

export interface CanonicalInput {
  audience: string;
  method: string;
  /** Request path including the query string, exactly as sent. */
  path: string;
  /** Unix seconds, as sent in the header. */
  timestamp: string | number;
  nonce: string;
  /** Lowercase hex SHA-256 of the raw body bytes. */
  bodySha256: string;
}

/** Build the §2 canonical string. The method is upper-cased; nothing else is changed. */
export function canonicalString(input: CanonicalInput): string {
  return [
    CANONICAL_PREFIX,
    input.audience,
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    input.bodySha256,
  ].join("\n");
}

export interface SignedHeaders {
  "X-SQ-Cloud-Key-Id": string;
  "X-SQ-Cloud-Timestamp": string;
  "X-SQ-Cloud-Nonce": string;
  "X-SQ-Cloud-Signature": string;
}

export interface SignRequestInput {
  /** The target service id, which is the canonical string's second line. */
  audience: string;
  keyId: string;
  /** PKCS#8 PEM string or a private KeyObject. Must be Ed25519. */
  privateKey: string | KeyObject;
  method: string;
  /** Request path including the query string, exactly as sent. */
  path: string;
  /** The exact body sent. Omit, or pass "", for an empty body. */
  body?: BodyInput;
  /** Unix seconds (whole) or a Date. Defaults to the current time. */
  now?: number | Date;
  /** 32 lowercase hex characters. Defaults to a new random nonce. */
  nonce?: string;
}

function toPrivateKey(key: string | KeyObject): KeyObject {
  if (typeof key === "string") {
    try {
      return createPrivateKey(key);
    } catch {
      throw new Error("Federation signing key is not a valid private key");
    }
  }
  if (key.type !== "private") {
    throw new Error("Federation signing key must be a private key");
  }
  return key;
}

/**
 * Sign a Cloud → service request and return the four §2 headers.
 * Output is byte-identical to the pre-package Cloud signer for the same inputs.
 */
export function signRequest(input: SignRequestInput): SignedHeaders {
  assertAudience(input.audience);
  if (!input.keyId || !KEY_ID_RE.test(input.keyId)) {
    throw new Error("Federation key id must be 1-64 characters of A-Z a-z 0-9 . _ -");
  }
  if (typeof input.method !== "string" || !METHOD_RE.test(input.method)) {
    throw new Error("Federation request method must be letters only");
  }
  if (typeof input.path !== "string" || !input.path.startsWith("/")) {
    throw new Error("Federation request path must start with /");
  }
  if (PATH_FORBIDDEN_RE.test(input.path)) {
    throw new Error("Federation request path must not contain line breaks");
  }

  const timestamp =
    input.now === undefined
      ? Math.floor(Date.now() / 1000)
      : input.now instanceof Date
        ? Math.floor(input.now.getTime() / 1000)
        : input.now;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("Federation timestamp must be whole Unix seconds");
  }

  const nonce = input.nonce ?? createNonce();
  if (!NONCE_RE.test(nonce)) {
    throw new Error("Federation nonce must be 32 lowercase hex characters");
  }

  const canonical = canonicalString({
    audience: input.audience,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodySha256: sha256Hex(input.body ?? ""),
  });

  const privateKey = toPrivateKey(input.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Federation signing key must be Ed25519");
  }

  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString(
    "base64url",
  );

  return {
    [HEADERS.keyId]: input.keyId,
    [HEADERS.timestamp]: String(timestamp),
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: signature,
  };
}
