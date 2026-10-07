/**
 * Instances: the spec a caller asks for, the record the API keeps, and the
 * lifecycle states. Pilot limits (C1, decision D5) are enforced here so the
 * API, the host agent and Cloud reject the same inputs.
 *
 * Instances belong to a Cloud service instance (cloud-federation-v1 §3.1),
 * not to a raw Cloud project id. The service instance records its project.
 */

import { z } from "zod";

/** Pilot limits for a single instance. Pool-wide caps are separate (quotas). */
export const INSTANCE_LIMITS = Object.freeze({
  vcpu: { min: 1, max: 4 },
  memoryMb: { min: 512, max: 8192, step: 512 },
  diskGb: { min: 10, max: 120 },
  sshPublicKeys: { max: 10, maxLength: 8192 },
  name: { maxLength: 63 },
});

/** Default disk when a create request leaves `diskGb` out (decision 2026-10-07: 16 GB). */
export const DEFAULT_DISK_GB = 16;

/**
 * A name that is safe as a VM label and a DNS label: lowercase letters,
 * digits and hyphens, starting with a letter, not ending with a hyphen,
 * 1 to 63 characters.
 */
export const INSTANCE_NAME_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** OpenSSH public key line: type, base64 key, optional comment. */
export const SSH_PUBLIC_KEY_RE =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [\x20-\x7e]{1,200})?$/;

export const IMAGE_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const InstanceName = z
  .string()
  .max(INSTANCE_LIMITS.name.maxLength)
  .regex(INSTANCE_NAME_RE, "name must be a lowercase DNS label (a-z, 0-9, -)");

export const SshPublicKey = z
  .string()
  .max(INSTANCE_LIMITS.sshPublicKeys.maxLength)
  .regex(SSH_PUBLIC_KEY_RE, "sshPublicKeys entries must be OpenSSH public keys");

export const ImageId = z.string().regex(IMAGE_ID_RE, "imageId is not valid");

export const Vcpu = z.number().int().min(INSTANCE_LIMITS.vcpu.min).max(INSTANCE_LIMITS.vcpu.max);
export const MemoryMb = z
  .number()
  .int()
  .min(INSTANCE_LIMITS.memoryMb.min)
  .max(INSTANCE_LIMITS.memoryMb.max)
  .multipleOf(INSTANCE_LIMITS.memoryMb.step);
export const DiskGb = z.number().int().min(INSTANCE_LIMITS.diskGb.min).max(INSTANCE_LIMITS.diskGb.max);

export const InstanceSpec = z
  .object({
    name: InstanceName,
    imageId: ImageId,
    vcpu: Vcpu,
    memoryMb: MemoryMb,
    diskGb: DiskGb,
    sshPublicKeys: z
      .array(SshPublicKey)
      .max(INSTANCE_LIMITS.sshPublicKeys.max)
      .default([]),
  })
  .strict();
export type InstanceSpec = z.infer<typeof InstanceSpec>;
/** The spec before defaults are applied. */
export type InstanceSpecInput = z.input<typeof InstanceSpec>;

/**
 * A create request: an InstanceSpec whose `diskGb` may be left out. The API
 * fills it from COMPUTE_DEFAULT_DISK_GB (16 by default) before validating.
 */
export const CreateInstanceRequest = InstanceSpec.extend({ diskGb: DiskGb.optional() }).strict();
export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequest>;

export const INSTANCE_STATES = Object.freeze([
  "pending",
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "starting",
  "resizing",
  "deleting",
  "deleted",
  "error",
] as const);
export const InstanceState = z.enum(INSTANCE_STATES);
export type InstanceState = z.infer<typeof InstanceState>;

export const Uuid = z.string().uuid();
/** A Cloud project id (UUID). Recorded on the service instance. */
export const ProjectId = Uuid;
export const IsoDateTime = z.string().datetime({ offset: true });

/** A Cloud service instance id (cloud-federation-v1 §3.1), as Realtime Media accepts it. */
export const SERVICE_INSTANCE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const ServiceInstanceId = z.string().regex(SERVICE_INSTANCE_ID_RE, "serviceInstanceId is not valid");

export const Instance = z.object({
  id: Uuid,
  serviceInstanceId: ServiceInstanceId,
  spec: InstanceSpec,
  state: InstanceState,
  /** Why an instance is still `pending` (for example no host has room). */
  pendingReason: z.string().nullable(),
  hostId: Uuid.nullable(),
  privateIp: z.string().ip({ version: "v4" }).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Instance = z.infer<typeof Instance>;

export const INSTANCE_ACTIONS = Object.freeze(["start", "stop", "resize"] as const);

/**
 * `start`, `stop`, or `resize` with at least one new size. Resize is allowed
 * only while the instance is stopped; vCPU and memory may go up or down, the
 * disk may only grow.
 */
export const InstanceAction = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("start") }).strict(),
    z.object({ action: z.literal("stop") }).strict(),
    z
      .object({
        action: z.literal("resize"),
        vcpu: Vcpu.optional(),
        memoryMb: MemoryMb.optional(),
        diskGb: DiskGb.optional(),
      })
      .strict(),
  ])
  .superRefine((a, ctx) => {
    if (a.action === "resize" && a.vcpu === undefined && a.memoryMb === undefined && a.diskGb === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "resize needs vcpu, memoryMb or diskGb" });
    }
  });
export type InstanceAction = z.infer<typeof InstanceAction>;
export type InstanceSize = Pick<InstanceSpec, "vcpu" | "memoryMb" | "diskGb">;

/** `Idempotency-Key` header: 8 to 128 characters of A-Z a-z 0-9 _ -. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
