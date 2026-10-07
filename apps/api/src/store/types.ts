/**
 * The ComputeStore interface. Modules receive a `StoreTx` and never see
 * which store backs it. Every operation runs inside `transaction()`.
 *
 * Atomicity rule: any transaction that reserves pool capacity calls
 * `lockPool()` first. That serialises capacity decisions, so two concurrent
 * creates can never both fit under the caps.
 */

import type {
  HostCapacity,
  HostState,
  InstanceSpec,
  InstanceState,
  JobState,
  JobType,
  PowerState,
} from "@softqraft/compute-contracts";

export interface InstanceRow {
  id: string;
  projectId: string;
  spec: InstanceSpec;
  state: InstanceState;
  pendingReason: string | null;
  hostId: string | null;
  privateIp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface HostRow {
  id: string;
  name: string;
  state: HostState;
  driver: string;
  capacity: HostCapacity;
  publicKeyPem: string;
  enrolledAt: Date;
  lastSeenAt: Date | null;
}

export interface JobRow {
  id: string;
  hostId: string;
  instanceId: string;
  type: JobType;
  payload: Record<string, unknown>;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Resources {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
}

export interface PoolUsage extends Resources {
  instances: number;
}

export interface IdempotencyRow {
  projectId: string;
  key: string;
  requestHash: string;
  instanceId: string;
}

export interface EnrolmentTokenRow {
  tokenHash: string;
  hostName: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface UsageSampleRow {
  instanceId: string;
  hostId: string;
  projectId: string;
  sampledAt: Date;
  intervalSeconds: number;
  powerState: PowerState;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
}

/** Usage for one project in one UTC hour, kept as exact integer seconds. */
export interface UsageRecordRow {
  projectId: string;
  hourStart: Date;
  vcpuSeconds: number;
  memoryMbSeconds: number;
  diskGbSeconds: number;
}

export type NonceScope = "cloud" | `host:${string}`;

export interface StoreTx {
  // Pool capacity (quotas)
  /** Lock the pilot pool for the rest of the transaction and return what live instances use. */
  lockPool(): Promise<PoolUsage>;

  // Idempotency
  getIdempotency(projectId: string, key: string): Promise<IdempotencyRow | null>;
  putIdempotency(row: IdempotencyRow, now: Date): Promise<void>;

  // Instances
  insertInstance(row: InstanceRow): Promise<void>;
  getInstance(id: string): Promise<InstanceRow | null>;
  /** Instances of a project, oldest first. `deleted` ones only when asked. */
  listInstances(projectId: string, options?: { includeDeleted?: boolean }): Promise<InstanceRow[]>;
  /** Every `pending` instance, oldest first. */
  listPendingInstances(): Promise<InstanceRow[]>;
  /** A live (not deleted) instance with this name in this project. */
  findLiveInstanceByName(projectId: string, name: string): Promise<InstanceRow | null>;
  /**
   * Write an instance only if its state is still `expectedState`.
   * Returns false when another writer changed it first.
   */
  updateInstance(row: InstanceRow, expectedState: InstanceState): Promise<boolean>;

  // Hosts
  insertHost(row: HostRow): Promise<void>;
  getHost(id: string): Promise<HostRow | null>;
  getHostByName(name: string): Promise<HostRow | null>;
  listHosts(): Promise<HostRow[]>;
  updateHost(row: HostRow): Promise<void>;
  /** Resources held by live instances placed on a host. */
  hostAllocated(hostId: string): Promise<Resources>;

  // Enrolment tokens (stored only as SHA-256 hashes)
  insertEnrolmentToken(row: EnrolmentTokenRow): Promise<void>;
  /** Mark a token used if it is unused and unexpired. Returns it, or null. */
  consumeEnrolmentToken(tokenHash: string, now: Date): Promise<EnrolmentTokenRow | null>;

  // IPAM
  /** Addresses currently held (by instances that are not deleted). */
  listHeldAddresses(): Promise<string[]>;
  /** Hold an address for an instance. Throws if it is already held. */
  holdAddress(address: string, instanceId: string, now: Date): Promise<void>;
  /** Release the address an instance holds, if any. */
  releaseAddress(instanceId: string, now: Date): Promise<void>;

  // Jobs
  insertJob(row: JobRow): Promise<void>;
  getJob(id: string): Promise<JobRow | null>;
  updateJob(row: JobRow): Promise<void>;
  /**
   * Lease the oldest queued job for a host: state `leased`, attempt + 1,
   * lease until `leaseUntil`. Returns null when none is queued.
   */
  leaseNextJob(hostId: string, now: Date, leaseUntil: Date): Promise<JobRow | null>;
  /** Leased jobs whose lease ended at or before `now`. */
  listExpiredLeases(now: Date): Promise<JobRow[]>;
  listJobsForInstance(instanceId: string): Promise<JobRow[]>;

  // Replay protection
  /** Claim a nonce until `expiresAt`. False if it is still held (a replay). */
  claimNonce(scope: NonceScope, nonce: string, expiresAt: Date, now: Date): Promise<boolean>;
  pruneNonces(now: Date): Promise<number>;

  // Usage
  /** Insert a sample. False when one already exists for (instanceId, sampledAt). */
  insertUsageSample(row: UsageSampleRow): Promise<boolean>;
  addUsage(row: UsageRecordRow): Promise<void>;
  listUsageRecords(projectId: string, from: Date, to: Date): Promise<UsageRecordRow[]>;
}

export interface ComputeStore {
  readonly kind: string;
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  /** Throws when the backing database cannot answer. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
