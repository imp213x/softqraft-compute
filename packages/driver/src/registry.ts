/**
 * Driver registry, keyed by driver name. Drivers are registered as
 * factories so each agent process builds its own instance with its own
 * configuration, together with their capabilities.
 *
 * A driver can also be *declared* without a factory: the API knows its name
 * and capabilities (to accept an enrolment and to report what an instance
 * can do) but never builds it, because the API never talks to a hypervisor.
 */

import {
  FAKE_DRIVER_CAPABILITIES,
  PROXMOX_DRIVER_CAPABILITIES,
  type DriverCapabilities,
  type HypervisorDriver,
} from "./driver.js";
import { FakeDriver } from "./fake-driver.js";

export type DriverFactory = (options?: Record<string, unknown>) => HypervisorDriver;

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

interface Entry {
  factory: DriverFactory | null;
  capabilities: Readonly<DriverCapabilities>;
}

export class DriverRegistry {
  private readonly entries = new Map<string, Entry>();

  private add(name: string, entry: Entry): void {
    if (!NAME_RE.test(name)) throw new Error("Driver names are 2-32 characters of a-z 0-9 -");
    if (this.entries.has(name)) throw new Error(`Driver "${name}" is already registered`);
    this.entries.set(name, { factory: entry.factory, capabilities: Object.freeze({ ...entry.capabilities }) });
  }

  /** A driver this process can build. */
  register(name: string, factory: DriverFactory, capabilities: DriverCapabilities): void {
    this.add(name, { factory, capabilities });
  }

  /** A driver this process knows by name and capabilities but never builds. */
  declare(name: string, capabilities: DriverCapabilities): void {
    this.add(name, { factory: null, capabilities });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** The driver's capabilities, or null for an unknown driver. */
  capabilities(name: string): Readonly<DriverCapabilities> | null {
    return this.entries.get(name)?.capabilities ?? null;
  }

  create(name: string, options?: Record<string, unknown>): HypervisorDriver {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown driver "${name}"`);
    if (!entry.factory) throw new Error(`Driver "${name}" is declared but cannot be built in this process`);
    return entry.factory(options);
  }
}

/**
 * The drivers this build knows: `fake` (buildable) and `proxmox` (declared;
 * the host agent builds it from `@softqraft/compute-driver-proxmox`).
 */
export function defaultDriverRegistry(): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register("fake", () => new FakeDriver(), FAKE_DRIVER_CAPABILITIES);
  registry.declare("proxmox", PROXMOX_DRIVER_CAPABILITIES);
  return registry;
}
