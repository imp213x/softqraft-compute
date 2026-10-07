/**
 * Host routes: unsigned enrolment (the one-time token is the credential)
 * and the staff fleet routes (Cloud-signed plus an operator check).
 */

import type { FastifyInstance } from "fastify";
import { CreateEnrolmentTokenRequest, EnrolRequest } from "@softqraft/compute-contracts";
import { jsonBody, type Clock } from "../../lib/http.js";
import { uuidParam } from "../../lib/params.js";
import { toHost, type Hosts } from "./index.js";

export function registerEnrolRoute(
  app: FastifyInstance,
  deps: { hosts: Hosts; clock: Clock; jobSigningKeys: () => Record<string, string> },
): void {
  app.post("/v1/agent/enrol", async (req, reply) => {
    const body = EnrolRequest.parse(jsonBody(req));
    const host = await deps.hosts.enrol(body, deps.clock());
    return reply.status(201).send({ hostId: host.id, state: host.state, jobSigningKeys: deps.jobSigningKeys() });
  });
}

export function registerFleetRoutes(app: FastifyInstance, deps: { hosts: Hosts; clock: Clock }): void {
  const { hosts, clock } = deps;

  app.get("/v1/fleet/hosts", async () => ({ hosts: await hosts.list() }));

  app.post("/v1/fleet/hosts/:id/drain", async (req) => {
    const id = uuidParam(req, "id", "host");
    return { host: toHost(await hosts.drain(id)) };
  });

  app.post("/v1/fleet/enrolment-tokens", async (req, reply) => {
    const body = CreateEnrolmentTokenRequest.parse(jsonBody(req));
    const created = await hosts.createEnrolmentToken({ ...body, now: clock() });
    // The token is in the response body only; it is never logged or stored in clear.
    return reply
      .status(201)
      .header("cache-control", "no-store")
      .send({ token: created.token, hostName: created.hostName, expiresAt: created.expiresAt.toISOString() });
  });
}
