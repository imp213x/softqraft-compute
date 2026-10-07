/**
 * Driver registry, keyed by driver name. Drivers are registered as
 * factories so each agent process builds its own instance with its own
 * configuration. This repository registers only `fake`; `proxmox` arrives in C1e.
 */

import type { HypervisorDriver } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";

export type DriverFactory = (options?: Record<string, unknown>) => HypervisorDriver;

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

export class DriverRegistry {
  private readonly factories = new Map<string, DriverFactory>();

  register(name: string, factory: DriverFactory): void {
    if (!NAME_RE.test(name)) throw new Error("Driver names are 2-32 characters of a-z 0-9 -");
    if (this.factories.has(name)) throw new Error(`Driver "${name}" is already registered`);
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  names(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(name: string, options?: Record<string, unknown>): HypervisorDriver {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown driver "${name}"`);
    return factory(options);
  }
}

/** A registry holding the drivers this build ships: `fake` only until C1e. */
export function defaultDriverRegistry(): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register("fake", () => new FakeDriver());
  return registry;
}
