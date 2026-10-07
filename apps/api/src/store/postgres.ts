/**
 * Postgres ComputeStore (`pg`), backed by `migrations/*.sql`.
 *
 * Transactions run at READ COMMITTED. Capacity decisions take the pilot
 * pool row lock first (`SELECT … FOR UPDATE`), so concurrent creates are
 * serialised exactly where it matters and nowhere else.
 */

import pg from "pg";
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

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export interface PostgresStoreOptions {
  connectionString: string;
  /** Use a non-default schema (tests use one schema per run). */
  schema?: string;
  maxConnections?: number;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));

function toInstance(r: Row): InstanceRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    spec: r.spec as InstanceRow["spec"],
    state: r.state as InstanceRow["state"],
    pendingReason: (r.pending_reason as string | null) ?? null,
    hostId: (r.host_id as string | null) ?? null,
    privateIp: (r.private_ip as string | null) ?? null,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function toHost(r: Row): HostRow {
  return {
    id: String(r.id),
    name: String(r.name),
    state: r.state as HostRow["state"],
    driver: String(r.driver),
    capacity: {
      vcpu: num(r.capacity_vcpu),
      memoryMb: num(r.capacity_memory_mb),
      diskGb: num(r.capacity_disk_gb),
    },
    publicKeyPem: String(r.public_key_pem),
    enrolledAt: date(r.enrolled_at),
    lastSeenAt: dateOrNull(r.last_seen_at),
  };
}

function toJob(r: Row): JobRow {
  return {
    id: String(r.id),
    hostId: String(r.host_id),
    instanceId: String(r.instance_id),
    type: r.type as JobRow["type"],
    payload: r.payload as Record<string, unknown>,
    state: r.state as JobRow["state"],
    attempt: num(r.attempt),
    maxAttempts: num(r.max_attempts),
    leaseExpiresAt: dateOrNull(r.lease_expires_at),
    lastError: (r.last_error as string | null) ?? null,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

const INSTANCE_COLUMNS =
  "id, project_id, spec, state, pending_reason, host_id, host(private_ip) AS private_ip, created_at, updated_at";

class PostgresTx implements StoreTx {
  constructor(private readonly c: pg.PoolClient) {}

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.c.query(sql, params)).rows as Row[];
  }

  async lockPool(): Promise<PoolUsage> {
    await this.c.query("SELECT id FROM quota_pool WHERE id = 'pilot' FOR UPDATE");
    const [r] = await this.rows(
      `SELECT COALESCE(SUM(vcpu), 0) AS vcpu, COALESCE(SUM(memory_mb), 0) AS memory_mb,
              COALESCE(SUM(disk_gb), 0) AS disk_gb, COUNT(*) AS instances
         FROM instances WHERE state <> 'deleted'`,
    );
    return {
      vcpu: num(r!.vcpu),
      memoryMb: num(r!.memory_mb),
      diskGb: num(r!.disk_gb),
      instances: num(r!.instances),
    };
  }

  async getIdempotency(projectId: string, key: string): Promise<IdempotencyRow | null> {
    const [r] = await this.rows(
      "SELECT project_id, key, request_hash, instance_id FROM idempotency_keys WHERE project_id = $1 AND key = $2",
      [projectId, key],
    );
    return r
      ? {
          projectId: String(r.project_id),
          key: String(r.key),
          requestHash: String(r.request_hash),
          instanceId: String(r.instance_id),
        }
      : null;
  }

  async putIdempotency(row: IdempotencyRow, now: Date): Promise<void> {
    await this.c.query(
      "INSERT INTO idempotency_keys (project_id, key, request_hash, instance_id, created_at) VALUES ($1, $2, $3, $4, $5)",
      [row.projectId, row.key, row.requestHash, row.instanceId, now],
    );
  }

  async insertInstance(row: InstanceRow): Promise<void> {
    await this.c.query(
      `INSERT INTO instances (id, project_id, name, spec, vcpu, memory_mb, disk_gb, state,
         pending_reason, host_id, private_ip, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.id,
        row.projectId,
        row.spec.name,
        JSON.stringify(row.spec),
        row.spec.vcpu,
        row.spec.memoryMb,
        row.spec.diskGb,
        row.state,
        row.pendingReason,
        row.hostId,
        row.privateIp,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  async getInstance(id: string): Promise<InstanceRow | null> {
    const [r] = await this.rows(`SELECT ${INSTANCE_COLUMNS} FROM instances WHERE id = $1`, [id]);
    return r ? toInstance(r) : null;
  }

  async listInstances(projectId: string, options: { includeDeleted?: boolean } = {}) {
    const rows = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances
        WHERE project_id = $1 AND ($2::boolean OR state <> 'deleted')
        ORDER BY created_at, id`,
      [projectId, options.includeDeleted === true],
    );
    return rows.map(toInstance);
  }

  async listPendingInstances(): Promise<InstanceRow[]> {
    const rows = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE state = 'pending' ORDER BY created_at, id`,
    );
    return rows.map(toInstance);
  }

  async findLiveInstanceByName(projectId: string, name: string) {
    const [r] = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE project_id = $1 AND name = $2 AND state <> 'deleted'`,
      [projectId, name],
    );
    return r ? toInstance(r) : null;
  }

  async updateInstance(row: InstanceRow, expectedState: InstanceRow["state"]): Promise<boolean> {
    const result = await this.c.query(
      `UPDATE instances SET state = $2, pending_reason = $3, host_id = $4, private_ip = $5, updated_at = $6
        WHERE id = $1 AND state = $7`,
      [row.id, row.state, row.pendingReason, row.hostId, row.privateIp, row.updatedAt, expectedState],
    );
    return result.rowCount === 1;
  }

  async insertHost(row: HostRow): Promise<void> {
    await this.c.query(
      `INSERT INTO hosts (id, name, state, driver, capacity_vcpu, capacity_memory_mb, capacity_disk_gb,
         public_key_pem, enrolled_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id,
        row.name,
        row.state,
        row.driver,
        row.capacity.vcpu,
        row.capacity.memoryMb,
        row.capacity.diskGb,
        row.publicKeyPem,
        row.enrolledAt,
        row.lastSeenAt,
      ],
    );
  }

  async getHost(id: string) {
    const [r] = await this.rows("SELECT * FROM hosts WHERE id = $1", [id]);
    return r ? toHost(r) : null;
  }

  async getHostByName(name: string) {
    const [r] = await this.rows("SELECT * FROM hosts WHERE name = $1", [name]);
    return r ? toHost(r) : null;
  }

  async listHosts() {
    return (await this.rows("SELECT * FROM hosts ORDER BY name")).map(toHost);
  }

  async updateHost(row: HostRow): Promise<void> {
    await this.c.query(
      `UPDATE hosts SET state = $2, driver = $3, capacity_vcpu = $4, capacity_memory_mb = $5,
         capacity_disk_gb = $6, public_key_pem = $7, last_seen_at = $8 WHERE id = $1`,
      [
        row.id,
        row.state,
        row.driver,
        row.capacity.vcpu,
        row.capacity.memoryMb,
        row.capacity.diskGb,
        row.publicKeyPem,
        row.lastSeenAt,
      ],
    );
  }

  async hostAllocated(hostId: string): Promise<Resources> {
    const [r] = await this.rows(
      `SELECT COALESCE(SUM(vcpu), 0) AS vcpu, COALESCE(SUM(memory_mb), 0) AS memory_mb,
              COALESCE(SUM(disk_gb), 0) AS disk_gb
         FROM instances WHERE host_id = $1 AND state <> 'deleted'`,
      [hostId],
    );
    return { vcpu: num(r!.vcpu), memoryMb: num(r!.memory_mb), diskGb: num(r!.disk_gb) };
  }

  async insertEnrolmentToken(row: EnrolmentTokenRow): Promise<void> {
    await this.c.query(
      "INSERT INTO enrolment_tokens (token_hash, host_name, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [row.tokenHash, row.hostName, row.createdAt, row.expiresAt],
    );
  }

  async consumeEnrolmentToken(tokenHash: string, now: Date) {
    const [r] = await this.rows(
      `UPDATE enrolment_tokens SET used_at = $2
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING token_hash, host_name, created_at, expires_at`,
      [tokenHash, now],
    );
    return r
      ? {
          tokenHash: String(r.token_hash),
          hostName: (r.host_name as string | null) ?? null,
          createdAt: date(r.created_at),
          expiresAt: date(r.expires_at),
        }
      : null;
  }

  async listHeldAddresses(): Promise<string[]> {
    const rows = await this.rows(
      "SELECT host(address) AS address FROM ip_allocations WHERE released_at IS NULL",
    );
    return rows.map((r) => String(r.address));
  }

  async holdAddress(address: string, instanceId: string, now: Date): Promise<void> {
    await this.c.query(
      "INSERT INTO ip_allocations (address, instance_id, held_at) VALUES ($1, $2, $3)",
      [address, instanceId, now],
    );
  }

  async releaseAddress(instanceId: string, now: Date): Promise<void> {
    await this.c.query(
      "UPDATE ip_allocations SET released_at = $2 WHERE instance_id = $1 AND released_at IS NULL",
      [instanceId, now],
    );
  }

  async insertJob(row: JobRow): Promise<void> {
    await this.c.query(
      `INSERT INTO jobs (id, host_id, instance_id, type, payload, state, attempt, max_attempts,
         lease_expires_at, last_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        row.id,
        row.hostId,
        row.instanceId,
        row.type,
        JSON.stringify(row.payload),
        row.state,
        row.attempt,
        row.maxAttempts,
        row.leaseExpiresAt,
        row.lastError,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  async getJob(id: string) {
    const [r] = await this.rows("SELECT * FROM jobs WHERE id = $1", [id]);
    return r ? toJob(r) : null;
  }

  async updateJob(row: JobRow): Promise<void> {
    await this.c.query(
      `UPDATE jobs SET state = $2, attempt = $3, lease_expires_at = $4, last_error = $5, updated_at = $6
        WHERE id = $1`,
      [row.id, row.state, row.attempt, row.leaseExpiresAt, row.lastError, row.updatedAt],
    );
  }

  async leaseNextJob(hostId: string, now: Date, leaseUntil: Date) {
    const [r] = await this.rows(
      `UPDATE jobs SET state = 'leased', attempt = attempt + 1, lease_expires_at = $3, updated_at = $2
        WHERE id = (
          SELECT id FROM jobs WHERE host_id = $1 AND state = 'queued'
           ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [hostId, now, leaseUntil],
    );
    return r ? toJob(r) : null;
  }

  async listExpiredLeases(now: Date) {
    const rows = await this.rows(
      "SELECT * FROM jobs WHERE state = 'leased' AND lease_expires_at <= $1 ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED",
      [now],
    );
    return rows.map(toJob);
  }

  async listJobsForInstance(instanceId: string) {
    const rows = await this.rows("SELECT * FROM jobs WHERE instance_id = $1 ORDER BY created_at, id", [
      instanceId,
    ]);
    return rows.map(toJob);
  }

  async claimNonce(scope: NonceScope, nonce: string, expiresAt: Date, now: Date): Promise<boolean> {
    const result = await this.c.query(
      `INSERT INTO nonces (scope, nonce, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (scope, nonce) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE nonces.expires_at <= $4
       RETURNING 1`,
      [scope, nonce, expiresAt, now],
    );
    return result.rowCount === 1;
  }

  async pruneNonces(now: Date): Promise<number> {
    const result = await this.c.query("DELETE FROM nonces WHERE expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  }

  async insertUsageSample(row: UsageSampleRow): Promise<boolean> {
    const result = await this.c.query(
      `INSERT INTO usage_samples (instance_id, sampled_at, host_id, project_id, interval_seconds,
         power_state, vcpu, memory_mb, disk_gb)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (instance_id, sampled_at) DO NOTHING`,
      [
        row.instanceId,
        row.sampledAt,
        row.hostId,
        row.projectId,
        row.intervalSeconds,
        row.powerState,
        row.vcpu,
        row.memoryMb,
        row.diskGb,
      ],
    );
    return result.rowCount === 1;
  }

  async addUsage(row: UsageRecordRow): Promise<void> {
    await this.c.query(
      `INSERT INTO usage_records (project_id, hour_start, vcpu_seconds, memory_mb_seconds, disk_gb_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, hour_start) DO UPDATE SET
         vcpu_seconds = usage_records.vcpu_seconds + EXCLUDED.vcpu_seconds,
         memory_mb_seconds = usage_records.memory_mb_seconds + EXCLUDED.memory_mb_seconds,
         disk_gb_seconds = usage_records.disk_gb_seconds + EXCLUDED.disk_gb_seconds`,
      [row.projectId, row.hourStart, row.vcpuSeconds, row.memoryMbSeconds, row.diskGbSeconds],
    );
  }

  async listUsageRecords(projectId: string, from: Date, to: Date) {
    const rows = await this.rows(
      `SELECT * FROM usage_records WHERE project_id = $1 AND hour_start >= $2 AND hour_start < $3
        ORDER BY hour_start`,
      [projectId, from, to],
    );
    return rows.map((r) => ({
      projectId: String(r.project_id),
      hourStart: date(r.hour_start),
      vcpuSeconds: num(r.vcpu_seconds),
      memoryMbSeconds: num(r.memory_mb_seconds),
      diskGbSeconds: num(r.disk_gb_seconds),
    }));
  }
}

export class PostgresComputeStore implements ComputeStore {
  readonly kind = "postgres";
  readonly pool: pg.Pool;

  constructor(options: PostgresStoreOptions) {
    if (options.schema !== undefined && !SCHEMA_RE.test(options.schema)) {
      throw new Error("Postgres schema name is not valid");
    }
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
    });
    // An idle client error must not crash the process; the next query reports it.
    this.pool.on("error", () => undefined);
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PostgresTx(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
