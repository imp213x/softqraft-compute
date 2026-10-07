/**
 * Cloud-facing instance routes. Registered inside the Cloud-signed context
 * (see app.ts), so every request here is already verified.
 */

import type { FastifyInstance } from "fastify";
import { IDEMPOTENCY_KEY_RE, InstanceAction, InstanceSpec } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import { jsonBody, type Clock } from "../../lib/http.js";
import { uuidParam } from "../../lib/params.js";
import type { Instances } from "./index.js";

export function registerInstanceRoutes(app: FastifyInstance, deps: { instances: Instances; clock: Clock }): void {
  const { instances, clock } = deps;

  app.post("/v1/projects/:projectId/instances", async (req, reply) => {
    const projectId = uuidParam(req, "projectId", "project");
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      throw new HttpError(400, "idempotency_key_required", "The Idempotency-Key header is required");
    }
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new HttpError(400, "idempotency_key_invalid", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ -");
    }
    const spec = InstanceSpec.parse(jsonBody(req));
    const result = await instances.create({ projectId, idempotencyKey: key, spec, now: clock() });
    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.replayed ? 200 : 201).send({ instance: result.instance });
  });

  app.get("/v1/projects/:projectId/instances", async (req) => {
    const projectId = uuidParam(req, "projectId", "project");
    return { instances: await instances.list(projectId) };
  });

  app.get("/v1/projects/:projectId/instances/:id", async (req) => {
    const projectId = uuidParam(req, "projectId", "project");
    const id = uuidParam(req, "id", "instance");
    return { instance: await instances.get(projectId, id) };
  });

  app.delete("/v1/projects/:projectId/instances/:id", async (req, reply) => {
    const projectId = uuidParam(req, "projectId", "project");
    const id = uuidParam(req, "id", "instance");
    const instance = await instances.remove(projectId, id, clock());
    return reply.status(202).send({ instance });
  });

  app.post("/v1/projects/:projectId/instances/:id/actions", async (req, reply) => {
    const projectId = uuidParam(req, "projectId", "project");
    const id = uuidParam(req, "id", "instance");
    const { action } = InstanceAction.parse(jsonBody(req));
    const instance = await instances.act(projectId, id, action, clock());
    return reply.status(202).send({ instance });
  });
}
