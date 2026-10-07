/**
 * Scheduler: pick an `active` host with room for an instance. Hosts that
 * are `enrolled`, `draining` or `disabled` never receive new instances. In
 * C1 there is one host; with several, the one with the most free memory wins
 * (ties by name), which spreads load.
 */

import type { InstanceSpec } from "@softqraft/compute-contracts";
import type { StoreTx } from "../../store/index.js";

/** Why an instance could not be placed. Shown as `pendingReason`. */
export const PENDING_REASONS = Object.freeze({
  noActiveHost: "no_active_host",
  noCapacity: "no_host_capacity",
} as const);
export type PendingReason = (typeof PENDING_REASONS)[keyof typeof PENDING_REASONS];

export type Placement = { ok: true; hostId: string } | { ok: false; reason: PendingReason };

export interface Scheduler {
  place(tx: StoreTx, spec: InstanceSpec): Promise<Placement>;
}

export function createScheduler(): Scheduler {
  return {
    async place(tx, spec) {
      const active = (await tx.listHosts()).filter((h) => h.state === "active");
      if (active.length === 0) return { ok: false, reason: PENDING_REASONS.noActiveHost };
      let best: { hostId: string; freeMemory: number; name: string } | null = null;
      for (const host of active) {
        const used = await tx.hostAllocated(host.id);
        const free = {
          vcpu: host.capacity.vcpu - used.vcpu,
          memoryMb: host.capacity.memoryMb - used.memoryMb,
          diskGb: host.capacity.diskGb - used.diskGb,
        };
        if (free.vcpu < spec.vcpu || free.memoryMb < spec.memoryMb || free.diskGb < spec.diskGb) continue;
        if (
          !best ||
          free.memoryMb > best.freeMemory ||
          (free.memoryMb === best.freeMemory && host.name < best.name)
        ) {
          best = { hostId: host.id, freeMemory: free.memoryMb, name: host.name };
        }
      }
      return best ? { ok: true, hostId: best.hostId } : { ok: false, reason: PENDING_REASONS.noCapacity };
    },
  };
}
