/**
 * Applies `migrations/NNN_name.sql` in order, once each, under an advisory
 * lock. Every applied file's SHA-256 is recorded; if a file that was already
 * applied changes, the runner refuses to continue (migrations are additive).
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** `apps/api/migrations`, from both `src/store` and `dist/store`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const LOCK_ID = 7_301_301;

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const match = FILE_RE.exec(file);
    if (!match) throw new Error(`Migration file name ${file} must look like 001_name.sql`);
    if (seen.has(match[1]!)) throw new Error(`Migration number ${match[1]} is used twice`);
    seen.add(match[1]!);
    const sql = await readFile(`${dir}/${file}`, "utf8");
    migrations.push({
      id: file.replace(/\.sql$/, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

export async function migrate(
  client: pg.ClientBase,
  migrations?: Migration[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const list = migrations ?? (await loadMigrations());
  const applied: string[] = [];
  const skipped: string[] = [];
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.id, r.checksum]));
    for (const migration of list) {
      const previous = done.get(migration.id);
      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(`Migration ${migration.id} changed after it was applied`);
        }
        skipped.push(migration.id);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
          migration.id,
          migration.checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      applied.push(migration.id);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
  }
  return { applied, skipped };
}
