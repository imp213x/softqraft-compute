/**
 * Signed agent requests (host agent → API).
 *
 * Each enrolled host signs every request with its own Ed25519 key. The
 * canonical string is UTF-8, lines joined by "\n", no trailing newline:
 *
 *   SQCA1
 *   <host id>
 *   <HTTP METHOD, uppercase>
 *   <request path including query string, exactly as sent>
 *   <timestamp, Unix seconds>
 *   <nonce, 32 lowercase hex>
 *   <lowercase hex SHA-256 of the raw body bytes>
 *
 * The API checks, in order: headers well-formed, host known and allowed,
 * timestamp within 300 s, signature, then that the nonce is new (single use).
 * The nonce store lives in the API; this module does the pure parts.
 *
 * Nothing here logs.
 */

import { Buffer } from "node:buffer";
import {
  createHash,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export const AGENT_CANONICAL_PREFIX = "SQCA1";
export const AGENT_CLOCK_SKEW_SECONDS = 300;
/** Nonces are held for twice the skew window so a replay is always caught. */
export const AGENT_NONCE_TTL_SECONDS = 600;

export const AGENT_HEADERS = Object.freeze({
  hostId: "x-sq-host-id",
  timestamp: "x-sq-host-timestamp",
  nonce: "x-sq-host-nonce",
  signature: "x-sq-host-signature",
} as const);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

export type BodyInput = string | Uint8Array;

export function sha256Hex(data: BodyInput): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return createHash("sha256").update(bytes).digest("hex");
}

export function agentCanonicalString(input: {
  hostId: string;
  method: string;
  path: string;
  timestamp: string | number;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    AGENT_CANONICAL_PREFIX,
    input.hostId,
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    input.bodySha256,
  ].join("\n");
}

export interface SignAgentRequestInput {
  hostId: string;
  privateKey: KeyObject;
  method: string;
  path: string;
  body?: BodyInput;
  now?: Date;
  nonce?: string;
}

/** Sign an agent request and return the four headers to send. */
export function signAgentRequest(input: SignAgentRequestInput): Record<string, string> {
  if (/[\r\n]/.test(input.path) || !input.path.startsWith("/")) {
    throw new Error("Agent request path must start with / and contain no line breaks");
  }
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const canonical = agentCanonicalString({
    hostId: input.hostId,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodySha256: sha256Hex(input.body ?? ""),
  });
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), input.privateKey).toString(
    "base64url",
  );
  return {
    [AGENT_HEADERS.hostId]: input.hostId,
    [AGENT_HEADERS.timestamp]: String(timestamp),
    [AGENT_HEADERS.nonce]: nonce,
    [AGENT_HEADERS.signature]: signature,
  };
}

export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

function singleHeader(headers: HeaderBag, name: string): string | null {
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (found !== null || typeof value !== "string") return null;
    found = value;
  }
  return found;
}

export interface ParsedAgentHeaders {
  hostId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/** Read and shape-check the four headers. Returns null when any is missing or malformed. */
export function parseAgentHeaders(headers: HeaderBag): ParsedAgentHeaders | null {
  const hostId = singleHeader(headers, AGENT_HEADERS.hostId);
  const timestamp = singleHeader(headers, AGENT_HEADERS.timestamp);
  const nonce = singleHeader(headers, AGENT_HEADERS.nonce);
  const signature = singleHeader(headers, AGENT_HEADERS.signature);
  if (
    hostId === null ||
    timestamp === null ||
    nonce === null ||
    signature === null ||
    !UUID_RE.test(hostId) ||
    !TIMESTAMP_RE.test(timestamp) ||
    !NONCE_RE.test(nonce) ||
    !SIGNATURE_RE.test(signature)
  ) {
    return null;
  }
  return { hostId, timestamp, nonce, signature };
}

/** True when `|now − timestamp| ≤ 300 s`. */
export function agentTimestampFresh(timestamp: string, now: Date): boolean {
  const skew = Math.abs(now.getTime() / 1000 - Number(timestamp));
  return skew <= AGENT_CLOCK_SKEW_SECONDS;
}

/** Check the signature over the canonical string built from the raw body bytes. */
export function verifyAgentSignature(input: {
  headers: ParsedAgentHeaders;
  method: string;
  path: string;
  rawBody: BodyInput | undefined;
  publicKey: KeyObject;
}): boolean {
  const canonical = agentCanonicalString({
    hostId: input.headers.hostId,
    method: input.method,
    path: input.path,
    timestamp: input.headers.timestamp,
    nonce: input.headers.nonce,
    bodySha256: sha256Hex(input.rawBody ?? ""),
  });
  try {
    const signature = Buffer.from(input.headers.signature, "base64url");
    return (
      signature.length === 64 &&
      cryptoVerify(null, Buffer.from(canonical, "utf8"), input.publicKey, signature)
    );
  } catch {
    return false;
  }
}
