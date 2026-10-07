/**
 * `pnpm --filter @softqraft/compute-api migrate`: apply pending SQL
 * migrations to DATABASE_URL. Prints migration ids only, never the URL.
 */

import pg from "pg";
import { migrate } from "./store/index.js";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("migrate: DATABASE_URL is required\n");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { applied, skipped } = await migrate(client);
    process.stdout.write(
      `migrate: applied ${applied.length} (${applied.join(", ") || "none"}), already applied ${skipped.length}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`migrate: failed: ${(err as Error)?.message ?? "unknown error"}\n`);
  process.exit(1);
});
