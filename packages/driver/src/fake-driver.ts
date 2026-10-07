/**
 * Deterministic in-memory driver for tests and local runs. No I/O, no
 * timers, no randomness. Failures can be scripted per operation so tests can
 * drive retries.
 */

import type { ConsoleTicket, InstanceSize, InstanceSpec } from "@softqraft/compute-contracts";
import {
  DRIVER_ERRORS,
  FAKE_DRIVER_CAPABILITIES,
  DriverError,
  type CreateVmInput,
  type HypervisorDriver,
  type SnapshotInfo,
  type VmStatus,
} from "./driver.js";

type Operation =
  | "create"
  | "start"
  | "stop"
  | "delete"
  | "resize"
  | "snapshot"
  | "listSnapshots"
  | "deleteSnapshot"
  | "console";

interface FakeVm {
  spec: InstanceSpec;
  privateIp: string;
  power: "running" | "stopped";
  snapshots: string[];
}

export interface FakeDriverOptions {
  /** Capacity the fake host has; creates beyond it fail like a full host. */
  capacity?: { vcpu: number; memoryMb: number; diskGb: number };
  /** Clock for console ticket expiry. Defaults to the system clock. */
  now?: () => Date;
}

/** How long a fake console ticket lives. */
export const FAKE_CONSOLE_TICKET_SECONDS = 60;

export class FakeDriver implements HypervisorDriver {
  readonly name = "fake";
  readonly capabilities = FAKE_DRIVER_CAPABILITIES;
  private readonly vms = new Map<string, FakeVm>();
  private readonly scriptedFailures = new Map<Operation, DriverError[]>();
  /** Every call in order, for assertions. */
  readonly calls: Array<{ op: Operation | "status"; instanceId: string }> = [];
  private readonly capacity: FakeDriverOptions["capacity"];
  private readonly now: () => Date;
  private ticketCounter = 0;

  constructor(options: FakeDriverOptions = {}) {
    this.capacity = options.capacity;
    this.now = options.now ?? (() => new Date());
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
    if (!vm) throw new DriverError(DRIVER_ERRORS.vmNotFound, "VM does not exist", false);
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
        throw new DriverError(DRIVER_ERRORS.hostFull, "Host has no room for this VM", false);
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

  async resize(instanceId: string, size: InstanceSize): Promise<void> {
    this.calls.push({ op: "resize", instanceId });
    this.maybeFail("resize");
    const vm = this.require(instanceId);
    if (vm.power === "running") {
      throw new DriverError(DRIVER_ERRORS.vmRunning, "Stop the VM before resizing it", false);
    }
    if (size.diskGb < vm.spec.diskGb) {
      throw new DriverError(DRIVER_ERRORS.diskShrink, "A disk can only grow", false);
    }
    vm.spec = { ...vm.spec, vcpu: size.vcpu, memoryMb: size.memoryMb, diskGb: size.diskGb };
  }

  async snapshot(instanceId: string, snapshotName: string): Promise<void> {
    this.calls.push({ op: "snapshot", instanceId });
    this.maybeFail("snapshot");
    const vm = this.require(instanceId);
    if (!vm.snapshots.includes(snapshotName)) vm.snapshots.push(snapshotName);
  }

  async listSnapshots(instanceId: string): Promise<SnapshotInfo[]> {
    this.calls.push({ op: "listSnapshots", instanceId });
    this.maybeFail("listSnapshots");
    return this.require(instanceId).snapshots.map((name) => ({ name }));
  }

  async deleteSnapshot(instanceId: string, snapshotName: string): Promise<void> {
    this.calls.push({ op: "deleteSnapshot", instanceId });
    this.maybeFail("deleteSnapshot");
    const vm = this.vms.get(instanceId);
    // The VM (and so the snapshot) already gone counts as done.
    if (!vm) return;
    vm.snapshots = vm.snapshots.filter((s) => s !== snapshotName);
  }

  async console(instanceId: string): Promise<ConsoleTicket> {
    this.calls.push({ op: "console", instanceId });
    this.maybeFail("console");
    const vm = this.require(instanceId);
    if (vm.power !== "running") {
      throw new DriverError(DRIVER_ERRORS.vmNotRunning, "The VM is not running", false);
    }
    this.ticketCounter += 1;
    const expiresAt = new Date(this.now().getTime() + FAKE_CONSOLE_TICKET_SECONDS * 1000);
    return { protocol: "vnc", ticket: `FAKEVNC:${instanceId}:${this.ticketCounter}`, expiresAt: expiresAt.toISOString() };
  }

  /** The size the fake VM has now, or null. */
  sizeOf(instanceId: string): InstanceSize | null {
    const vm = this.vms.get(instanceId);
    return vm ? { vcpu: vm.spec.vcpu, memoryMb: vm.spec.memoryMb, diskGb: vm.spec.diskGb } : null;
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
