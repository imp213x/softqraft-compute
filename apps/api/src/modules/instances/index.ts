/**
 * Instances: create, read, start, stop and delete, and what happens when
 * their jobs end.
 *
 * A create is one transaction: idempotency check, project allow-list, pool
 * reservation (under the pool lock), address, placement and the create job.
 * Every create needs an `Idempotency-Key`; repeating it with the same body
 * returns the same instance, with a different body it is refused.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  CreateJobPayload,
  Instance,
  InstanceAction,
  InstanceSpec,
  InstanceState,
  LifecycleJobPayload,
} from "@softqraft/compute-contracts";
import { canonicalJson } from "@softqraft/compute-jobs";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, InstanceRow, JobRow, StoreTx } from "../../store/index.js";
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
export { registerInstanceRoutes } from "./routes.js";

export interface InstancesDeps {
  store: ComputeStore;
  quotas: Quotas;
  scheduler: Scheduler;
  ipam: Ipam;
  images: Images;
  /** Resolved lazily: jobs and instances depend on each other through hooks. */
  jobs: () => Jobs;
}

export interface CreateResult {
  instance: Instance;
  /** True when this was a repeat of an earlier request with the same key. */
  replayed: boolean;
}

export interface Instances {
  create(input: { projectId: string; idempotencyKey: string; spec: InstanceSpec; now: Date }): Promise<CreateResult>;
  list(projectId: string): Promise<Instance[]>;
  get(projectId: string, id: string): Promise<Instance>;
  act(projectId: string, id: string, action: InstanceAction["action"], now: Date): Promise<Instance>;
  remove(projectId: string, id: string, now: Date): Promise<Instance>;
  /** Try to place every `pending` instance. Returns how many were placed. */
  placePending(now: Date): Promise<number>;
  /** Job outcome hooks for the jobs module. */
  readonly jobOutcomes: JobOutcomeHandler;
}

export function toInstance(row: InstanceRow): Instance {
  return {
    id: row.id,
    projectId: row.projectId,
    spec: row.spec,
    state: row.state,
    pendingReason: row.pendingReason,
    hostId: row.hostId,
    privateIp: row.privateIp,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const NOT_FOUND = () => new HttpError(404, "instance_not_found", "Instance not found");

function conflict(from: InstanceState, action: string): HttpError {
  return new HttpError(409, "invalid_state", `Cannot ${action} an instance that is ${from}`);
}

export function requestHash(spec: InstanceSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

export function createInstances(deps: InstancesDeps): Instances {
  const { store, quotas, scheduler, ipam, images } = deps;

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
    await deps.jobs().enqueue(tx, {
      hostId: placement.hostId,
      instanceId: row.id,
      type: "create",
      payload,
      now,
    });
    return placed;
  }

  async function owned(tx: StoreTx, projectId: string, id: string): Promise<InstanceRow> {
    const row = await tx.getInstance(id);
    if (!row || row.projectId !== projectId) throw NOT_FOUND();
    return row;
  }

  async function lifecycleJob(tx: StoreTx, row: InstanceRow, type: "start" | "stop" | "delete", now: Date) {
    const payload: LifecycleJobPayload = { name: row.spec.name };
    await deps.jobs().enqueue(tx, { hostId: row.hostId!, instanceId: row.id, type, payload, now });
  }

  const jobOutcomes: JobOutcomeHandler = {
    async succeeded(tx, job: JobRow, now) {
      const row = await tx.getInstance(job.instanceId);
      if (!row) return;
      const target: Partial<Record<JobRow["type"], InstanceState>> = {
        create: "running",
        start: "running",
        stop: "stopped",
        delete: "deleted",
      };
      const to = target[job.type];
      // A snapshot leaves the state as it is.
      if (!to || !canTransition(row.state, to)) return;
      await move(tx, row, to, now);
      if (to === "deleted") await ipam.release(tx, row.id, now);
    },
    async failed(tx, job: JobRow, now) {
      const row = await tx.getInstance(job.instanceId);
      if (!row || !canTransition(row.state, "error")) return;
      await move(tx, row, "error", now);
    },
  };

  return {
    jobOutcomes,

    async create({ projectId, idempotencyKey, spec, now }) {
      if (!quotas.isProjectAllowed(projectId)) {
        throw new HttpError(403, "project_not_allowed", "This project may not create instances");
      }
      const image = images.getAvailable(spec.imageId);
      if (!image) throw new HttpError(400, "unknown_image", "Image is not available");
      if (spec.diskGb < image.minDiskGb) {
        throw new HttpError(400, "disk_too_small", `This image needs at least ${image.minDiskGb} GB of disk`);
      }
      const hash = requestHash(spec);

      return store.transaction(async (tx) => {
        // The pool lock comes first: it also serialises concurrent requests
        // that carry the same idempotency key.
        const reservation = await quotas.reserve(tx, spec);

        const previous = await tx.getIdempotency(projectId, idempotencyKey);
        if (previous) {
          if (previous.requestHash !== hash) {
            throw new HttpError(409, "idempotency_key_reused", "This Idempotency-Key was used with a different request");
          }
          const existing = await tx.getInstance(previous.instanceId);
          if (!existing) throw NOT_FOUND();
          return { instance: toInstance(existing), replayed: true };
        }

        if (!reservation.ok) {
          throw new HttpError(409, "quota_exceeded", `The pilot pool has no room: ${reservation.dimension} limit reached`);
        }
        if (await tx.findLiveInstanceByName(projectId, spec.name)) {
          throw new HttpError(409, "name_taken", "An instance with this name already exists in the project");
        }

        const draft: InstanceRow = {
          id: randomUUID(),
          projectId,
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
        const id = row.id;
        await tx.putIdempotency({ projectId, key: idempotencyKey, requestHash: hash, instanceId: id }, now);
        const placed = await tryPlace(tx, row, now);
        return { instance: toInstance(placed), replayed: false };
      });
    },

    async list(projectId) {
      return store.transaction(async (tx) => (await tx.listInstances(projectId)).map(toInstance));
    },

    async get(projectId, id) {
      return store.transaction(async (tx) => toInstance(await owned(tx, projectId, id)));
    },

    async act(projectId, id, action, now) {
      return store.transaction(async (tx) => {
        const row = await owned(tx, projectId, id);
        const [from, to] = action === "start" ? (["stopped", "starting"] as const) : (["running", "stopping"] as const);
        if (row.state !== from) throw conflict(row.state, action);
        const next = await move(tx, row, to, now);
        await lifecycleJob(tx, next, action, now);
        return toInstance(next);
      });
    },

    async remove(projectId, id, now) {
      return store.transaction(async (tx) => {
        const row = await owned(tx, projectId, id);
        if (!canTransition(row.state, "deleting")) throw conflict(row.state, "delete");
        const deleting = await move(tx, row, "deleting", now, { pendingReason: null });
        if (!row.hostId) {
          // Never placed: nothing exists on a host, so finish here.
          const deleted = await move(tx, deleting, "deleted", now);
          await ipam.release(tx, row.id, now);
          return toInstance(deleted);
        }
        await lifecycleJob(tx, deleting, "delete", now);
        return toInstance(deleting);
      });
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
