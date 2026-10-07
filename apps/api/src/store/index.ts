/**
 * Store entry point and registry. Modules import only types from here; the
 * composition root picks a store by name.
 */

import { MemoryComputeStore } from "./memory.js";
import { PostgresComputeStore } from "./postgres.js";
import type { ComputeStore } from "./types.js";

export type * from "./types.js";
export { MemoryComputeStore } from "./memory.js";
export { PostgresComputeStore, type PostgresStoreOptions } from "./postgres.js";
export { loadMigrations, migrate, MIGRATIONS_DIR, type Migration } from "./migrations.js";

export interface StoreFactoryOptions {
  databaseUrl?: string;
}

export type StoreFactory = (options: StoreFactoryOptions) => ComputeStore;

export class StoreRegistry {
  private readonly factories = new Map<string, StoreFactory>();

  register(name: string, factory: StoreFactory): void {
    if (this.factories.has(name)) throw new Error(`Store "${name}" is already registered`);
    this.factories.set(name, factory);
  }

  names(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(name: string, options: StoreFactoryOptions): ComputeStore {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown store "${name}"`);
    return factory(options);
  }
}

export function defaultStoreRegistry(): StoreRegistry {
  const registry = new StoreRegistry();
  registry.register("memory", () => new MemoryComputeStore());
  registry.register("postgres", ({ databaseUrl }) => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the postgres store");
    return new PostgresComputeStore({ connectionString: databaseUrl });
  });
  return registry;
}
