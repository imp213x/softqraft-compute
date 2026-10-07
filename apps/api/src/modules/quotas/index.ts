/**
 * Quotas (decisions D4 and D5): the pilot pool caps and the project
 * allow-list.
 *
 * The allow-list holds Cloud project ids; an instance create checks it
 * through its service instance's project.
 *
 * `reserve` must run inside the same transaction that writes what it
 * reserves (an instance, a resize, a snapshot). It takes the pool lock
 * first, so concurrent requests are decided one at a time and can never
 * exceed the caps together. Snapshots hold disk against the disk cap.
 */

import { INSTANCE_LIMITS, SIZE_PRESETS, type InstanceSpec, type SizesResponse } from "@softqraft/compute-contracts";
import type { PoolUsage, StoreTx } from "../../store/index.js";

export { registerConsoleSizeRoutes } from "./routes.js";

export interface PoolCaps {
  maxVcpu: number;
  maxMemoryMb: number;
  maxInstances: number;
  maxDiskGb: number;
}

export type QuotaDimension = "instances" | "vcpu" | "memoryMb" | "diskGb";

export type ReserveResult =
  | { ok: true; usage: PoolUsage }
  | { ok: false; dimension: QuotaDimension; usage: PoolUsage };

/** What a request adds to the pool. Negative values free capacity. */
export interface PoolDelta {
  instances: number;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
}

export interface Quotas {
  readonly caps: PoolCaps;
  /** Only listed Cloud projects may create anything. An empty list allows none. */
  isProjectAllowed(projectId: string): boolean;
  /** Reserve room for a new instance. */
  reserve(tx: StoreTx, spec: InstanceSpec): Promise<ReserveResult>;
  /** Reserve a change. Only dimensions that grow are checked against the caps. */
  reserveDelta(tx: StoreTx, delta: PoolDelta): Promise<ReserveResult>;
  /** The size presets an empty pool could hold, each with `diskGb`. */
  sizes(diskGb: number): SizesResponse;
}

/**
 * The presets that fit the pilot caps and the per-instance limits. A preset
 * that could never be created, even in an empty pool, is not offered.
 */
export function sizesFor(caps: PoolCaps, diskGb: number): SizesResponse {
  const fits = (p: { vcpu: number; memoryMb: number }) =>
    p.vcpu <= Math.min(caps.maxVcpu, INSTANCE_LIMITS.vcpu.max) &&
    p.memoryMb <= Math.min(caps.maxMemoryMb, INSTANCE_LIMITS.memoryMb.max) &&
    diskGb <= Math.min(caps.maxDiskGb, INSTANCE_LIMITS.diskGb.max);
  const sizes = SIZE_PRESETS.filter(fits).map((p) => ({ ...p, diskGb }));
  return { sizes, defaultSizeId: sizes[0]?.id ?? null };
}

export function createQuotas(deps: { caps: PoolCaps; allowedProjects: ReadonlySet<string> }): Quotas {
  const { caps } = deps;
  return {
    caps,
    isProjectAllowed(projectId) {
      return deps.allowedProjects.has(projectId.toLowerCase());
    },
    sizes(diskGb) {
      return sizesFor(caps, diskGb);
    },
    async reserve(tx, spec) {
      return this.reserveDelta(tx, { instances: 1, vcpu: spec.vcpu, memoryMb: spec.memoryMb, diskGb: spec.diskGb });
    },
    async reserveDelta(tx, delta) {
      const usage = await tx.lockPool();
      const over = (used: number, add: number, cap: number) => add > 0 && used + add > cap;
      if (over(usage.instances, delta.instances, caps.maxInstances)) return { ok: false, dimension: "instances", usage };
      if (over(usage.vcpu, delta.vcpu, caps.maxVcpu)) return { ok: false, dimension: "vcpu", usage };
      if (over(usage.memoryMb, delta.memoryMb, caps.maxMemoryMb)) return { ok: false, dimension: "memoryMb", usage };
      if (over(usage.diskGb, delta.diskGb, caps.maxDiskGb)) return { ok: false, dimension: "diskGb", usage };
      return { ok: true, usage };
    },
  };
}
