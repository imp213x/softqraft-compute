/**
 * Agent job routes. Registered inside the agent-signed context, so
 * `req.agentHost` is the verified host.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { JobAttemptRequest, JobFailRequest } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import { jsonBody, type Clock } from "../../lib/http.js";
import { uuidParam } from "../../lib/params.js";
import type { Jobs } from "./index.js";

function hostOf(req: FastifyRequest): string {
  if (!req.agentHost) throw new HttpError(401, "agent_unauthenticated", "Agent request is not signed");
  return req.agentHost.id;
}

export function registerAgentJobRoutes(app: FastifyInstance, deps: { jobs: Jobs; clock: Clock }): void {
  const { jobs, clock } = deps;

  app.post("/v1/agent/jobs/claim", async (req) => {
    const hostId = hostOf(req);
    return { job: await jobs.claim(hostId, clock()) };
  });

  app.post("/v1/agent/jobs/:id/heartbeat", async (req) => {
    const hostId = hostOf(req);
    const id = uuidParam(req, "id", "job");
    const { attempt } = JobAttemptRequest.parse(jsonBody(req));
    const leaseExpiresAt = await jobs.heartbeat(hostId, id, attempt, clock());
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  });

  app.post("/v1/agent/jobs/:id/complete", async (req) => {
    const hostId = hostOf(req);
    const id = uuidParam(req, "id", "job");
    const { attempt } = JobAttemptRequest.parse(jsonBody(req));
    const job = await jobs.complete(hostId, id, attempt, clock());
    return { jobId: job.id, state: job.state };
  });

  app.post("/v1/agent/jobs/:id/fail", async (req) => {
    const hostId = hostOf(req);
    const id = uuidParam(req, "id", "job");
    const { attempt, error } = JobFailRequest.parse(jsonBody(req));
    const job = await jobs.fail(hostId, id, attempt, error, clock());
    return { jobId: job.id, state: job.state, attempt: job.attempt, maxAttempts: job.maxAttempts };
  });
}
