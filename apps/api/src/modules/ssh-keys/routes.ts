/**
 * Saved SSH key routes, inside the Console session guard (writes need the
 * developer or admin role and this service's Origin):
 *   GET    /console/v1/ssh-keys
 *   POST   /console/v1/ssh-keys        201 new, 200 when already saved
 *   DELETE /console/v1/ssh-keys/:id    204
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { CreateSshKeyRequest } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import { jsonBody, type Clock } from "../../lib/http.js";
import { uuidParam } from "../../lib/params.js";
import type { SshKeys } from "./index.js";

function scope(req: FastifyRequest): string {
  if (!req.consoleSession) throw new HttpError(401, "unauthorized", "Your session has ended");
  return req.consoleSession.serviceInstance.id;
}

export function registerConsoleSshKeyRoutes(app: FastifyInstance, deps: { sshKeys: SshKeys; clock: Clock }): void {
  const { sshKeys, clock } = deps;

  app.get("/console/v1/ssh-keys", async (req) => ({ sshKeys: await sshKeys.list(scope(req)) }));

  app.post("/console/v1/ssh-keys", async (req, reply) => {
    const serviceInstanceId = scope(req);
    const body = CreateSshKeyRequest.parse(jsonBody(req));
    const { key, created } = await sshKeys.save(serviceInstanceId, body, clock());
    return reply.status(created ? 201 : 200).send({ sshKey: key });
  });

  app.delete("/console/v1/ssh-keys/:id", async (req, reply) => {
    const serviceInstanceId = scope(req);
    await sshKeys.remove(serviceInstanceId, uuidParam(req, "id", "ssh_key"));
    return reply.status(204).send();
  });
}
