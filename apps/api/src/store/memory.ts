/**
 * In-memory ComputeStore for unit tests and local runs without Postgres.
 *
 * Transactions run one at a time behind a mutex, so `lockPool()` is
 * trivially exclusive. A failed transaction restores the state it started
 * from. Rows are cloned on the way in and out so callers cannot mutate
 * stored state by accident.
 */

import type {
  ComputeStore,
  EnrolmentTokenRow,
  HostRow,
  IdempotencyRow,
  InstanceRow,
  JobRow,
  NonceScope,
  PoolUsage,
  Resources,
  StoreTx,
  UsageRecordRow,
  UsageSampleRow,
} from "./types.js";

interface State {
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

function live(row: InstanceRow): boolean {
  return row.state !== "deleted";
}

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
    return usage;
  }

  async getIdempotency(projectId: string, key: string): Promise<IdempotencyRow | null> {
    const row = this.s.idempotency.get(`${projectId}\n${key}`);
    return row ? clone(row) : null;
  }

  async putIdempotency(row: IdempotencyRow): Promise<void> {
    const id = `${row.projectId}\n${row.key}`;
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

  async listInstances(projectId: string, options: { includeDeleted?: boolean } = {}) {
    return [...this.s.instances.values()]
      .filter((r) => r.projectId === projectId && (options.includeDeleted || live(r)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map(clone);
  }

  async listPendingInstances(): Promise<InstanceRow[]> {
    return [...this.s.instances.values()]
      .filter((r) => r.state === "pending")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map(clone);
  }

  async findLiveInstanceByName(projectId: string, name: string) {
    for (const row of this.s.instances.values()) {
      if (row.projectId === projectId && row.spec.name === name && live(row)) return clone(row);
    }
    return null;
  }

  async updateInstance(row: InstanceRow, expectedState: InstanceRow["state"]): Promise<boolean> {
    const current = this.s.instances.get(row.id);
    if (!current || current.state !== expectedState) return false;
    this.s.instances.set(row.id, clone(row));
    return true;
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
    for (const row of this.s.instances.values()) {
      if (row.hostId !== hostId || !live(row)) continue;
      used.vcpu += row.spec.vcpu;
      used.memoryMb += row.spec.memoryMb;
      used.diskGb += row.spec.diskGb;
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

  async leaseNextJob(hostId: string, now: Date, leaseUntil: Date) {
    const next = [...this.s.jobs.values()]
      .filter((j) => j.hostId === hostId && j.state === "queued")
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
    const id = `${row.projectId}\n${row.hourStart.toISOString()}`;
    const current = this.s.usage.get(id);
    if (!current) {
      this.s.usage.set(id, clone(row));
      return;
    }
    current.vcpuSeconds += row.vcpuSeconds;
    current.memoryMbSeconds += row.memoryMbSeconds;
    current.diskGbSeconds += row.diskGbSeconds;
  }

  async listUsageRecords(projectId: string, from: Date, to: Date) {
    return [...this.s.usage.values()]
      .filter(
        (r) =>
          r.projectId === projectId &&
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
