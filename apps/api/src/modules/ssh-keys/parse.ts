/**
 * OpenSSH public key parsing for saved keys. Accepts one line,
 * `<type> <base64 blob> [comment]`, of type `ssh-ed25519` or `ssh-rsa`, and
 * checks the blob itself: its embedded type matches, an ed25519 key is
 * 32 bytes, and an RSA modulus has at least MIN_RSA_BITS bits. Nothing is
 * logged; a key is public, but a pasted private key never is.
 */

import { createHash } from "node:crypto";
import { MIN_RSA_BITS, type SshKeyType } from "@softqraft/compute-contracts";

export interface ParsedSshKey {
  type: SshKeyType;
  bits: number;
  /** `SHA256:` and the unpadded base64 SHA-256 of the blob, as `ssh-keygen -l` prints it. */
  fingerprint: string;
  /** `<type> <base64>`, without the comment. */
  publicKey: string;
  comment: string | null;
}

export type SshKeyProblem = "private" | "malformed" | "unsupported" | "too_weak";

export class SshKeyError extends Error {
  constructor(readonly problem: SshKeyProblem) {
    super(`ssh key ${problem}`);
    this.name = "SshKeyError";
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Reads SSH wire-format strings (uint32 length, then bytes). */
class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  string(): Buffer {
    if (this.offset + 4 > this.buf.length) throw new SshKeyError("malformed");
    const len = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    if (len > this.buf.length - this.offset) throw new SshKeyError("malformed");
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }
  get done(): boolean {
    return this.offset === this.buf.length;
  }
}

/** Bit length of an unsigned big-endian integer (SSH mpint, leading zero allowed). */
function bitLength(bytes: Buffer): number {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i += 1;
  if (i === bytes.length) return 0;
  return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i]!));
}

export function parseSshPublicKey(input: string): ParsedSshKey {
  const line = input.trim();
  if (/PRIVATE KEY/.test(line)) throw new SshKeyError("private");
  if (/[\r\n]/.test(line)) throw new SshKeyError("malformed");
  const parts = line.split(/\s+/);
  if (parts.length < 2) throw new SshKeyError("malformed");
  const [type, b64, ...rest] = parts as [string, string, ...string[]];
  if (type !== "ssh-ed25519" && type !== "ssh-rsa") {
    throw new SshKeyError(/^(ssh-|ecdsa-|sk-)/.test(type) ? "unsupported" : "malformed");
  }
  if (!BASE64_RE.test(b64) || b64.length % 4 !== 0) throw new SshKeyError("malformed");
  const blob = Buffer.from(b64, "base64");
  const reader = new Reader(blob);
  if (reader.string().toString("latin1") !== type) throw new SshKeyError("malformed");
  let bits: number;
  if (type === "ssh-ed25519") {
    if (reader.string().length !== 32) throw new SshKeyError("malformed");
    bits = 256;
  } else {
    const e = reader.string();
    const n = reader.string();
    if (bitLength(e) === 0) throw new SshKeyError("malformed");
    bits = bitLength(n);
    if (bits < MIN_RSA_BITS) throw new SshKeyError("too_weak");
  }
  if (!reader.done) throw new SshKeyError("malformed");
  const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  const comment = rest.join(" ").trim();
  return {
    type,
    bits,
    fingerprint,
    publicKey: `${type} ${blob.toString("base64")}`,
    comment: comment && /^[\x20-\x7e]{1,60}$/.test(comment) ? comment : null,
  };
}
