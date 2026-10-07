/**
 * The ComputeStore interface. Modules receive a `StoreTx` and never see
 * which store backs it. Every operation runs inside `transaction()`.
 *
 * Atomicity rule: any transaction that reserves pool capacity (create,
 * resize, snapshot) calls `lockPool()` first. That serialises capacity
 * decisions, so two concurrent requests can never both fit under the caps.
 */

import type {
  ConsoleRole,
  HostCapacity,
  HostState,
  InstanceSpec,
  InstanceState,
  JobState,
  JobType,
  OperatorRole,
  PowerState,
  SnapshotState,
} from "@softqraft/compute-contracts";

export interface InstanceRow {
  id: string;
  serviceInstanceId: string;
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
  /** What a succeeded job returned (a console ticket), until it is handed over. */
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SnapshotRow {
  id: string;
  instanceId: string;
  name: string;
  state: SnapshotState;
  /** Disk held against the pool cap: the instance's disk when it was taken. */
  sizeGb: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A Cloud service instance (cloud-federation-v1 §3.1). */
export interface ServiceInstanceRow {
  id: string;
  cloudOrganisationId: string;
  cloudProjectId: string;
  displayName: string;
  regionId: string;
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}

/** A Cloud principal (§3.2). Display data only. */
export interface PrincipalRow {
  subject: string;
  displayName: string;
  email: string;
  revokedAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A one-time Console launch grant (§3.2), stored as its SHA-256. */
export interface ConsoleGrantRow {
  grantHash: string;
  serviceInstanceId: string;
  subject: string;
  role: ConsoleRole;
  returnPath: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/** A Console session (§4, §5), stored by the SHA-256 of its token. */
export interface ConsoleSessionRow {
  id: string;
  tokenHash: string;
  subject: string;
  serviceInstanceId: string;
  role: ConsoleRole;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
}

/** A one-time operator launch grant (§8.2), in its own store. */
export interface OperatorGrantRow {
  grantHash: string;
  subject: string;
  role: OperatorRole;
  returnPath: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/** An operator session (§8.3, §8.4), stored by the SHA-256 of its token. */
export interface OperatorSessionRow {
  id: string;
  tokenHash: string;
  subject: string;
  role: OperatorRole;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
}

/** A security event. `detail` holds ids and names only, never a secret. */
export interface SecurityEventRow {
  id: string;
  action: string;
  subject: string | null;
  serviceInstanceId: string | null;
  sessionId: string | null;
  role: string | null;
  detail: Record<string, string> | null;
  createdAt: Date;
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
  serviceInstanceId: string;
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
  serviceInstanceId: string;
  sampledAt: Date;
  intervalSeconds: number;
  powerState: PowerState;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
}

/** Usage for one service instance in one UTC hour, kept as exact integer seconds. */
export interface UsageRecordRow {
  serviceInstanceId: string;
  hourStart: Date;
  vcpuSeconds: number;
  memoryMbSeconds: number;
  diskGbSeconds: number;
}

export type NonceScope = "cloud" | `host:${string}`;

export interface StoreTx {
  // Pool capacity (quotas)
  /**
   * Lock the pilot pool for the rest of the transaction and return what
   * live instances and live (not deleted) snapshots hold.
   */
  lockPool(): Promise<PoolUsage>;

  // Service instances (§3.1)
  /** Insert a service instance. False when one with this id already exists. */
  insertServiceInstance(row: ServiceInstanceRow): Promise<boolean>;
  getServiceInstance(id: string): Promise<ServiceInstanceRow | null>;

  // Idempotency
  getIdempotency(serviceInstanceId: string, key: string): Promise<IdempotencyRow | null>;
  putIdempotency(row: IdempotencyRow, now: Date): Promise<void>;

  // Instances
  insertInstance(row: InstanceRow): Promise<void>;
  getInstance(id: string): Promise<InstanceRow | null>;
  /** Instances of a service instance, oldest first. `deleted` ones only when asked. */
  listInstances(serviceInstanceId: string, options?: { includeDeleted?: boolean }): Promise<InstanceRow[]>;
  /** Every instance of every service instance, oldest first (staff support). */
  listAllInstances(options?: { includeDeleted?: boolean }): Promise<InstanceRow[]>;
  /** Live (not deleted) instances placed on a host, oldest first. */
  listLiveInstancesOnHost(hostId: string): Promise<InstanceRow[]>;
  /** Every `pending` instance, oldest first. */
  listPendingInstances(): Promise<InstanceRow[]>;
  /** A live (not deleted) instance with this name in this service instance. */
  findLiveInstanceByName(serviceInstanceId: string, name: string): Promise<InstanceRow | null>;
  /**
   * Write an instance (state, spec, placement) only if its state is still
   * `expectedState`. Returns false when another writer changed it first.
   */
  updateInstance(row: InstanceRow, expectedState: InstanceState): Promise<boolean>;

  // Snapshots
  insertSnapshot(row: SnapshotRow): Promise<void>;
  getSnapshot(id: string): Promise<SnapshotRow | null>;
  /** Snapshots of an instance, oldest first. `deleted` ones only when asked. */
  listSnapshots(instanceId: string, options?: { includeDeleted?: boolean }): Promise<SnapshotRow[]>;
  findLiveSnapshotByName(instanceId: string, name: string): Promise<SnapshotRow | null>;
  /** Write a snapshot only if its state is still `expectedState`. */
  updateSnapshot(row: SnapshotRow, expectedState: SnapshotState): Promise<boolean>;
  /** Mark every live snapshot of an instance deleted (the VM went with them). */
  markSnapshotsDeleted(instanceId: string, now: Date): Promise<number>;

  // Principals, grants and sessions (§3.2, §3.3, §4, §8). Hashes only.
  upsertPrincipal(row: Pick<PrincipalRow, "subject" | "displayName" | "email">, now: Date): Promise<void>;
  getPrincipal(subject: string): Promise<PrincipalRow | null>;
  /**
   * §3.3: set `revoked_after = now` for a known subject and delete its
   * Console and operator sessions. Returns how many unexpired sessions
   * ended; 0 for an unknown subject (nothing is created).
   */
  revokePrincipal(subject: string, now: Date): Promise<number>;
  insertConsoleGrant(row: ConsoleGrantRow): Promise<void>;
  /** Mark a Console grant used if it is unused and unexpired. Returns it, or null. */
  redeemConsoleGrant(grantHash: string, now: Date): Promise<ConsoleGrantRow | null>;
  insertConsoleSession(row: ConsoleSessionRow): Promise<void>;
  getConsoleSession(tokenHash: string): Promise<ConsoleSessionRow | null>;
  touchConsoleSession(id: string, now: Date): Promise<void>;
  deleteConsoleSession(tokenHash: string): Promise<void>;
  insertOperatorGrant(row: OperatorGrantRow): Promise<void>;
  /** Mark an operator grant used if it is unused and unexpired. Returns it, or null. */
  redeemOperatorGrant(grantHash: string, now: Date): Promise<OperatorGrantRow | null>;
  insertOperatorSession(row: OperatorSessionRow): Promise<void>;
  getOperatorSession(tokenHash: string): Promise<OperatorSessionRow | null>;
  touchOperatorSession(id: string, now: Date): Promise<void>;
  deleteOperatorSession(tokenHash: string): Promise<void>;
  /** Remove expired grants and sessions. */
  pruneFederation(now: Date): Promise<number>;
  insertSecurityEvent(row: SecurityEventRow): Promise<void>;
  listSecurityEvents(): Promise<SecurityEventRow[]>;

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
   * lease until `leaseUntil`. With `types`, only jobs of those types.
   * Returns null when none is queued.
   */
  leaseNextJob(hostId: string, now: Date, leaseUntil: Date, types?: readonly JobType[]): Promise<JobRow | null>;
  /** Leased jobs whose lease ended at or before `now`. */
  listExpiredLeases(now: Date): Promise<JobRow[]>;
  listJobsForInstance(instanceId: string): Promise<JobRow[]>;
  /** Clear results of succeeded jobs last updated before `before`. */
  clearJobResults(before: Date): Promise<number>;

  // Replay protection
  /** Claim a nonce until `expiresAt`. False if it is still held (a replay). */
  claimNonce(scope: NonceScope, nonce: string, expiresAt: Date, now: Date): Promise<boolean>;
  pruneNonces(now: Date): Promise<number>;

  // Usage
  /** Insert a sample. False when one already exists for (instanceId, sampledAt). */
  insertUsageSample(row: UsageSampleRow): Promise<boolean>;
  addUsage(row: UsageRecordRow): Promise<void>;
  listUsageRecords(serviceInstanceId: string, from: Date, to: Date): Promise<UsageRecordRow[]>;
}

export interface ComputeStore {
  readonly kind: string;
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  /** Throws when the backing database cannot answer. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
