/**
 * Instances: create, read, start, stop, resize, snapshot, console and
 * delete, and what happens when their jobs end.
 *
 * Instances belong to a Cloud service instance (cloud-federation-v1 §3.1).
 * A create is one transaction: idempotency check, service instance and its
 * project's allow-list, pool reservation (under the pool lock), address,
 * placement and the create job. Every create needs an `Idempotency-Key`;
 * repeating it with the same body returns the same instance, with a
 * different body it is refused.
 *
 * Resize runs only while stopped: vCPU and memory may change, the disk only
 * grows. Snapshots hold the instance's disk size against the pool's disk
 * cap until deleted. A console request queues a one-attempt `console` job
 * and waits briefly for the host agent's ticket; the API never holds
 * hypervisor credentials.
 *
 * The kill switch (`stopAllOnHost`) stops every running instance on a
 * disabled host, and an instance that comes up on a disabled host is
 * stopped as soon as it does.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  ConsoleTicket,
  SnapshotJobPayload,
  type CreateInstanceRequest,
  type CreateJobPayload,
  type Instance,
  type InstanceAction,
  type InstanceSpec,
  type InstanceState,
  type LifecycleJobPayload,
  type ResizeJobPayload,
  type Snapshot,
} from "@softqraft/compute-contracts";
import { canonicalJson } from "@softqraft/compute-jobs";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, InstanceRow, JobRow, SnapshotRow, StoreTx } from "../../store/index.js";
import type { Images } from "../images/index.js";
import type { Ipam } from "../ipam/index.js";
import type { JobOutcomeHandler, Jobs } from "../jobs/index.js";
import type { Quotas } from "../quotas/index.js";
import type { Scheduler } from "../scheduler/index.js";
import { assertTransition, canTransition } from "./state-machine.js";

export {
  TRANSITIONS,
  assertTransition,
  canTransition,
  InvalidTransitionError,
} from "./state-machine.js";
export { registerCloudInstanceRoutes, registerConsoleInstanceRoutes, registerFleetInstanceRoutes } from "./routes.js";

export interface InstancesDeps {
  store: ComputeStore;
  quotas: Quotas;
  scheduler: Scheduler;
  ipam: Ipam;
  images: Images;
  /** Used when a create request leaves `diskGb` out. */
  defaultDiskGb: number;
  /** How long `openConsole` waits for the agent's ticket. */
  consoleWaitMs: number;
  /** Real-time pause between console polls (tests may shorten it). */
  sleep?: (ms: number) => Promise<void>;
  /** Resolved lazily: jobs and instances depend on each other through hooks. */
  jobs: () => Jobs;
}

export interface CreateResult {
  instance: Instance;
  /** True when this was a repeat of an earlier request with the same key. */
  replayed: boolean;
}

export interface Instances {
  create(input: {
    serviceInstanceId: string;
    idempotencyKey: string;
    request: CreateInstanceRequest;
    now: Date;
  }): Promise<CreateResult>;
  list(serviceInstanceId: string): Promise<Instance[]>;
  /** Every instance, for staff support. */
  listAll(options?: { includeDeleted?: boolean }): Promise<Instance[]>;
  get(serviceInstanceId: string, id: string): Promise<Instance>;
  act(serviceInstanceId: string, id: string, action: InstanceAction, now: Date): Promise<Instance>;
  remove(serviceInstanceId: string, id: string, now: Date): Promise<Instance>;
  createSnapshot(serviceInstanceId: string, id: string, name: string, now: Date): Promise<Snapshot>;
  listSnapshots(serviceInstanceId: string, id: string): Promise<Snapshot[]>;
  deleteSnapshot(serviceInstanceId: string, id: string, snapshotId: string, now: Date): Promise<Snapshot>;
  /** Ask the host agent for a console ticket and wait for it. */
  openConsole(serviceInstanceId: string, id: string, clock: () => Date): Promise<ConsoleTicket>;
  /** Kill switch: queue a stop for every running instance on a host. Returns how many. */
  stopAllOnHost(tx: StoreTx, hostId: string, now: Date): Promise<number>;
  /** Try to place every `pending` instance. Returns how many were placed. */
  placePending(now: Date): Promise<number>;
  /** Job outcome hooks for the jobs module. */
  readonly jobOutcomes: JobOutcomeHandler;
}

export function toInstance(row: InstanceRow): Instance {
  return {
    id: row.id,
    serviceInstanceId: row.serviceInstanceId,
    spec: row.spec,
    state: row.state,
    pendingReason: row.pendingReason,
    hostId: row.hostId,
    privateIp: row.privateIp,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    instanceId: row.instanceId,
    name: row.name,
    state: row.state,
    sizeGb: row.sizeGb,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const NOT_FOUND = () => new HttpError(404, "instance_not_found", "Instance not found");
const SNAPSHOT_NOT_FOUND = () => new HttpError(404, "snapshot_not_found", "Snapshot not found");
const HOST_DISABLED = () => new HttpError(409, "host_disabled", "The host running this instance is disabled");
const POLL_MS = 100;

function conflict(from: InstanceState, action: string): HttpError {
  return new HttpError(409, "invalid_state", `Cannot ${action} an instance that is ${from}`);
}

function quotaExceeded(dimension: string): HttpError {
  return new HttpError(409, "quota_exceeded", `The pilot pool has no room: ${dimension} limit reached`);
}

export function requestHash(spec: InstanceSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createInstances(deps: InstancesDeps): Instances {
  const { store, quotas, scheduler, ipam, images } = deps;
  const sleep = deps.sleep ?? realSleep;

  async function move(tx: StoreTx, row: InstanceRow, to: InstanceState, now: Date, patch: Partial<InstanceRow> = {}) {
    assertTransition(row.state, to);
    const next: InstanceRow = { ...row, ...patch, state: to, updatedAt: now };
    if (!(await tx.updateInstance(next, row.state))) {
      throw new HttpError(409, "concurrent_update", "The instance changed; retry the request");
    }
    return next;
  }

  /** Place a pending instance and queue its create job, or record why not. */
  async function tryPlace(tx: StoreTx, row: InstanceRow, now: Date): Promise<InstanceRow> {
    const placement = await scheduler.place(tx, row.spec);
    if (!placement.ok) {
      if (row.pendingReason === placement.reason) return row;
      const next = { ...row, pendingReason: placement.reason, updatedAt: now };
      await tx.updateInstance(next, "pending");
      return next;
    }
    const placed = await move(tx, row, "provisioning", now, { hostId: placement.hostId, pendingReason: null });
    const payload: CreateJobPayload = { spec: row.spec, privateIp: row.privateIp!, network: ipam.network };
    await deps.jobs().enqueue(tx, { hostId: placement.hostId, instanceId: row.id, type: "create", payload, now });
    return placed;
  }

  async function owned(tx: StoreTx, serviceInstanceId: string, id: string): Promise<InstanceRow> {
    const row = await tx.getInstance(id);
    if (!row || row.serviceInstanceId !== serviceInstanceId) throw NOT_FOUND();
    return row;
  }

  /** Locks the host row (lock order: pool, host, instance) and refuses a disabled host. */
  async function requireHostEnabled(tx: StoreTx, row: InstanceRow): Promise<void> {
    if (!row.hostId) return;
    const host = await tx.lockHost(row.hostId);
    if (host?.state === "disabled") throw HOST_DISABLED();
  }

  async function lifecycleJob(tx: StoreTx, row: InstanceRow, type: "start" | "stop" | "delete" | "console", now: Date) {
    const payload: LifecycleJobPayload = { name: row.spec.name };
    return deps.jobs().enqueue(tx, {
      hostId: row.hostId!,
      instanceId: row.id,
      type,
      payload,
      now,
      // A console ticket is wanted now or never: no retries.
      ...(type === "console" ? { maxAttempts: 1 } : {}),
    });
  }

  /** Stop an instance that is running, as the kill switch does. */
  async function stopRunning(tx: StoreTx, row: InstanceRow, now: Date): Promise<boolean> {
    if (row.state !== "running" || !row.hostId) return false;
    const stopping = await move(tx, row, "stopping", now);
    await lifecycleJob(tx, stopping, "stop", now);
    return true;
  }

  async function snapshotOf(tx: StoreTx, job: JobRow): Promise<SnapshotRow | null> {
    const parsed = SnapshotJobPayload.safeParse(job.payload);
    if (!parsed.success) return null;
    return tx.findLiveSnapshotByName(job.instanceId, parsed.data.snapshotName);
  }

  async function moveSnapshot(tx: StoreTx, snap: SnapshotRow, from: SnapshotRow["state"], to: SnapshotRow["state"], now: Date) {
    if (snap.state !== from) return;
    await tx.updateSnapshot({ ...snap, state: to, updatedAt: now }, from);
  }

  const jobOutcomes: JobOutcomeHandler = {
    async succeeded(tx, job: JobRow, now) {
      // The host lock serialises this outcome with the kill switch, which
      // takes the same lock: either disable sees the instance running and
      // stops it, or this sees the host disabled and stops it.
      const host = await tx.lockHost(job.hostId);
      const row = await tx.getInstance(job.instanceId);
      if (!row) return;
      switch (job.type) {
        case "snapshot": {
          const snap = await snapshotOf(tx, job);
          if (snap) await moveSnapshot(tx, snap, "creating", "available", now);
          return;
        }
        case "snapshot_delete": {
          const snap = await snapshotOf(tx, job);
          if (snap) await moveSnapshot(tx, snap, "deleting", "deleted", now);
          return;
        }
        case "console":
          return;
        default:
          break;
      }
      const target: Partial<Record<JobRow["type"], InstanceState>> = {
        create: "running",
        start: "running",
        stop: "stopped",
        delete: "deleted",
        resize: "stopped",
      };
      const to = target[job.type];
      if (!to || !canTransition(row.state, to)) return;
      const next = await move(tx, row, to, now);
      if (to === "deleted") {
        await ipam.release(tx, row.id, now);
        await tx.markSnapshotsDeleted(row.id, now);
      }
      if (to === "running" && host?.state === "disabled") {
        // Kill switch: anything that comes up on a disabled host is stopped.
        await stopRunning(tx, next, now);
      }
    },
    async failed(tx, job: JobRow, now) {
      // Same lock order as `succeeded`: host, then instance.
      await tx.lockHost(job.hostId);
      switch (job.type) {
        case "snapshot":
        case "snapshot_delete": {
          // A failed snapshot never breaks its instance.
          const snap = await snapshotOf(tx, job);
          if (snap) await moveSnapshot(tx, snap, job.type === "snapshot" ? "creating" : "deleting", "error", now);
          return;
        }
        case "console":
          return;
        default: {
          const row = await tx.getInstance(job.instanceId);
          if (!row || !canTransition(row.state, "error")) return;
          await move(tx, row, "error", now);
        }
      }
    },
  };

  async function resize(
    tx: StoreTx,
    row: InstanceRow,
    action: Extract<InstanceAction, { action: "resize" }>,
    now: Date,
  ): Promise<InstanceRow> {
    if (row.state !== "stopped") throw conflict(row.state, "resize");
    await requireHostEnabled(tx, row);
    const size = {
      vcpu: action.vcpu ?? row.spec.vcpu,
      memoryMb: action.memoryMb ?? row.spec.memoryMb,
      diskGb: action.diskGb ?? row.spec.diskGb,
    };
    if (size.diskGb < row.spec.diskGb) throw new HttpError(400, "invalid_resize", "A disk can only grow");
    if (size.vcpu === row.spec.vcpu && size.memoryMb === row.spec.memoryMb && size.diskGb === row.spec.diskGb) {
      throw new HttpError(400, "invalid_resize", "The new size is the current size");
    }
    const delta = {
      instances: 0,
      vcpu: size.vcpu - row.spec.vcpu,
      memoryMb: size.memoryMb - row.spec.memoryMb,
      diskGb: size.diskGb - row.spec.diskGb,
    };
    const reservation = await quotas.reserveDelta(tx, delta);
    if (!reservation.ok) throw quotaExceeded(reservation.dimension);
    if (row.hostId) {
      const host = await tx.getHost(row.hostId);
      const used = await tx.hostAllocated(row.hostId);
      if (
        host &&
        ((delta.vcpu > 0 && used.vcpu + delta.vcpu > host.capacity.vcpu) ||
          (delta.memoryMb > 0 && used.memoryMb + delta.memoryMb > host.capacity.memoryMb) ||
          (delta.diskGb > 0 && used.diskGb + delta.diskGb > host.capacity.diskGb))
      ) {
        throw new HttpError(409, "no_host_capacity", "The host has no room for this size");
      }
    }
    // The new size is held from now on; if the resize job fails the
    // instance goes to `error`, as for any other failed job.
    const resizing = await move(tx, row, "resizing", now, { spec: { ...row.spec, ...size } });
    const payload: ResizeJobPayload = { name: row.spec.name, ...size };
    await deps.jobs().enqueue(tx, { hostId: row.hostId!, instanceId: row.id, type: "resize", payload, now });
    return resizing;
  }

  return {
    jobOutcomes,

    async create({ serviceInstanceId, idempotencyKey, request, now }) {
      const spec: InstanceSpec = { ...request, diskGb: request.diskGb ?? deps.defaultDiskGb };
      const image = images.getAvailable(spec.imageId);
      if (!image) throw new HttpError(400, "unknown_image", "Image is not available");
      if (spec.diskGb < image.minDiskGb) {
        throw new HttpError(400, "disk_too_small", `This image needs at least ${image.minDiskGb} GB of disk`);
      }
      const hash = requestHash(spec);

      return store.transaction(async (tx) => {
        const si = await tx.getServiceInstance(serviceInstanceId);
        if (!si || si.status !== "active") throw new HttpError(404, "service_instance_not_found", "Service instance not found");
        // D4: the allow-list holds Cloud project ids, checked through the service instance.
        if (!quotas.isProjectAllowed(si.cloudProjectId)) {
          throw new HttpError(403, "project_not_allowed", "This project may not create instances");
        }
        // The pool lock comes first: it also serialises concurrent requests
        // that carry the same idempotency key.
        const reservation = await quotas.reserve(tx, spec);

        const previous = await tx.getIdempotency(serviceInstanceId, idempotencyKey);
        if (previous) {
          if (previous.requestHash !== hash) {
            throw new HttpError(409, "idempotency_key_reused", "This Idempotency-Key was used with a different request");
          }
          const existing = await tx.getInstance(previous.instanceId);
          if (!existing) throw NOT_FOUND();
          return { instance: toInstance(existing), replayed: true };
        }

        if (!reservation.ok) throw quotaExceeded(reservation.dimension);
        if (await tx.findLiveInstanceByName(serviceInstanceId, spec.name)) {
          throw new HttpError(409, "name_taken", "An instance with this name already exists");
        }

        const draft: InstanceRow = {
          id: randomUUID(),
          serviceInstanceId,
          spec,
          state: "pending",
          pendingReason: null,
          hostId: null,
          privateIp: null,
          createdAt: now,
          updatedAt: now,
        };
        // The address hold references the instance, so insert the instance first.
        await tx.insertInstance(draft);
        const privateIp = await ipam.allocate(tx, draft.id, now);
        if (!privateIp) throw new HttpError(409, "address_pool_exhausted", "No private address is free");
        const row: InstanceRow = { ...draft, privateIp };
        await tx.updateInstance(row, "pending");
        await tx.putIdempotency({ serviceInstanceId, key: idempotencyKey, requestHash: hash, instanceId: row.id }, now);
        const placed = await tryPlace(tx, row, now);
        return { instance: toInstance(placed), replayed: false };
      });
    },

    async list(serviceInstanceId) {
      return store.transaction(async (tx) => (await tx.listInstances(serviceInstanceId)).map(toInstance));
    },

    async listAll(options = {}) {
      return store.transaction(async (tx) => (await tx.listAllInstances(options)).map(toInstance));
    },

    async get(serviceInstanceId, id) {
      return store.transaction(async (tx) => toInstance(await owned(tx, serviceInstanceId, id)));
    },

    async act(serviceInstanceId, id, action, now) {
      return store.transaction(async (tx) => {
        const row = await owned(tx, serviceInstanceId, id);
        if (action.action === "resize") return toInstance(await resize(tx, row, action, now));
        const [from, to] =
          action.action === "start" ? (["stopped", "starting"] as const) : (["running", "stopping"] as const);
        if (row.state !== from) throw conflict(row.state, action.action);
        if (action.action === "start") await requireHostEnabled(tx, row);
        const next = await move(tx, row, to, now);
        await lifecycleJob(tx, next, action.action, now);
        return toInstance(next);
      });
    },

    async remove(serviceInstanceId, id, now) {
      return store.transaction(async (tx) => {
        const row = await owned(tx, serviceInstanceId, id);
        if (!canTransition(row.state, "deleting")) throw conflict(row.state, "delete");
        const deleting = await move(tx, row, "deleting", now, { pendingReason: null });
        if (!row.hostId) {
          // Never placed: nothing exists on a host, so finish here.
          const deleted = await move(tx, deleting, "deleted", now);
          await ipam.release(tx, row.id, now);
          await tx.markSnapshotsDeleted(row.id, now);
          return toInstance(deleted);
        }
        await lifecycleJob(tx, deleting, "delete", now);
        return toInstance(deleting);
      });
    },

    async createSnapshot(serviceInstanceId, id, name, now) {
      return store.transaction(async (tx) => {
        const row = await owned(tx, serviceInstanceId, id);
        if ((row.state !== "running" && row.state !== "stopped") || !row.hostId) throw conflict(row.state, "snapshot");
        await requireHostEnabled(tx, row);
        const reservation = await quotas.reserveDelta(tx, { instances: 0, vcpu: 0, memoryMb: 0, diskGb: row.spec.diskGb });
        if (!reservation.ok) throw quotaExceeded(reservation.dimension);
        const host = await tx.getHost(row.hostId);
        const used = await tx.hostAllocated(row.hostId);
        if (host && used.diskGb + row.spec.diskGb > host.capacity.diskGb) {
          throw new HttpError(409, "no_host_capacity", "The host has no disk room for a snapshot");
        }
        if (await tx.findLiveSnapshotByName(row.id, name)) {
          throw new HttpError(409, "snapshot_name_taken", "A snapshot with this name already exists");
        }
        const snap: SnapshotRow = {
          id: randomUUID(),
          instanceId: row.id,
          name,
          state: "creating",
          sizeGb: row.spec.diskGb,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insertSnapshot(snap);
        await deps.jobs().enqueue(tx, {
          hostId: row.hostId,
          instanceId: row.id,
          type: "snapshot",
          payload: { snapshotName: name },
          now,
        });
        return toSnapshot(snap);
      });
    },

    async listSnapshots(serviceInstanceId, id) {
      return store.transaction(async (tx) => {
        const row = await owned(tx, serviceInstanceId, id);
        return (await tx.listSnapshots(row.id)).map(toSnapshot);
      });
    },

    async deleteSnapshot(serviceInstanceId, id, snapshotId, now) {
      return store.transaction(async (tx) => {
        const row = await owned(tx, serviceInstanceId, id);
        const snap = await tx.getSnapshot(snapshotId);
        if (!snap || snap.instanceId !== row.id || snap.state === "deleted") throw SNAPSHOT_NOT_FOUND();
        if (snap.state !== "available" && snap.state !== "error") {
          throw new HttpError(409, "invalid_state", `Cannot delete a snapshot that is ${snap.state}`);
        }
        if (!row.hostId) {
          const gone: SnapshotRow = { ...snap, state: "deleted", updatedAt: now };
          await tx.updateSnapshot(gone, snap.state);
          return toSnapshot(gone);
        }
        await requireHostEnabled(tx, row);
        const deleting: SnapshotRow = { ...snap, state: "deleting", updatedAt: now };
        if (!(await tx.updateSnapshot(deleting, snap.state))) {
          throw new HttpError(409, "concurrent_update", "The snapshot changed; retry the request");
        }
        await deps.jobs().enqueue(tx, {
          hostId: row.hostId,
          instanceId: row.id,
          type: "snapshot_delete",
          payload: { snapshotName: snap.name },
          now,
        });
        return toSnapshot(deleting);
      });
    },

    async openConsole(serviceInstanceId, id, clock) {
      const job = await store.transaction(async (tx) => {
        const row = await owned(tx, serviceInstanceId, id);
        if (row.state !== "running" || !row.hostId) throw conflict(row.state, "open a console on");
        await requireHostEnabled(tx, row);
        return lifecycleJob(tx, row, "console", clock());
      });
      const jobs = deps.jobs();
      const deadline = Date.now() + deps.consoleWaitMs;
      for (;;) {
        const progress = await jobs.takeResult(job.id, clock());
        if (progress.state === "succeeded") {
          const ticket = ConsoleTicket.safeParse(progress.result);
          if (!ticket.success) break;
          return ticket.data;
        }
        if (progress.state === "failed") break;
        if (Date.now() >= deadline) {
          // Nobody will wait for this ticket: make sure it is never issued.
          if (await jobs.cancel(job.id, "console_timeout", clock())) {
            throw new HttpError(504, "console_timeout", "The host did not answer in time. Try again");
          }
          continue;
        }
        await sleep(POLL_MS);
      }
      throw new HttpError(502, "console_unavailable", "The console could not be opened. Try again");
    },

    async stopAllOnHost(tx, hostId, now) {
      let stopped = 0;
      for (const row of await tx.listLiveInstancesOnHost(hostId)) {
        if (await stopRunning(tx, row, now)) stopped += 1;
      }
      return stopped;
    },

    async placePending(now) {
      return store.transaction(async (tx) => {
        // Placement reads host capacity, so it takes the pool lock like create.
        await tx.lockPool();
        let placed = 0;
        for (const row of await tx.listPendingInstances()) {
          if ((await tryPlace(tx, row, now)).state === "provisioning") placed += 1;
        }
        return placed;
      });
    },
  };
}
