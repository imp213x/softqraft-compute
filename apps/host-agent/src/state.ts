/**
 * The agent's state directory (`/var/lib/softqraft-compute-agent`, mode
 * 0700): the host's Ed25519 private key (`host-key.pem`, mode 0600) and the
 * enrolment record (`enrolment.json`, mode 0600: host id, API URL and the
 * job signing public keys received at enrolment).
 *
 * The agent refuses to start when the directory or the key can be read by
 * anyone else.
 */

import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadPublicKey, loadSigningKey } from "@softqraft/compute-jobs";

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export const HOST_KEY_FILE = "host-key.pem";
export const ENROLMENT_FILE = "enrolment.json";

const Enrolment = z
  .object({
    hostId: z.string().uuid(),
    hostName: z.string(),
    apiUrl: z.string(),
    jobSigningKeys: z.record(z.string()),
    enrolledAt: z.string(),
  })
  .strict();
export type Enrolment = z.infer<typeof Enrolment>;

function assertPrivate(file: string, what: string): void {
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new StateError(`${what} ${file} must not be readable by group or others (mode ${mode.toString(8)}); chmod it to ${what === "State directory" ? "700" : "600"}`);
  }
}

export class AgentState {
  constructor(readonly dir: string) {}

  /** Create the directory (0700) if needed and check it is private. */
  prepare(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new StateError(`Cannot create the state directory ${this.dir}`);
    }
    assertPrivate(this.dir, "State directory");
  }

  /** The host key, created on first use with mode 0600. */
  hostKey(): { privateKey: KeyObject; publicKeyPem: string } {
    const file = path.join(this.dir, HOST_KEY_FILE);
    let pem: string;
    try {
      pem = readFileSync(file, "utf8");
      assertPrivate(file, "Host key");
    } catch (err) {
      if (err instanceof StateError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new StateError(`Cannot read the host key ${file}`);
      const { privateKey } = generateKeyPairSync("ed25519");
      pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      // `wx`: never overwrite a key another process just wrote.
      writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
    }
    const privateKey = loadSigningKey(pem, "The host key");
    const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    return { privateKey, publicKeyPem };
  }

  enrolment(): Enrolment | null {
    const file = path.join(this.dir, ENROLMENT_FILE);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    assertPrivate(file, "Enrolment record");
    const parsed = Enrolment.safeParse(JSON.parse(text));
    if (!parsed.success) throw new StateError(`The enrolment record ${file} is damaged`);
    return parsed.data;
  }

  saveEnrolment(enrolment: Enrolment): void {
    const file = path.join(this.dir, ENROLMENT_FILE);
    writeFileSync(file, `${JSON.stringify(enrolment, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }

  /** The job signing keys as a key ring for verifyJob. */
  static jobKeyRing(enrolment: Enrolment): Map<string, KeyObject> {
    return new Map(Object.entries(enrolment.jobSigningKeys).map(([id, pem]) => [id, loadPublicKey(pem, "A job signing key")] as const));
  }
}
