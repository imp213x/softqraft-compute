/**
 * Host routes: unsigned enrolment (the one-time token is the credential)
 * and the staff fleet routes under `/admin/v1/fleet/`, registered inside
 * the Admin operator-session guard. Viewers read; owners and admins write
 * (the guard enforces it, with the 15-minute freshness rule). Every write
 * is recorded as a security event in the same transaction as the change.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { CreateEnrolmentTokenRequest, EnrolRequest } from "@softqraft/compute-contracts";
import { jsonBody, type Clock } from "../../lib/http.js";
import { uuidParam } from "../../lib/params.js";
import { toHost, type HostAudit, type Hosts } from "./index.js";

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

/**
 * Builds the audit writer for one fleet request: the event is written in
 * the same transaction as the change (ids and names only).
 */
export type FleetAudit = (req: FastifyRequest, action: string, now: Date) => HostAudit;

export function registerFleetRoutes(
  app: FastifyInstance,
  deps: { hosts: Hosts; clock: Clock; audit: FleetAudit },
): void {
  const { hosts, clock, audit } = deps;

  app.get("/admin/v1/fleet/hosts", async () => ({ hosts: await hosts.list() }));

  app.post("/admin/v1/fleet/hosts/:id/drain", async (req) => {
    const id = uuidParam(req, "id", "host");
    const now = clock();
    const host = await hosts.drain(id, audit(req, "fleet.host_drain", now));
    return { host: toHost(host) };
  });

  // The kill switch.
  app.post("/admin/v1/fleet/hosts/:id/disable", async (req) => {
    const id = uuidParam(req, "id", "host");
    const now = clock();
    const { host, stopsQueued } = await hosts.disable(id, now, audit(req, "fleet.host_disable", now));
    return { host: toHost(host), stopsQueued };
  });

  app.post("/admin/v1/fleet/hosts/:id/enable", async (req) => {
    const id = uuidParam(req, "id", "host");
    const now = clock();
    const host = await hosts.enable(id, audit(req, "fleet.host_enable", now));
    return { host: toHost(host) };
  });

  app.post("/admin/v1/fleet/enrolment-tokens", async (req, reply) => {
    const body = CreateEnrolmentTokenRequest.parse(jsonBody(req));
    const now = clock();
    const created = await hosts.createEnrolmentToken({ ...body, now, audit: audit(req, "fleet.enrolment_token", now) });
    // The token is in this response only: never logged, stored only as a hash.
    return reply
      .status(201)
      .header("cache-control", "no-store")
      .send({ token: created.token, hostName: created.hostName, expiresAt: created.expiresAt.toISOString() });
  });
}
