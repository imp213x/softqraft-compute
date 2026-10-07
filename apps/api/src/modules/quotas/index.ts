/**
 * Quotas (decisions D4 and D5): the pilot pool caps and the project
 * allow-list.
 *
 * `reserve` must run inside the same transaction that inserts the instance.
 * It takes the pool lock first, so concurrent creates are decided one at a
 * time and can never exceed the caps together.
 */

import type { InstanceSpec } from "@softqraft/compute-contracts";
import type { PoolUsage, StoreTx } from "../../store/index.js";

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

export interface Quotas {
  readonly caps: PoolCaps;
  /** Only listed projects may create anything. An empty list allows none. */
  isProjectAllowed(projectId: string): boolean;
  reserve(tx: StoreTx, spec: InstanceSpec): Promise<ReserveResult>;
}

export function createQuotas(deps: { caps: PoolCaps; allowedProjects: ReadonlySet<string> }): Quotas {
  const { caps } = deps;
  return {
    caps,
    isProjectAllowed(projectId) {
      return deps.allowedProjects.has(projectId.toLowerCase());
    },
    async reserve(tx, spec) {
      const usage = await tx.lockPool();
      if (usage.instances + 1 > caps.maxInstances) return { ok: false, dimension: "instances", usage };
      if (usage.vcpu + spec.vcpu > caps.maxVcpu) return { ok: false, dimension: "vcpu", usage };
      if (usage.memoryMb + spec.memoryMb > caps.maxMemoryMb) return { ok: false, dimension: "memoryMb", usage };
      if (usage.diskGb + spec.diskGb > caps.maxDiskGb) return { ok: false, dimension: "diskGb", usage };
      return { ok: true, usage };
    },
  };
}
