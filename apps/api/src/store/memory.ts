/**
 * In-memory ComputeStore for unit tests and local runs without Postgres.
 *
 * Transactions run one at a time behind a mutex, so `lockPool()` is
 * trivially exclusive. A failed transaction restores the state it started
 * from. Rows are cloned on the way in and out so callers cannot mutate
 * stored state by accident.
 */

import type { JobType } from "@softqraft/compute-contracts";
import type {
  ComputeStore,
  ConsoleGrantRow,
  ConsoleSessionRow,
  EnrolmentTokenRow,
  HostRow,
  IdempotencyRow,
  InstanceRow,
  JobRow,
  NonceScope,
  OperatorGrantRow,
  OperatorSessionRow,
  PoolUsage,
  PrincipalRow,
  Resources,
  SecurityEventRow,
  ServiceInstanceRow,
  SnapshotRow,
  StoreTx,
  UsageRecordRow,
  UsageSampleRow,
} from "./types.js";

interface State {
  serviceInstances: Map<string, ServiceInstanceRow>;
  snapshots: Map<string, SnapshotRow>;
  principals: Map<string, PrincipalRow>;
  consoleGrants: Map<string, ConsoleGrantRow>;
  consoleSessions: Map<string, ConsoleSessionRow>;
  operatorGrants: Map<string, OperatorGrantRow>;
  operatorSessions: Map<string, OperatorSessionRow>;
  securityEvents: SecurityEventRow[];
  instances: Map<string, InstanceRow>;
  hosts: Map<string, HostRow>;
  jobs: Map<string, JobRow>;
  idempotency: Map<string, IdempotencyRow>;
  tokens: Map<string, EnrolmentTokenRow & { usedAt: Date | null }>;
  addresses: Map<string, { instanceId: string; heldAt: Date }>;
  nonces: Map<string, Date>;
  samples: Map<string, UsageSampleRow>;
  usage: Map<string, UsageRecordRow>;
}

function emptyState(): State {
  return {
    serviceInstances: new Map(),
    snapshots: new Map(),
    principals: new Map(),
    consoleGrants: new Map(),
    consoleSessions: new Map(),
    operatorGrants: new Map(),
    operatorSessions: new Map(),
    securityEvents: [],
    instances: new Map(),
    hosts: new Map(),
    jobs: new Map(),
    idempotency: new Map(),
    tokens: new Map(),
    addresses: new Map(),
    nonces: new Map(),
    samples: new Map(),
    usage: new Map(),
  };
}

const clone = <T>(value: T): T => structuredClone(value);

function live(row: { state: string }): boolean {
  return row.state !== "deleted";
}

const byCreated = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

class MemoryTx implements StoreTx {
  constructor(private readonly s: State) {}

  async lockPool(): Promise<PoolUsage> {
    const usage: PoolUsage = { vcpu: 0, memoryMb: 0, diskGb: 0, instances: 0 };
    for (const row of this.s.instances.values()) {
      if (!live(row)) continue;
      usage.vcpu += row.spec.vcpu;
      usage.memoryMb += row.spec.memoryMb;
      usage.diskGb += row.spec.diskGb;
      usage.instances += 1;
    }
    for (const snap of this.s.snapshots.values()) if (live(snap)) usage.diskGb += snap.sizeGb;
    return usage;
  }

  async insertServiceInstance(row: ServiceInstanceRow): Promise<void> {
    if (this.s.serviceInstances.has(row.id)) throw new Error("service instance exists");
    this.s.serviceInstances.set(row.id, clone(row));
  }

  async getServiceInstance(id: string): Promise<ServiceInstanceRow | null> {
    const row = this.s.serviceInstances.get(id);
    return row ? clone(row) : null;
  }

  async getIdempotency(serviceInstanceId: string, key: string): Promise<IdempotencyRow | null> {
    const row = this.s.idempotency.get(`${serviceInstanceId}\n${key}`);
    return row ? clone(row) : null;
  }

  async putIdempotency(row: IdempotencyRow): Promise<void> {
    const id = `${row.serviceInstanceId}\n${row.key}`;
    if (this.s.idempotency.has(id)) throw new Error("idempotency key exists");
    this.s.idempotency.set(id, clone(row));
  }

  async insertInstance(row: InstanceRow): Promise<void> {
    if (this.s.instances.has(row.id)) throw new Error("instance exists");
    this.s.instances.set(row.id, clone(row));
  }

  async getInstance(id: string): Promise<InstanceRow | null> {
    const row = this.s.instances.get(id);
    return row ? clone(row) : null;
  }

  async listInstances(serviceInstanceId: string, options: { includeDeleted?: boolean } = {}) {
    return [...this.s.instances.values()]
      .filter((r) => r.serviceInstanceId === serviceInstanceId && (options.includeDeleted || live(r)))
      .sort(byCreated)
      .map(clone);
  }

  async listAllInstances(options: { includeDeleted?: boolean } = {}) {
    return [...this.s.instances.values()]
      .filter((r) => options.includeDeleted || live(r))
      .sort(byCreated)
      .map(clone);
  }

  async listLiveInstancesOnHost(hostId: string) {
    return [...this.s.instances.values()]
      .filter((r) => r.hostId === hostId && live(r))
      .sort(byCreated)
      .map(clone);
  }

  async listPendingInstances(): Promise<InstanceRow[]> {
    return [...this.s.instances.values()]
      .filter((r) => r.state === "pending")
      .sort(byCreated)
      .map(clone);
  }

  async findLiveInstanceByName(serviceInstanceId: string, name: string) {
    for (const row of this.s.instances.values()) {
      if (row.serviceInstanceId === serviceInstanceId && row.spec.name === name && live(row)) return clone(row);
    }
    return null;
  }

  async updateInstance(row: InstanceRow, expectedState: InstanceRow["state"]): Promise<boolean> {
    const current = this.s.instances.get(row.id);
    if (!current || current.state !== expectedState) return false;
    this.s.instances.set(row.id, clone(row));
    return true;
  }

  async insertSnapshot(row: SnapshotRow): Promise<void> {
    if (this.s.snapshots.has(row.id)) throw new Error("snapshot exists");
    if (await this.findLiveSnapshotByName(row.instanceId, row.name)) throw new Error("snapshot name exists");
    this.s.snapshots.set(row.id, clone(row));
  }

  async getSnapshot(id: string) {
    const row = this.s.snapshots.get(id);
    return row ? clone(row) : null;
  }

  async listSnapshots(instanceId: string, options: { includeDeleted?: boolean } = {}) {
    return [...this.s.snapshots.values()]
      .filter((r) => r.instanceId === instanceId && (options.includeDeleted || live(r)))
      .sort(byCreated)
      .map(clone);
  }

  async findLiveSnapshotByName(instanceId: string, name: string) {
    for (const row of this.s.snapshots.values()) {
      if (row.instanceId === instanceId && row.name === name && live(row)) return clone(row);
    }
    return null;
  }

  async updateSnapshot(row: SnapshotRow, expectedState: SnapshotRow["state"]): Promise<boolean> {
    const current = this.s.snapshots.get(row.id);
    if (!current || current.state !== expectedState) return false;
    this.s.snapshots.set(row.id, clone(row));
    return true;
  }

  async markSnapshotsDeleted(instanceId: string, now: Date): Promise<number> {
    let n = 0;
    for (const row of this.s.snapshots.values()) {
      if (row.instanceId !== instanceId || !live(row)) continue;
      row.state = "deleted";
      row.updatedAt = new Date(now);
      n += 1;
    }
    return n;
  }

  async upsertPrincipal(row: Pick<PrincipalRow, "subject" | "displayName" | "email">, now: Date): Promise<void> {
    const current = this.s.principals.get(row.subject);
    if (current) {
      current.displayName = row.displayName;
      current.email = row.email;
      current.updatedAt = new Date(now);
      return;
    }
    this.s.principals.set(row.subject, {
      ...clone(row),
      revokedAfter: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  }

  async getPrincipal(subject: string) {
    const row = this.s.principals.get(subject);
    return row ? clone(row) : null;
  }

  async revokePrincipal(subject: string, now: Date): Promise<number> {
    const principal = this.s.principals.get(subject);
    if (!principal) return 0;
    principal.revokedAfter = new Date(now);
    principal.updatedAt = new Date(now);
    let ended = 0;
    for (const sessions of [this.s.consoleSessions, this.s.operatorSessions] as Array<
      Map<string, { subject: string; expiresAt: Date }>
    >) {
      for (const [hash, session] of sessions) {
        if (session.subject !== subject) continue;
        if (session.expiresAt.getTime() > now.getTime()) ended += 1;
        sessions.delete(hash);
      }
    }
    return ended;
  }

  async insertConsoleGrant(row: ConsoleGrantRow): Promise<void> {
    if (this.s.consoleGrants.has(row.grantHash)) throw new Error("grant exists");
    this.s.consoleGrants.set(row.grantHash, clone(row));
  }

  async redeemConsoleGrant(grantHash: string, now: Date) {
    const row = this.s.consoleGrants.get(grantHash);
    if (!row || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
    row.usedAt = new Date(now);
    return clone(row);
  }

  async insertConsoleSession(row: ConsoleSessionRow): Promise<void> {
    if (this.s.consoleSessions.has(row.tokenHash)) throw new Error("session exists");
    this.s.consoleSessions.set(row.tokenHash, clone(row));
  }

  async getConsoleSession(tokenHash: string) {
    const row = this.s.consoleSessions.get(tokenHash);
    return row ? clone(row) : null;
  }

  async touchConsoleSession(id: string, now: Date): Promise<void> {
    for (const row of this.s.consoleSessions.values()) if (row.id === id) row.lastSeenAt = new Date(now);
  }

  async deleteConsoleSession(tokenHash: string): Promise<void> {
    this.s.consoleSessions.delete(tokenHash);
  }

  async insertOperatorGrant(row: OperatorGrantRow): Promise<void> {
    if (this.s.operatorGrants.has(row.grantHash)) throw new Error("grant exists");
    this.s.operatorGrants.set(row.grantHash, clone(row));
  }

  async redeemOperatorGrant(grantHash: string, now: Date) {
    const row = this.s.operatorGrants.get(grantHash);
    if (!row || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
    row.usedAt = new Date(now);
    return clone(row);
  }

  async insertOperatorSession(row: OperatorSessionRow): Promise<void> {
    if (this.s.operatorSessions.has(row.tokenHash)) throw new Error("session exists");
    this.s.operatorSessions.set(row.tokenHash, clone(row));
  }

  async getOperatorSession(tokenHash: string) {
    const row = this.s.operatorSessions.get(tokenHash);
    return row ? clone(row) : null;
  }

  async touchOperatorSession(id: string, now: Date): Promise<void> {
    for (const row of this.s.operatorSessions.values()) if (row.id === id) row.lastSeenAt = new Date(now);
  }

  async deleteOperatorSession(tokenHash: string): Promise<void> {
    this.s.operatorSessions.delete(tokenHash);
  }

  async pruneFederation(now: Date): Promise<number> {
    let removed = 0;
    for (const map of [
      this.s.consoleGrants,
      this.s.consoleSessions,
      this.s.operatorGrants,
      this.s.operatorSessions,
    ] as Array<Map<string, { expiresAt: Date }>>) {
      for (const [key, row] of map) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          map.delete(key);
          removed += 1;
        }
      }
    }
    return removed;
  }

  async insertSecurityEvent(row: SecurityEventRow): Promise<void> {
    this.s.securityEvents.push(clone(row));
  }

  async listSecurityEvents(): Promise<SecurityEventRow[]> {
    return this.s.securityEvents.map(clone);
  }

  async insertHost(row: HostRow): Promise<void> {
    for (const h of this.s.hosts.values()) {
      if (h.name === row.name) throw new Error("host name exists");
    }
    this.s.hosts.set(row.id, clone(row));
  }

  async getHost(id: string) {
    const row = this.s.hosts.get(id);
    return row ? clone(row) : null;
  }

  async getHostByName(name: string) {
    for (const row of this.s.hosts.values()) if (row.name === name) return clone(row);
    return null;
  }

  async listHosts() {
    return [...this.s.hosts.values()].sort((a, b) => a.name.localeCompare(b.name)).map(clone);
  }

  async updateHost(row: HostRow): Promise<void> {
    if (!this.s.hosts.has(row.id)) throw new Error("host not found");
    this.s.hosts.set(row.id, clone(row));
  }

  async hostAllocated(hostId: string): Promise<Resources> {
    const used: Resources = { vcpu: 0, memoryMb: 0, diskGb: 0 };
    const onHost = new Set<string>();
    for (const row of this.s.instances.values()) {
      if (row.hostId !== hostId || !live(row)) continue;
      onHost.add(row.id);
      used.vcpu += row.spec.vcpu;
      used.memoryMb += row.spec.memoryMb;
      used.diskGb += row.spec.diskGb;
    }
    for (const snap of this.s.snapshots.values()) {
      if (live(snap) && onHost.has(snap.instanceId)) used.diskGb += snap.sizeGb;
    }
    return used;
  }

  async insertEnrolmentToken(row: EnrolmentTokenRow): Promise<void> {
    this.s.tokens.set(row.tokenHash, { ...clone(row), usedAt: null });
  }

  async consumeEnrolmentToken(tokenHash: string, now: Date) {
    const row = this.s.tokens.get(tokenHash);
    if (!row || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
    row.usedAt = new Date(now);
    const { usedAt: _usedAt, ...rest } = row;
    return clone(rest);
  }

  async listHeldAddresses(): Promise<string[]> {
    return [...this.s.addresses.keys()];
  }

  async holdAddress(address: string, instanceId: string, now: Date): Promise<void> {
    if (this.s.addresses.has(address)) throw new Error("address held");
    this.s.addresses.set(address, { instanceId, heldAt: new Date(now) });
  }

  async releaseAddress(instanceId: string): Promise<void> {
    for (const [address, hold] of this.s.addresses) {
      if (hold.instanceId === instanceId) this.s.addresses.delete(address);
    }
  }

  async insertJob(row: JobRow): Promise<void> {
    if (this.s.jobs.has(row.id)) throw new Error("job exists");
    this.s.jobs.set(row.id, clone(row));
  }

  async getJob(id: string) {
    const row = this.s.jobs.get(id);
    return row ? clone(row) : null;
  }

  async updateJob(row: JobRow): Promise<void> {
    if (!this.s.jobs.has(row.id)) throw new Error("job not found");
    this.s.jobs.set(row.id, clone(row));
  }

  async leaseNextJob(hostId: string, now: Date, leaseUntil: Date, types?: readonly JobType[]) {
    const next = [...this.s.jobs.values()]
      .filter((j) => j.hostId === hostId && j.state === "queued" && (!types || types.includes(j.type)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
    if (!next) return null;
    next.state = "leased";
    next.attempt += 1;
    next.leaseExpiresAt = new Date(leaseUntil);
    next.updatedAt = new Date(now);
    return clone(next);
  }

  async listExpiredLeases(now: Date) {
    return [...this.s.jobs.values()]
      .filter(
        (j) => j.state === "leased" && j.leaseExpiresAt !== null && j.leaseExpiresAt.getTime() <= now.getTime(),
      )
      .map(clone);
  }

  async listJobsForInstance(instanceId: string) {
    return [...this.s.jobs.values()]
      .filter((j) => j.instanceId === instanceId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async clearJobResults(before: Date): Promise<number> {
    let n = 0;
    for (const job of this.s.jobs.values()) {
      if (job.result !== null && job.updatedAt.getTime() < before.getTime()) {
        job.result = null;
        n += 1;
      }
    }
    return n;
  }

  async claimNonce(scope: NonceScope, nonce: string, expiresAt: Date, now: Date): Promise<boolean> {
    const id = `${scope}\n${nonce}`;
    const held = this.s.nonces.get(id);
    if (held && held.getTime() > now.getTime()) return false;
    this.s.nonces.set(id, new Date(expiresAt));
    return true;
  }

  async pruneNonces(now: Date): Promise<number> {
    let removed = 0;
    for (const [id, expiresAt] of this.s.nonces) {
      if (expiresAt.getTime() <= now.getTime()) {
        this.s.nonces.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async insertUsageSample(row: UsageSampleRow): Promise<boolean> {
    const id = `${row.instanceId}\n${row.sampledAt.toISOString()}`;
    if (this.s.samples.has(id)) return false;
    this.s.samples.set(id, clone(row));
    return true;
  }

  async addUsage(row: UsageRecordRow): Promise<void> {
    const id = `${row.serviceInstanceId}\n${row.hourStart.toISOString()}`;
    const current = this.s.usage.get(id);
    if (!current) {
      this.s.usage.set(id, clone(row));
      return;
    }
    current.vcpuSeconds += row.vcpuSeconds;
    current.memoryMbSeconds += row.memoryMbSeconds;
    current.diskGbSeconds += row.diskGbSeconds;
  }

  async listUsageRecords(serviceInstanceId: string, from: Date, to: Date) {
    return [...this.s.usage.values()]
      .filter(
        (r) =>
          r.serviceInstanceId === serviceInstanceId &&
          r.hourStart.getTime() >= from.getTime() &&
          r.hourStart.getTime() < to.getTime(),
      )
      .sort((a, b) => a.hourStart.getTime() - b.hourStart.getTime())
      .map(clone);
  }
}

export class MemoryComputeStore implements ComputeStore {
  readonly kind = "memory";
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const before = clone(this.state);
      try {
        return await fn(new MemoryTx(this.state));
      } catch (err) {
        this.state = before;
        throw err;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
