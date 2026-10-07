/**
 * The hypervisor driver interface. The host agent runs jobs through a
 * driver; the API never talks to a hypervisor and never holds hypervisor
 * credentials. This repository ships only the in-memory FakeDriver; the
 * Proxmox driver arrives in C1e behind this same interface.
 */

import type { ConsoleTicket, InstanceSize, InstanceSpec, PowerState } from "@softqraft/compute-contracts";

export type { ConsoleTicket, InstanceSize };

export interface CreateVmInput {
  instanceId: string;
  spec: InstanceSpec;
  privateIp: string;
  network: { cidr: string; gateway: string };
}

export interface VmStatus {
  instanceId: string;
  /** `absent` when the hypervisor has no such VM. */
  power: PowerState | "absent";
  snapshots: string[];
}

export interface SnapshotInfo {
  name: string;
}

/** Errors a driver reports. `retryable` tells the agent whether to fail the attempt or give up. */
export class DriverError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "DriverError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Error codes every driver uses for the same conditions, so the agent can
 * report them the same way whatever the hypervisor.
 */
export const DRIVER_ERRORS = Object.freeze({
  vmNotFound: "vm_not_found",
  vmRunning: "vm_running",
  vmNotRunning: "vm_not_running",
  diskShrink: "disk_shrink",
  hostFull: "host_full",
} as const);

/**
 * Every mutating operation is idempotent: repeating a call that already
 * took effect succeeds without changing anything, because a job can be
 * retried after a lost report.
 */
export interface HypervisorDriver {
  readonly name: string;
  create(input: CreateVmInput): Promise<void>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  delete(instanceId: string): Promise<void>;
  /**
   * Change the size of a stopped VM to exactly `size`. Fails with
   * `vm_running` while the VM runs and with `disk_shrink` if `size.diskGb`
   * is smaller than the current disk. vCPU and memory may go up or down.
   */
  resize(instanceId: string, size: InstanceSize): Promise<void>;
  snapshot(instanceId: string, snapshotName: string): Promise<void>;
  listSnapshots(instanceId: string): Promise<SnapshotInfo[]>;
  /** Remove a snapshot. Removing one that is already gone succeeds. */
  deleteSnapshot(instanceId: string, snapshotName: string): Promise<void>;
  /**
   * A short-lived console ticket for a running VM (`vm_not_running`
   * otherwise). The agent passes it to the API as the result of a `console`
   * job. Not idempotent: every call issues a new ticket.
   */
  console(instanceId: string): Promise<ConsoleTicket>;
  status(instanceId: string): Promise<VmStatus>;
}
