/**
 * Postgres tests: the migrations, Postgres-only guarantees, and the whole
 * behaviour suite against a real Postgres. Needs DATABASE_URL; CI provides a
 * postgres:16 service. Without DATABASE_URL this file fails on purpose: it
 * never skips silently.
 *
 * Each store gets its own schema, created here and dropped at the end.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import pg from "pg";
import { loadMigrations, migrate, PostgresComputeStore } from "../src/store/index.js";
import { hashGrant } from "@softqraft/federation";
import { grantFrom, harness, idempotencyKey, instanceOf, principal, SI } from "./helpers.js";
import { raceSuite } from "./races.js";
import { behaviourSuite } from "./suites.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set: the Postgres tests need a real Postgres (CI uses postgres:16)");
}

const schemas: string[] = [];

async function withClient<T>(schema: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function freshSchema(): Promise<string> {
  const schema = `c1a_${randomBytes(6).toString("hex")}`;
  schemas.push(schema);
  await withClient(null, (c) => c.query(`CREATE SCHEMA ${schema}`));
  await withClient(schema, (c) => migrate(c));
  return schema;
}

async function freshStore(): Promise<PostgresComputeStore> {
  return new PostgresComputeStore({ connectionString: DATABASE_URL!, schema: await freshSchema(), maxConnections: 20 });
}

after(async () => {
  await withClient(null, async (c) => {
    for (const schema of schemas) await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
});

describe("migrations", () => {
  it("apply once, then are skipped, and record checksums", async () => {
    const schema = `c1a_${randomBytes(6).toString("hex")}`;
    schemas.push(schema);
    await withClient(null, (c) => c.query(`CREATE SCHEMA ${schema}`));
    const first = await withClient(schema, (c) => migrate(c));
    assert.deepEqual(first.applied, ["001_initial", "002_service_instances"]);
    const second = await withClient(schema, (c) => migrate(c));
    assert.deepEqual(second, { applied: [], skipped: ["001_initial", "002_service_instances"] });
    const { rows } = await withClient(schema, (c) => c.query("SELECT id, checksum FROM schema_migrations ORDER BY id"));
    const all = await loadMigrations();
    assert.deepEqual(rows, all.map((m) => ({ id: m.id, checksum: m.checksum })));
  });

  it("002 refuses to re-key instances that already exist", async () => {
    const schema = `c1b_${randomBytes(6).toString("hex")}`;
    schemas.push(schema);
    await withClient(null, (c) => c.query(`CREATE SCHEMA ${schema}`));
    const [first, second] = await loadMigrations();
    await withClient(schema, (c) => migrate(c, [first!]));
    await withClient(schema, (c) =>
      c.query(
        `INSERT INTO instances (id, project_id, name, spec, vcpu, memory_mb, disk_gb, state, created_at, updated_at)
         VALUES ('6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11', '22222222-2222-4222-8222-222222222222', 'old', '{}', 1, 512, 10, 'pending', now(), now())`,
      ),
    );
    await assert.rejects(withClient(schema, (c) => migrate(c, [first!, second!])), /re-keying them needs a written plan/);
    const { rows } = await withClient(schema, (c) => c.query("SELECT id FROM schema_migrations"));
    assert.deepEqual(rows, [{ id: "001_initial" }], "002 rolled back");
  });

  it("refuse to run when an applied migration has changed", async () => {
    const schema = await freshSchema();
    const changed = (await loadMigrations()).map((m) => ({ ...m, checksum: "0".repeat(64) }));
    await assert.rejects(
      withClient(schema, (c) => migrate(c, changed)),
      /changed after it was applied/,
    );
  });
});

describe("postgres-only guarantees", () => {
  it("stores enrolment tokens only as SHA-256 hashes", async () => {
    const store = await freshStore();
    const h = await harness({ store });
    try {
      const { token } = await h.services.hosts.createEnrolmentToken({ now: h.clock.now() });
      const { rows } = await store.pool.query("SELECT * FROM enrolment_tokens");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_hash, createHash("sha256").update(token).digest("hex"));
      assert.ok(!JSON.stringify(rows).includes(token), "the clear token is nowhere in the row");
    } finally {
      await h.close();
      await store.close();
    }
  });

  it("never holds one address twice, even under concurrent creates", async () => {
    const store = await freshStore();
    const h = await harness({
      store,
      env: { COMPUTE_POOL_MAX_INSTANCES: "40", COMPUTE_POOL_MAX_VCPU: "40", COMPUTE_POOL_MAX_MEMORY_MB: "40960", COMPUTE_POOL_MAX_DISK_GB: "1000" },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => h.createInstance({ name: `ip-${i}`, memoryMb: 512 })),
      );
      for (const r of results) assert.equal(r.statusCode, 201, r.body);
      const ips = results.map((r) => instanceOf(r).privateIp);
      assert.equal(new Set(ips).size, 20);
      const { rows } = await store.pool.query(
        "SELECT count(*)::int AS n FROM ip_allocations WHERE released_at IS NULL",
      );
      assert.equal(rows[0].n, 20);
    } finally {
      await h.close();
      await store.close();
    }
  });

  it("keeps the pool caps when creates race on separate connections", async () => {
    const store = await freshStore();
    const h = await harness({ store });
    try {
      // Twelve creates, each a full transaction on its own pooled connection.
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          h.createInstance({ name: `race-${i}`, vcpu: 1, memoryMb: 512, diskGb: 10 }, idempotencyKey()),
        ),
      );
      const created = results.filter((r) => r.statusCode === 201).length;
      assert.equal(created, 3, "COMPUTE_POOL_MAX_INSTANCES=3");
      const { rows } = await store.pool.query("SELECT count(*)::int AS n FROM instances WHERE state <> 'deleted'");
      assert.equal(rows[0].n, 3);
    } finally {
      await h.close();
      await store.close();
    }
  });

  it("stores grants and session tokens only as SHA-256 hashes, and revokes in SQL", async () => {
    const store = await freshStore();
    const h = await harness({ store });
    try {
      const launch = await h.cloud("POST", `/cloud/v1/service-instances/${SI}/console-launches`, {
        principal: principal("user_pg"),
        role: "admin",
        returnPath: "/console/",
      });
      const grant = grantFrom(launch.json().launchUrl);
      const consoleSession = await h.consoleSession("admin", SI, "user_pg");
      const op = await h.operatorSession("owner", "user_pg");
      const dump = JSON.stringify(
        await Promise.all(
          ["console_launch_grants", "console_sessions", "operator_launch_grants", "operator_sessions", "security_events"].map(
            async (t) => (await store.pool.query(`SELECT * FROM ${t}`)).rows,
          ),
        ),
      );
      for (const secret of [grant, consoleSession.token, op.token]) assert.ok(!dump.includes(secret));
      assert.ok(dump.includes(hashGrant(grant)) && dump.includes(hashGrant(consoleSession.token)));

      const res = await h.cloud("POST", "/cloud/v1/principals/user_pg/revocations");
      assert.deepEqual(res.json(), { revokedSessions: 2 });
      const { rows } = await store.pool.query("SELECT revoked_after FROM cloud_principals WHERE subject = 'user_pg'");
      assert.equal(new Date(rows[0].revoked_after).toISOString(), h.clock.now().toISOString());
      assert.equal((await h.browser(consoleSession, "GET", "/console/v1/instances")).statusCode, 401);
      assert.equal((await h.browser(op, "GET", "/admin/v1/fleet/hosts")).statusCode, 401);
    } finally {
      await h.close();
      await store.close();
    }
  });

  it("answers /ready from the database", async () => {
    const store = await freshStore();
    const h = await harness({ store });
    try {
      const ready = await h.app.inject({ url: "/ready" });
      assert.equal(ready.statusCode, 200);
      assert.equal(ready.json().store, "postgres");
    } finally {
      await h.close();
      await store.close();
    }
  });
});

behaviourSuite("postgres store", freshStore);
raceSuite("postgres store", freshStore, { concurrent: true });
