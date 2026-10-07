/**
 * The hypervisor driver interface. The host agent runs jobs through a
 * driver; the API never talks to a hypervisor. C1a ships only the in-memory
 * FakeDriver. The Proxmox driver arrives in C1b behind this same interface.
 */

import type { InstanceSpec, PowerState } from "@softqraft/compute-contracts";

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
 * Every operation is idempotent: repeating a call that already took effect
 * succeeds without changing anything, because a job can be retried after a
 * lost report.
 */
export interface HypervisorDriver {
  readonly name: string;
  create(input: CreateVmInput): Promise<void>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  delete(instanceId: string): Promise<void>;
  snapshot(instanceId: string, snapshotName: string): Promise<void>;
  status(instanceId: string): Promise<VmStatus>;
}
