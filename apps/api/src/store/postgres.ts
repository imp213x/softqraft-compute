/**
 * Postgres ComputeStore (`pg`), backed by `migrations/*.sql`.
 *
 * Transactions run at READ COMMITTED. Capacity decisions take the pilot
 * pool row lock first (`SELECT … FOR UPDATE`), so concurrent creates are
 * serialised exactly where it matters and nowhere else.
 */

import pg from "pg";
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
  InstanceSizeRow,
  SecurityEventRow,
  ServiceInstanceRow,
  SnapshotRow,
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
    serviceInstanceId: String(r.service_instance_id),
    spec: r.spec as InstanceRow["spec"],
    pendingSize:
      r.pending_vcpu === null || r.pending_vcpu === undefined
        ? null
        : { vcpu: num(r.pending_vcpu), memoryMb: num(r.pending_memory_mb), diskGb: num(r.pending_disk_gb) },
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
    result: (r.result as Record<string, unknown> | null) ?? null,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function toSnapshot(r: Row): SnapshotRow {
  return {
    id: String(r.id),
    instanceId: String(r.instance_id),
    name: String(r.name),
    state: r.state as SnapshotRow["state"],
    sizeGb: num(r.size_gb),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function toServiceInstance(r: Row): ServiceInstanceRow {
  return {
    id: String(r.id),
    cloudOrganisationId: String(r.cloud_organisation_id),
    cloudProjectId: String(r.cloud_project_id),
    displayName: String(r.display_name),
    regionId: String(r.region_id),
    status: r.status as ServiceInstanceRow["status"],
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function toPrincipal(r: Row): PrincipalRow {
  return {
    subject: String(r.subject),
    displayName: String(r.display_name),
    email: String(r.email),
    revokedAfter: dateOrNull(r.revoked_after),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function toConsoleGrant(r: Row): ConsoleGrantRow {
  return {
    grantHash: String(r.grant_hash),
    serviceInstanceId: String(r.service_instance_id),
    subject: String(r.subject),
    role: r.role as ConsoleGrantRow["role"],
    returnPath: String(r.return_path),
    expiresAt: date(r.expires_at),
    usedAt: dateOrNull(r.used_at),
    createdAt: date(r.created_at),
  };
}

function toConsoleSession(r: Row): ConsoleSessionRow {
  return {
    id: String(r.id),
    tokenHash: String(r.token_hash),
    subject: String(r.subject),
    serviceInstanceId: String(r.service_instance_id),
    role: r.role as ConsoleSessionRow["role"],
    createdAt: date(r.created_at),
    expiresAt: date(r.expires_at),
    lastSeenAt: date(r.last_seen_at),
  };
}

function toOperatorGrant(r: Row): OperatorGrantRow {
  return {
    grantHash: String(r.grant_hash),
    subject: String(r.subject),
    role: r.role as OperatorGrantRow["role"],
    returnPath: String(r.return_path),
    expiresAt: date(r.expires_at),
    usedAt: dateOrNull(r.used_at),
    createdAt: date(r.created_at),
  };
}

function toOperatorSession(r: Row): OperatorSessionRow {
  return {
    id: String(r.id),
    tokenHash: String(r.token_hash),
    subject: String(r.subject),
    role: r.role as OperatorSessionRow["role"],
    createdAt: date(r.created_at),
    expiresAt: date(r.expires_at),
    lastSeenAt: date(r.last_seen_at),
  };
}

const INSTANCE_COLUMNS =
  "id, service_instance_id, spec, pending_vcpu, pending_memory_mb, pending_disk_gb, state, pending_reason, host_id, host(private_ip) AS private_ip, created_at, updated_at";

/** What an instance holds: the larger of its size and a pending resize target. */
const HELD = {
  vcpu: "GREATEST(vcpu, COALESCE(pending_vcpu, 0))",
  memoryMb: "GREATEST(memory_mb, COALESCE(pending_memory_mb, 0))",
  diskGb: "GREATEST(disk_gb, COALESCE(pending_disk_gb, 0))",
};

class PostgresTx implements StoreTx {
  constructor(private readonly c: pg.PoolClient) {}

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.c.query(sql, params)).rows as Row[];
  }

  async lockPool(): Promise<PoolUsage> {
    await this.c.query("SELECT id FROM quota_pool WHERE id = 'pilot' FOR UPDATE");
    const [r] = await this.rows(
      `SELECT COALESCE(SUM(${HELD.vcpu}), 0) AS vcpu, COALESCE(SUM(${HELD.memoryMb}), 0) AS memory_mb,
              COALESCE(SUM(${HELD.diskGb}), 0) AS disk_gb, COUNT(*) AS instances,
              (SELECT COALESCE(SUM(size_gb), 0) FROM snapshots WHERE state <> 'deleted') AS snapshot_gb
         FROM instances WHERE state <> 'deleted'`,
    );
    return {
      vcpu: num(r!.vcpu),
      memoryMb: num(r!.memory_mb),
      diskGb: num(r!.disk_gb) + num(r!.snapshot_gb),
      instances: num(r!.instances),
    };
  }

  async insertServiceInstance(row: ServiceInstanceRow): Promise<boolean> {
    const result = await this.c.query(
      `INSERT INTO service_instances (id, cloud_organisation_id, cloud_project_id, display_name, region_id,
         status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.cloudOrganisationId,
        row.cloudProjectId,
        row.displayName,
        row.regionId,
        row.status,
        row.createdAt,
        row.updatedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async getServiceInstance(id: string): Promise<ServiceInstanceRow | null> {
    const [r] = await this.rows("SELECT * FROM service_instances WHERE id = $1", [id]);
    return r ? toServiceInstance(r) : null;
  }

  async getIdempotency(serviceInstanceId: string, key: string): Promise<IdempotencyRow | null> {
    const [r] = await this.rows(
      `SELECT service_instance_id, key, request_hash, instance_id FROM idempotency_keys
        WHERE service_instance_id = $1 AND key = $2`,
      [serviceInstanceId, key],
    );
    return r
      ? {
          serviceInstanceId: String(r.service_instance_id),
          key: String(r.key),
          requestHash: String(r.request_hash),
          instanceId: String(r.instance_id),
        }
      : null;
  }

  async putIdempotency(row: IdempotencyRow, now: Date): Promise<void> {
    await this.c.query(
      `INSERT INTO idempotency_keys (service_instance_id, key, request_hash, instance_id, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.serviceInstanceId, row.key, row.requestHash, row.instanceId, now],
    );
  }

  async insertInstance(row: InstanceRow): Promise<void> {
    await this.c.query(
      `INSERT INTO instances (id, service_instance_id, name, spec, vcpu, memory_mb, disk_gb, state,
         pending_reason, host_id, private_ip, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.id,
        row.serviceInstanceId,
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

  async listInstances(serviceInstanceId: string, options: { includeDeleted?: boolean } = {}) {
    const rows = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances
        WHERE service_instance_id = $1 AND ($2::boolean OR state <> 'deleted')
        ORDER BY created_at, id`,
      [serviceInstanceId, options.includeDeleted === true],
    );
    return rows.map(toInstance);
  }

  async listAllInstances(options: { includeDeleted?: boolean } = {}) {
    const rows = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE ($1::boolean OR state <> 'deleted') ORDER BY created_at, id`,
      [options.includeDeleted === true],
    );
    return rows.map(toInstance);
  }

  async listLiveInstancesOnHost(hostId: string) {
    const rows = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE host_id = $1 AND state <> 'deleted' ORDER BY created_at, id`,
      [hostId],
    );
    return rows.map(toInstance);
  }

  async listPendingInstances(): Promise<InstanceRow[]> {
    const rows = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE state = 'pending' ORDER BY created_at, id`,
    );
    return rows.map(toInstance);
  }

  async findLiveInstanceByName(serviceInstanceId: string, name: string) {
    const [r] = await this.rows(
      `SELECT ${INSTANCE_COLUMNS} FROM instances
        WHERE service_instance_id = $1 AND name = $2 AND state <> 'deleted'`,
      [serviceInstanceId, name],
    );
    return r ? toInstance(r) : null;
  }

  async updateInstance(row: InstanceRow, expectedState: InstanceRow["state"]): Promise<boolean> {
    const result = await this.c.query(
      `UPDATE instances SET state = $2, pending_reason = $3, host_id = $4, private_ip = $5, updated_at = $6,
         spec = $8, vcpu = $9, memory_mb = $10, disk_gb = $11,
         pending_vcpu = $12, pending_memory_mb = $13, pending_disk_gb = $14
        WHERE id = $1 AND state = $7`,
      [
        row.id,
        row.state,
        row.pendingReason,
        row.hostId,
        row.privateIp,
        row.updatedAt,
        expectedState,
        JSON.stringify(row.spec),
        row.spec.vcpu,
        row.spec.memoryMb,
        row.spec.diskGb,
        row.pendingSize?.vcpu ?? null,
        row.pendingSize?.memoryMb ?? null,
        row.pendingSize?.diskGb ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  async recordInstanceSize(row: InstanceSizeRow): Promise<void> {
    await this.c.query(
      `INSERT INTO instance_sizes (instance_id, effective_from, vcpu, memory_mb, disk_gb)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (instance_id, effective_from) DO UPDATE SET
         vcpu = EXCLUDED.vcpu, memory_mb = EXCLUDED.memory_mb, disk_gb = EXCLUDED.disk_gb`,
      [row.instanceId, row.effectiveFrom, row.vcpu, row.memoryMb, row.diskGb],
    );
  }

  async listInstanceSizes(instanceId: string): Promise<InstanceSizeRow[]> {
    const rows = await this.rows(
      "SELECT * FROM instance_sizes WHERE instance_id = $1 ORDER BY effective_from",
      [instanceId],
    );
    return rows.map((r) => ({
      instanceId: String(r.instance_id),
      effectiveFrom: date(r.effective_from),
      vcpu: num(r.vcpu),
      memoryMb: num(r.memory_mb),
      diskGb: num(r.disk_gb),
    }));
  }

  async instanceSizeAt(instanceId: string, at: Date) {
    const [r] = await this.rows(
      `SELECT vcpu, memory_mb, disk_gb FROM instance_sizes WHERE instance_id = $1
        ORDER BY (effective_from <= $2) DESC,
                 CASE WHEN effective_from <= $2 THEN effective_from END DESC,
                 effective_from ASC
        LIMIT 1`,
      [instanceId, at],
    );
    return r ? { vcpu: num(r.vcpu), memoryMb: num(r.memory_mb), diskGb: num(r.disk_gb) } : null;
  }

  async insertSnapshot(row: SnapshotRow): Promise<void> {
    await this.c.query(
      `INSERT INTO snapshots (id, instance_id, name, state, size_gb, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.instanceId, row.name, row.state, row.sizeGb, row.createdAt, row.updatedAt],
    );
  }

  async getSnapshot(id: string) {
    const [r] = await this.rows("SELECT * FROM snapshots WHERE id = $1", [id]);
    return r ? toSnapshot(r) : null;
  }

  async listSnapshots(instanceId: string, options: { includeDeleted?: boolean } = {}) {
    const rows = await this.rows(
      `SELECT * FROM snapshots WHERE instance_id = $1 AND ($2::boolean OR state <> 'deleted')
        ORDER BY created_at, id`,
      [instanceId, options.includeDeleted === true],
    );
    return rows.map(toSnapshot);
  }

  async findLiveSnapshotByName(instanceId: string, name: string) {
    const [r] = await this.rows(
      "SELECT * FROM snapshots WHERE instance_id = $1 AND name = $2 AND state <> 'deleted'",
      [instanceId, name],
    );
    return r ? toSnapshot(r) : null;
  }

  async updateSnapshot(row: SnapshotRow, expectedState: SnapshotRow["state"]): Promise<boolean> {
    const result = await this.c.query(
      "UPDATE snapshots SET state = $2, updated_at = $3 WHERE id = $1 AND state = $4",
      [row.id, row.state, row.updatedAt, expectedState],
    );
    return result.rowCount === 1;
  }

  async markSnapshotsDeleted(instanceId: string, now: Date): Promise<number> {
    const result = await this.c.query(
      "UPDATE snapshots SET state = 'deleted', updated_at = $2 WHERE instance_id = $1 AND state <> 'deleted'",
      [instanceId, now],
    );
    return result.rowCount ?? 0;
  }

  async upsertPrincipal(row: Pick<PrincipalRow, "subject" | "displayName" | "email">, now: Date): Promise<void> {
    await this.c.query(
      `INSERT INTO cloud_principals (subject, display_name, email, revoked_after, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $4)
       ON CONFLICT (subject) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email,
         updated_at = EXCLUDED.updated_at`,
      [row.subject, row.displayName, row.email, now],
    );
  }

  async getPrincipal(subject: string) {
    const [r] = await this.rows("SELECT * FROM cloud_principals WHERE subject = $1", [subject]);
    return r ? toPrincipal(r) : null;
  }

  async revokePrincipal(subject: string, now: Date): Promise<number> {
    const updated = await this.c.query(
      "UPDATE cloud_principals SET revoked_after = $2, updated_at = $2 WHERE subject = $1",
      [subject, now],
    );
    if (!updated.rowCount) return 0;
    const ended = await this.rows(
      `WITH c AS (DELETE FROM console_sessions WHERE subject = $1 RETURNING expires_at),
            o AS (DELETE FROM operator_sessions WHERE subject = $1 RETURNING expires_at)
       SELECT (SELECT count(*) FROM c WHERE expires_at > $2) + (SELECT count(*) FROM o WHERE expires_at > $2) AS n`,
      [subject, now],
    );
    return num(ended[0]!.n);
  }

  async insertConsoleGrant(row: ConsoleGrantRow): Promise<void> {
    await this.c.query(
      `INSERT INTO console_launch_grants (grant_hash, service_instance_id, subject, role, return_path,
         expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.grantHash,
        row.serviceInstanceId,
        row.subject,
        row.role,
        row.returnPath,
        row.expiresAt,
        row.usedAt,
        row.createdAt,
      ],
    );
  }

  async redeemConsoleGrant(grantHash: string, now: Date) {
    const [r] = await this.rows(
      `UPDATE console_launch_grants SET used_at = $2
        WHERE grant_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING *`,
      [grantHash, now],
    );
    return r ? toConsoleGrant(r) : null;
  }

  async insertConsoleSession(row: ConsoleSessionRow): Promise<void> {
    await this.c.query(
      `INSERT INTO console_sessions (id, token_hash, subject, service_instance_id, role, created_at,
         expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id,
        row.tokenHash,
        row.subject,
        row.serviceInstanceId,
        row.role,
        row.createdAt,
        row.expiresAt,
        row.lastSeenAt,
      ],
    );
  }

  async getConsoleSession(tokenHash: string) {
    const [r] = await this.rows("SELECT * FROM console_sessions WHERE token_hash = $1", [tokenHash]);
    return r ? toConsoleSession(r) : null;
  }

  async touchConsoleSession(id: string, now: Date): Promise<void> {
    await this.c.query("UPDATE console_sessions SET last_seen_at = $2 WHERE id = $1", [id, now]);
  }

  async deleteConsoleSession(tokenHash: string): Promise<void> {
    await this.c.query("DELETE FROM console_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async insertOperatorGrant(row: OperatorGrantRow): Promise<void> {
    await this.c.query(
      `INSERT INTO operator_launch_grants (grant_hash, subject, role, return_path, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.grantHash, row.subject, row.role, row.returnPath, row.expiresAt, row.usedAt, row.createdAt],
    );
  }

  async redeemOperatorGrant(grantHash: string, now: Date) {
    const [r] = await this.rows(
      `UPDATE operator_launch_grants SET used_at = $2
        WHERE grant_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING *`,
      [grantHash, now],
    );
    return r ? toOperatorGrant(r) : null;
  }

  async insertOperatorSession(row: OperatorSessionRow): Promise<void> {
    await this.c.query(
      `INSERT INTO operator_sessions (id, token_hash, subject, role, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.tokenHash, row.subject, row.role, row.createdAt, row.expiresAt, row.lastSeenAt],
    );
  }

  async getOperatorSession(tokenHash: string) {
    const [r] = await this.rows("SELECT * FROM operator_sessions WHERE token_hash = $1", [tokenHash]);
    return r ? toOperatorSession(r) : null;
  }

  async touchOperatorSession(id: string, now: Date): Promise<void> {
    await this.c.query("UPDATE operator_sessions SET last_seen_at = $2 WHERE id = $1", [id, now]);
  }

  async deleteOperatorSession(tokenHash: string): Promise<void> {
    await this.c.query("DELETE FROM operator_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async pruneFederation(now: Date): Promise<number> {
    let removed = 0;
    for (const table of ["console_launch_grants", "console_sessions", "operator_launch_grants", "operator_sessions"]) {
      const result = await this.c.query(`DELETE FROM ${table} WHERE expires_at <= $1`, [now]);
      removed += result.rowCount ?? 0;
    }
    return removed;
  }

  async insertSecurityEvent(row: SecurityEventRow): Promise<void> {
    await this.c.query(
      `INSERT INTO security_events (id, action, subject, service_instance_id, session_id, role, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id,
        row.action,
        row.subject,
        row.serviceInstanceId,
        row.sessionId,
        row.role,
        row.detail === null ? null : JSON.stringify(row.detail),
        row.createdAt,
      ],
    );
  }

  async listSecurityEvents(): Promise<SecurityEventRow[]> {
    const rows = await this.rows("SELECT * FROM security_events ORDER BY created_at, id");
    return rows.map((r) => ({
      id: String(r.id),
      action: String(r.action),
      subject: (r.subject as string | null) ?? null,
      serviceInstanceId: (r.service_instance_id as string | null) ?? null,
      sessionId: (r.session_id as string | null) ?? null,
      role: (r.role as string | null) ?? null,
      detail: (r.detail as Record<string, string> | null) ?? null,
      createdAt: date(r.created_at),
    }));
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

  async lockHost(id: string) {
    const [r] = await this.rows("SELECT * FROM hosts WHERE id = $1 FOR UPDATE", [id]);
    return r ? toHost(r) : null;
  }

  async touchHost(id: string, now: Date) {
    const [r] = await this.rows(
      `UPDATE hosts SET last_seen_at = $2,
         state = CASE WHEN state = 'enrolled' THEN 'active' ELSE state END
        WHERE id = $1
        RETURNING *`,
      [id, now],
    );
    return r ? toHost(r) : null;
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
      `SELECT COALESCE(SUM(${HELD.vcpu}), 0) AS vcpu, COALESCE(SUM(${HELD.memoryMb}), 0) AS memory_mb,
              COALESCE(SUM(${HELD.diskGb}), 0) AS disk_gb,
              (SELECT COALESCE(SUM(s.size_gb), 0) FROM snapshots s JOIN instances i ON i.id = s.instance_id
                WHERE i.host_id = $1 AND i.state <> 'deleted' AND s.state <> 'deleted') AS snapshot_gb
         FROM instances WHERE host_id = $1 AND state <> 'deleted'`,
      [hostId],
    );
    return { vcpu: num(r!.vcpu), memoryMb: num(r!.memory_mb), diskGb: num(r!.disk_gb) + num(r!.snapshot_gb) };
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
      `UPDATE jobs SET state = $2, attempt = $3, lease_expires_at = $4, last_error = $5, updated_at = $6,
         result = $7
        WHERE id = $1`,
      [
        row.id,
        row.state,
        row.attempt,
        row.leaseExpiresAt,
        row.lastError,
        row.updatedAt,
        row.result === null ? null : JSON.stringify(row.result),
      ],
    );
  }

  async leaseNextJob(hostId: string, now: Date, leaseUntil: Date, types?: readonly JobType[]) {
    const [r] = await this.rows(
      `UPDATE jobs SET state = 'leased', attempt = attempt + 1, lease_expires_at = $3, updated_at = $2
        WHERE id = (
          SELECT id FROM jobs WHERE host_id = $1 AND state = 'queued'
             AND ($4::text[] IS NULL OR type = ANY ($4::text[]))
           ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [hostId, now, leaseUntil, types ? [...types] : null],
    );
    return r ? toJob(r) : null;
  }

  async clearJobResults(before: Date): Promise<number> {
    const result = await this.c.query(
      "UPDATE jobs SET result = NULL WHERE result IS NOT NULL AND updated_at < $1",
      [before],
    );
    return result.rowCount ?? 0;
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
      `INSERT INTO usage_samples (instance_id, sampled_at, host_id, service_instance_id, interval_seconds,
         power_state, vcpu, memory_mb, disk_gb)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (instance_id, sampled_at) DO NOTHING`,
      [
        row.instanceId,
        row.sampledAt,
        row.hostId,
        row.serviceInstanceId,
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
      `INSERT INTO usage_records (service_instance_id, hour_start, vcpu_seconds, memory_mb_seconds, disk_gb_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_instance_id, hour_start) DO UPDATE SET
         vcpu_seconds = usage_records.vcpu_seconds + EXCLUDED.vcpu_seconds,
         memory_mb_seconds = usage_records.memory_mb_seconds + EXCLUDED.memory_mb_seconds,
         disk_gb_seconds = usage_records.disk_gb_seconds + EXCLUDED.disk_gb_seconds`,
      [row.serviceInstanceId, row.hourStart, row.vcpuSeconds, row.memoryMbSeconds, row.diskGbSeconds],
    );
  }

  async listUsageRecords(serviceInstanceId: string, from: Date, to: Date) {
    const rows = await this.rows(
      `SELECT * FROM usage_records WHERE service_instance_id = $1 AND hour_start >= $2 AND hour_start < $3
        ORDER BY hour_start`,
      [serviceInstanceId, from, to],
    );
    return rows.map((r) => ({
      serviceInstanceId: String(r.service_instance_id),
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
