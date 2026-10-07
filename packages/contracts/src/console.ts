/**
 * Console-only shapes: size presets and saved SSH keys.
 *
 * Size presets are what the Create screen offers. They come from the pilot
 * caps: a preset the pool could never hold is not offered.
 *
 * Saved SSH keys belong to a service instance, so the Create screen can
 * remember the key after its first use. Only public keys are stored, and
 * only ed25519 keys and RSA keys of at least 3072 bits are accepted.
 */

import { z } from "zod";
import { DiskGb, IsoDateTime, MemoryMb, Uuid, Vcpu } from "./instance.js";

export const SIZE_PRESET_IDS = Object.freeze(["small", "medium", "large"] as const);
export const SizePresetId = z.enum(SIZE_PRESET_IDS);
export type SizePresetId = z.infer<typeof SizePresetId>;

/** The presets, before the pilot caps filter them. Disk is the deployment's default disk. */
export const SIZE_PRESETS: ReadonlyArray<{ id: SizePresetId; name: string; vcpu: number; memoryMb: number }> =
  Object.freeze([
    Object.freeze({ id: "small" as const, name: "Small", vcpu: 1, memoryMb: 1024 }),
    Object.freeze({ id: "medium" as const, name: "Medium", vcpu: 2, memoryMb: 2048 }),
    Object.freeze({ id: "large" as const, name: "Large", vcpu: 2, memoryMb: 4096 }),
  ]);

export const SizePreset = z.object({
  id: SizePresetId,
  name: z.string().min(1).max(40),
  vcpu: Vcpu,
  memoryMb: MemoryMb,
  diskGb: DiskGb,
});
export type SizePreset = z.infer<typeof SizePreset>;

export const SizesResponse = z.object({
  sizes: z.array(SizePreset),
  /** The preset the Create screen selects first. */
  defaultSizeId: SizePresetId.nullable(),
});
export type SizesResponse = z.infer<typeof SizesResponse>;

export const SSH_KEY_TYPES = Object.freeze(["ssh-ed25519", "ssh-rsa"] as const);
export const SshKeyType = z.enum(SSH_KEY_TYPES);
export type SshKeyType = z.infer<typeof SshKeyType>;

/** The smallest RSA modulus accepted, in bits. */
export const MIN_RSA_BITS = 3072;
/** How many keys one service instance may save. */
export const MAX_SAVED_SSH_KEYS = 20;

/** A label for a saved key: printable, no control characters. */
export const SshKeyName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\x20-\x7e]+$/, "name must be printable ASCII");

export const CreateSshKeyRequest = z
  .object({
    /** One OpenSSH public key line: type, base64 key, optional comment. */
    publicKey: z.string().trim().min(1).max(8192),
    /** Defaults to the key's comment, or its type. */
    name: SshKeyName.optional(),
  })
  .strict();
export type CreateSshKeyRequest = z.infer<typeof CreateSshKeyRequest>;

export const SshKey = z.object({
  id: Uuid,
  name: SshKeyName,
  type: SshKeyType,
  bits: z.number().int().positive(),
  /** `SHA256:` and the unpadded base64 of the key blob's SHA-256, as `ssh-keygen -l` prints it. */
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  /** The normalised key line: type and base64 key, without a comment. */
  publicKey: z.string(),
  createdAt: IsoDateTime,
});
export type SshKey = z.infer<typeof SshKey>;
