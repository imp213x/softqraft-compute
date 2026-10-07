/**
 * Images, hosts, jobs, snapshots, console tickets and usage.
 */

import { z } from "zod";
import { DiskGb, ImageId, InstanceSpec, IsoDateTime, MemoryMb, ServiceInstanceId, Uuid, Vcpu } from "./instance.js";

export const Image = z.object({
  id: ImageId,
  name: z.string().min(1).max(120),
  osFamily: z.enum(["linux"]),
  distribution: z.string().min(1).max(40),
  version: z.string().min(1).max(40),
  /** Smallest disk an instance from this image may have. */
  minDiskGb: z.number().int().positive(),
  status: z.enum(["available", "deprecated"]),
});
export type Image = z.infer<typeof Image>;

export const HOST_STATES = Object.freeze(["enrolled", "active", "draining", "disabled"] as const);
export const HostState = z.enum(HOST_STATES);
export type HostState = z.infer<typeof HostState>;

export const HostCapacity = z
  .object({
    vcpu: z.number().int().min(1).max(1024),
    memoryMb: z.number().int().min(512).max(16 * 1024 * 1024),
    diskGb: z.number().int().min(1).max(1024 * 1024),
  })
  .strict();
export type HostCapacity = z.infer<typeof HostCapacity>;

/** Host name: a lowercase DNS label, like instance names. */
export const HostName = z
  .string()
  .max(63)
  .regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "host name must be a lowercase DNS label");

/** Driver names are lowercase identifiers, for example `fake` or `proxmox`. */
export const DriverName = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

/** An Ed25519 SPKI public key in PEM form. Checked for type by the API. */
export const PublicKeyPem = z
  .string()
  .max(1024)
  .refine(
    (pem) => pem.includes("-----BEGIN PUBLIC KEY-----") && !pem.includes("PRIVATE KEY"),
    "publicKey must be an SPKI public key PEM",
  );

export const Host = z.object({
  id: Uuid,
  name: HostName,
  state: HostState,
  driver: DriverName,
  capacity: HostCapacity,
  publicKey: PublicKeyPem,
  enrolledAt: IsoDateTime,
  lastSeenAt: IsoDateTime.nullable(),
});
export type Host = z.infer<typeof Host>;

export const JOB_TYPES = Object.freeze([
  "create",
  "start",
  "stop",
  "delete",
  "snapshot",
  "snapshot_delete",
  "resize",
  "console",
] as const);
export const JobType = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobType>;

export const JOB_STATES = Object.freeze(["queued", "leased", "succeeded", "failed"] as const);
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;

/** What the host agent needs to build a VM. */
export const CreateJobPayload = z
  .object({
    spec: InstanceSpec,
    privateIp: z.string().ip({ version: "v4" }),
    network: z.object({ cidr: z.string(), gateway: z.string().ip({ version: "v4" }) }).strict(),
  })
  .strict();
export type CreateJobPayload = z.infer<typeof CreateJobPayload>;

/** Snapshot names: a lowercase label of 1 to 40 characters. */
export const SNAPSHOT_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const SnapshotName = z.string().regex(SNAPSHOT_NAME_RE, "name must be a lowercase label (a-z, 0-9, -), 1-40 characters");

/** `snapshot` (take one) and `snapshot_delete` (remove one) name the snapshot. */
export const SnapshotJobPayload = z.object({ snapshotName: SnapshotName }).strict();
export type SnapshotJobPayload = z.infer<typeof SnapshotJobPayload>;

/** start, stop, delete and console carry the instance name only. */
export const LifecycleJobPayload = z.object({ name: z.string() }).strict();
export type LifecycleJobPayload = z.infer<typeof LifecycleJobPayload>;

/** `resize`: the full new size. Runs only while the VM is stopped; the disk only grows. */
export const ResizeJobPayload = z
  .object({ name: z.string(), vcpu: Vcpu, memoryMb: MemoryMb, diskGb: DiskGb })
  .strict();
export type ResizeJobPayload = z.infer<typeof ResizeJobPayload>;

export type JobPayload = CreateJobPayload | SnapshotJobPayload | LifecycleJobPayload | ResizeJobPayload;

/** The payload schema for each job type. Agents parse with this before running a job. */
export const JOB_PAYLOADS = Object.freeze({
  create: CreateJobPayload,
  start: LifecycleJobPayload,
  stop: LifecycleJobPayload,
  delete: LifecycleJobPayload,
  snapshot: SnapshotJobPayload,
  snapshot_delete: SnapshotJobPayload,
  resize: ResizeJobPayload,
  console: LifecycleJobPayload,
} as const);

/**
 * A short-lived console ticket. The host agent asks its driver for one and
 * returns it as the result of a `console` job; the API hands it to the
 * browser once and never holds hypervisor credentials. The ticket is opaque.
 */
export const CONSOLE_TICKET_MAX_SECONDS = 300;
export const ConsoleTicket = z
  .object({
    protocol: z.enum(["vnc"]),
    ticket: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/, "ticket must be printable ASCII"),
    expiresAt: IsoDateTime,
  })
  .strict();
export type ConsoleTicket = z.infer<typeof ConsoleTicket>;

export const SNAPSHOT_STATES = Object.freeze(["creating", "available", "deleting", "deleted", "error"] as const);
export const SnapshotState = z.enum(SNAPSHOT_STATES);
export type SnapshotState = z.infer<typeof SnapshotState>;

/**
 * A snapshot of an instance. `sizeGb` is the disk it holds against the pool
 * cap: the instance's disk size when the snapshot was taken (a thin-pool
 * snapshot can grow to that size).
 */
export const Snapshot = z.object({
  id: Uuid,
  instanceId: Uuid,
  name: SnapshotName,
  state: SnapshotState,
  sizeGb: z.number().int().positive(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Snapshot = z.infer<typeof Snapshot>;

export const CreateSnapshotRequest = z.object({ name: SnapshotName }).strict();
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequest>;

export const Job = z.object({
  id: Uuid,
  hostId: Uuid,
  instanceId: Uuid,
  type: JobType,
  payload: z.record(z.unknown()),
  state: JobState,
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  leaseExpiresAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Job = z.infer<typeof Job>;

/** The signed part of a job (see `@softqraft/compute-jobs`). */
export const JobEnvelope = z
  .object({
    id: Uuid,
    hostId: Uuid,
    type: JobType,
    payload: z.record(z.unknown()),
    instanceId: Uuid,
    attempt: z.number().int().min(1),
    issuedAt: IsoDateTime,
    expiresAt: IsoDateTime,
  })
  .strict();
export type JobEnvelope = z.infer<typeof JobEnvelope>;

export const SignedJob = z
  .object({
    envelope: JobEnvelope,
    keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type SignedJob = z.infer<typeof SignedJob>;

export const POWER_STATES = Object.freeze(["running", "stopped"] as const);
export const PowerState = z.enum(POWER_STATES);
export type PowerState = z.infer<typeof PowerState>;

/** One observation the host agent sends for one instance. */
export const AgentUsageSample = z
  .object({
    instanceId: Uuid,
    sampledAt: IsoDateTime,
    /** Seconds this sample covers, ending at `sampledAt`. */
    intervalSeconds: z.number().int().min(1).max(3600),
    powerState: PowerState,
  })
  .strict();
export type AgentUsageSample = z.infer<typeof AgentUsageSample>;

export const AgentUsageReport = z
  .object({ samples: z.array(AgentUsageSample).min(1).max(500) })
  .strict();
export type AgentUsageReport = z.infer<typeof AgentUsageReport>;

/** A stored sample: the agent's observation plus the sizes the API allocated. */
export const UsageSample = AgentUsageSample.extend({
  hostId: Uuid,
  serviceInstanceId: ServiceInstanceId,
  vcpu: z.number().int(),
  memoryMb: z.number().int(),
  diskGb: z.number().int(),
});
export type UsageSample = z.infer<typeof UsageSample>;

/** Usage for one service instance in one UTC hour. Metered, not priced (decision D7). */
export const UsageRecord = z.object({
  serviceInstanceId: ServiceInstanceId,
  hourStart: IsoDateTime,
  vcpuHours: z.number().nonnegative(),
  memoryGbHours: z.number().nonnegative(),
  diskGbHours: z.number().nonnegative(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;
