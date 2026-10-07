/**
 * Signed job envelopes (API → host agent).
 *
 * The API signs the canonical JSON of the envelope with its Ed25519 job
 * signing key. The agent verifies before it runs anything: signature first,
 * then that the job is addressed to this host, then that it has not expired.
 * A tampered envelope fails the signature check.
 *
 * Nothing here logs. Callers must never log envelopes, signatures or keys.
 */

import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { JobEnvelope, SignedJob } from "@softqraft/compute-contracts";
import { canonicalJson } from "./canonical-json.js";

export type { JobEnvelope, SignedJob };

/** Bytes that are signed: the canonical JSON of the envelope, as UTF-8. */
export function envelopeSigningBytes(envelope: JobEnvelope): Buffer {
  return Buffer.from(canonicalJson(envelope), "utf8");
}

/** Load an Ed25519 private key from PKCS#8 PEM. Errors never include key material. */
export function loadSigningKey(pem: string, label = "COMPUTE_JOB_SIGNING_KEY_PEM"): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new Error(`${label} is not a valid private key PEM`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must be an Ed25519 private key`);
  }
  return key;
}

/** Load an Ed25519 public key from SPKI PEM. Errors never include key material. */
export function loadPublicKey(pem: string, label = "public key"): KeyObject {
  if (pem.includes("PRIVATE KEY")) throw new Error(`${label} must be a public key`);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: "pem" });
  } catch {
    throw new Error(`${label} is not a valid public key PEM`);
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must be an Ed25519 public key`);
  }
  return key;
}

/** SPKI PEM of the public half of a key, for publishing to agents. */
export function publicKeyPem(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return pub.export({ type: "spki", format: "pem" }).toString();
}

export function signJob(envelope: JobEnvelope, privateKey: KeyObject, keyId: string): SignedJob {
  const parsed = JobEnvelope.parse(envelope);
  const signature = cryptoSign(null, envelopeSigningBytes(parsed), privateKey).toString(
    "base64url",
  );
  return { envelope: parsed, keyId, signature };
}

export type VerifyJobFailure = "malformed" | "unknown_key" | "signature" | "wrong_host" | "expired" | "not_yet_valid";

export type VerifyJobResult =
  | { ok: true; envelope: JobEnvelope }
  | { ok: false; reason: VerifyJobFailure };

/** Resolves a job signing key id to a public key. A Map satisfies it. */
export interface JobKeyRing {
  get(keyId: string): KeyObject | undefined;
}

export interface VerifyJobOptions {
  keys: JobKeyRing;
  /** The host this agent runs as. A job for any other host is refused. */
  hostId: string;
  now?: Date;
  /** Tolerated clock difference for `issuedAt`, in seconds. Default 60. */
  clockSkewSeconds?: number;
}

/**
 * Verify a signed job, in this order (the first failure decides):
 * malformed → unknown_key → signature → wrong_host → not_yet_valid → expired.
 */
export function verifyJob(input: unknown, options: VerifyJobOptions): VerifyJobResult {
  const parsed = SignedJob.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const signed = parsed.data;

  const key = options.keys.get(signed.keyId);
  if (!key) return { ok: false, reason: "unknown_key" };

  let valid = false;
  try {
    const signature = Buffer.from(signed.signature, "base64url");
    valid =
      signature.length === 64 &&
      cryptoVerify(null, envelopeSigningBytes(signed.envelope), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };

  if (signed.envelope.hostId !== options.hostId) return { ok: false, reason: "wrong_host" };

  const now = (options.now ?? new Date()).getTime();
  const skewMs = (options.clockSkewSeconds ?? 60) * 1000;
  const issuedAt = Date.parse(signed.envelope.issuedAt);
  const expiresAt = Date.parse(signed.envelope.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return { ok: false, reason: "malformed" };
  }
  if (issuedAt - skewMs > now) return { ok: false, reason: "not_yet_valid" };
  if (now >= expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, envelope: signed.envelope };
}
