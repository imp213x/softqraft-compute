/**
 * Deterministic in-memory driver for tests and local runs. No I/O, no
 * timers, no randomness. Failures can be scripted per operation so tests can
 * drive retries.
 */

import type { InstanceSpec } from "@softqraft/compute-contracts";
import {
  DriverError,
  type CreateVmInput,
  type HypervisorDriver,
  type VmStatus,
} from "./driver.js";

type Operation = "create" | "start" | "stop" | "delete" | "snapshot";

interface FakeVm {
  spec: InstanceSpec;
  privateIp: string;
  power: "running" | "stopped";
  snapshots: string[];
}

export interface FakeDriverOptions {
  /** Capacity the fake host has; creates beyond it fail like a full host. */
  capacity?: { vcpu: number; memoryMb: number; diskGb: number };
}

export class FakeDriver implements HypervisorDriver {
  readonly name = "fake";
  private readonly vms = new Map<string, FakeVm>();
  private readonly scriptedFailures = new Map<Operation, DriverError[]>();
  /** Every call in order, for assertions. */
  readonly calls: Array<{ op: Operation | "status"; instanceId: string }> = [];
  private readonly capacity: FakeDriverOptions["capacity"];

  constructor(options: FakeDriverOptions = {}) {
    this.capacity = options.capacity;
  }

  /** Make the next `times` calls of `op` fail with `error`. */
  failNext(op: Operation, error: DriverError, times = 1): void {
    const queue = this.scriptedFailures.get(op) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(error);
    this.scriptedFailures.set(op, queue);
  }

  private maybeFail(op: Operation): void {
    const queue = this.scriptedFailures.get(op);
    const next = queue?.shift();
    if (next) throw next;
  }

  private require(instanceId: string): FakeVm {
    const vm = this.vms.get(instanceId);
    if (!vm) throw new DriverError("vm_not_found", "VM does not exist", false);
    return vm;
  }

  private used(): { vcpu: number; memoryMb: number; diskGb: number } {
    let vcpu = 0;
    let memoryMb = 0;
    let diskGb = 0;
    for (const vm of this.vms.values()) {
      vcpu += vm.spec.vcpu;
      memoryMb += vm.spec.memoryMb;
      diskGb += vm.spec.diskGb;
    }
    return { vcpu, memoryMb, diskGb };
  }

  async create(input: CreateVmInput): Promise<void> {
    this.calls.push({ op: "create", instanceId: input.instanceId });
    this.maybeFail("create");
    if (this.vms.has(input.instanceId)) return;
    if (this.capacity) {
      const used = this.used();
      if (
        used.vcpu + input.spec.vcpu > this.capacity.vcpu ||
        used.memoryMb + input.spec.memoryMb > this.capacity.memoryMb ||
        used.diskGb + input.spec.diskGb > this.capacity.diskGb
      ) {
        throw new DriverError("host_full", "Host has no room for this VM", false);
      }
    }
    this.vms.set(input.instanceId, {
      spec: input.spec,
      privateIp: input.privateIp,
      power: "running",
      snapshots: [],
    });
  }

  async start(instanceId: string): Promise<void> {
    this.calls.push({ op: "start", instanceId });
    this.maybeFail("start");
    this.require(instanceId).power = "running";
  }

  async stop(instanceId: string): Promise<void> {
    this.calls.push({ op: "stop", instanceId });
    this.maybeFail("stop");
    this.require(instanceId).power = "stopped";
  }

  async delete(instanceId: string): Promise<void> {
    this.calls.push({ op: "delete", instanceId });
    this.maybeFail("delete");
    this.vms.delete(instanceId);
  }

  async snapshot(instanceId: string, snapshotName: string): Promise<void> {
    this.calls.push({ op: "snapshot", instanceId });
    this.maybeFail("snapshot");
    const vm = this.require(instanceId);
    if (!vm.snapshots.includes(snapshotName)) vm.snapshots.push(snapshotName);
  }

  async status(instanceId: string): Promise<VmStatus> {
    this.calls.push({ op: "status", instanceId });
    const vm = this.vms.get(instanceId);
    if (!vm) return { instanceId, power: "absent", snapshots: [] };
    return { instanceId, power: vm.power, snapshots: [...vm.snapshots] };
  }

  /** Number of VMs the fake host holds. */
  get size(): number {
    return this.vms.size;
  }
}
