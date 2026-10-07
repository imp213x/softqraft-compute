/**
 * Instance routes.
 *
 * - Console (browser, same origin): registered inside the Console session
 *   guard, so `req.consoleSession` is a valid session and writes already
 *   passed the role and Origin checks. Every route acts on the session's
 *   own service instance.
 * - Cloud (server, Cloud-signed): a read-only list for the Cloud summary
 *   and Copilot.
 *
 * Both call the same module functions; no logic lives here.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateInstanceRequest,
  CreateSnapshotRequest,
  IDEMPOTENCY_KEY_RE,
  InstanceAction,
} from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import { jsonBody, type Clock } from "../../lib/http.js";
import { serviceInstanceParam, uuidParam } from "../../lib/params.js";
import type { ServiceInstances } from "../service-instances/index.js";
import type { Instances } from "./index.js";

function scope(req: FastifyRequest): string {
  if (!req.consoleSession) throw new HttpError(401, "unauthorized", "Your session has ended");
  return req.consoleSession.serviceInstance.id;
}

export function registerConsoleInstanceRoutes(app: FastifyInstance, deps: { instances: Instances; clock: Clock }): void {
  const { instances, clock } = deps;

  app.post("/console/v1/instances", async (req, reply) => {
    const serviceInstanceId = scope(req);
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      throw new HttpError(400, "idempotency_key_required", "The Idempotency-Key header is required");
    }
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new HttpError(400, "idempotency_key_invalid", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ -");
    }
    const request = CreateInstanceRequest.parse(jsonBody(req));
    const result = await instances.create({ serviceInstanceId, idempotencyKey: key, request, now: clock() });
    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.replayed ? 200 : 201).send({ instance: result.instance });
  });

  app.get("/console/v1/instances", async (req) => ({ instances: await instances.list(scope(req)) }));

  app.get("/console/v1/instances/:id", async (req) => ({
    instance: await instances.get(scope(req), uuidParam(req, "id", "instance")),
  }));

  app.delete("/console/v1/instances/:id", async (req, reply) => {
    const instance = await instances.remove(scope(req), uuidParam(req, "id", "instance"), clock());
    return reply.status(202).send({ instance });
  });

  app.post("/console/v1/instances/:id/actions", async (req, reply) => {
    const serviceInstanceId = scope(req);
    const id = uuidParam(req, "id", "instance");
    const action = InstanceAction.parse(jsonBody(req));
    const instance = await instances.act(serviceInstanceId, id, action, clock());
    return reply.status(202).send({ instance });
  });

  app.get("/console/v1/instances/:id/snapshots", async (req) => ({
    snapshots: await instances.listSnapshots(scope(req), uuidParam(req, "id", "instance")),
  }));

  app.post("/console/v1/instances/:id/snapshots", async (req, reply) => {
    const serviceInstanceId = scope(req);
    const id = uuidParam(req, "id", "instance");
    const { name } = CreateSnapshotRequest.parse(jsonBody(req));
    const snapshot = await instances.createSnapshot(serviceInstanceId, id, name, clock());
    return reply.status(202).send({ snapshot });
  });

  app.delete("/console/v1/instances/:id/snapshots/:snapshotId", async (req, reply) => {
    const serviceInstanceId = scope(req);
    const id = uuidParam(req, "id", "instance");
    const snapshotId = uuidParam(req, "snapshotId", "snapshot");
    const snapshot = await instances.deleteSnapshot(serviceInstanceId, id, snapshotId, clock());
    return reply.status(202).send({ snapshot });
  });

  // The ticket is a short-lived credential: never cache or log it.
  app.post("/console/v1/instances/:id/console", async (req, reply) => {
    const serviceInstanceId = scope(req);
    const id = uuidParam(req, "id", "instance");
    const console = await instances.openConsole(serviceInstanceId, id, clock);
    return reply.header("cache-control", "no-store").send({ console });
  });
}

export function registerCloudInstanceRoutes(
  app: FastifyInstance,
  deps: { instances: Instances; serviceInstances: ServiceInstances },
): void {
  app.get("/cloud/v1/service-instances/:serviceInstanceId/instances", async (req) => {
    const si = await deps.serviceInstances.require(serviceInstanceParam(req));
    return { instances: await deps.instances.list(si.id) };
  });
}

/** `GET /admin/v1/fleet/instances`: every instance, for staff support (operator session). */
export function registerFleetInstanceRoutes(app: FastifyInstance, deps: { instances: Instances }): void {
  app.get("/admin/v1/fleet/instances", async (req) => {
    const query = req.query as Record<string, unknown>;
    return { instances: await deps.instances.listAll({ includeDeleted: query.include === "deleted" }) };
  });
}
