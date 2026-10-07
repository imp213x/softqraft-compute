/**
 * Composition root: configuration, store, driver registry, routes.
 * Run with `pnpm --filter @softqraft/compute-api dev` (or `start` after a build).
 */

import { defaultDriverRegistry } from "@softqraft/compute-driver";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { defaultStoreRegistry } from "./store/index.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`compute-api: configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const store = defaultStoreRegistry().create(config.store, { databaseUrl: config.databaseUrl });
  const drivers = defaultDriverRegistry();
  const { app, services } = await buildApp({ config, store, drivers });

  const timer = setInterval(() => {
    services.maintenance(new Date()).catch((err: unknown) => {
      app.log.error({ err: { message: (err as Error)?.message } }, "maintenance failed");
    });
  }, config.maintenanceIntervalSeconds * 1000);
  timer.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(timer);
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { store: store.kind, federation: config.federation.enabled, drivers: drivers.names() },
    "compute-api listening",
  );
}

void main();
