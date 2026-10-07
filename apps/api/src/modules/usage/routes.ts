/**
 * Usage routes: agent sample reports, the Console usage page (session) and
 * the Cloud read-only query (Cloud-signed). Both reads call `records`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { AgentUsageReport } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import { jsonBody, type Clock } from "../../lib/http.js";
import { serviceInstanceParam } from "../../lib/params.js";
import type { ServiceInstances } from "../service-instances/index.js";
import { MAX_QUERY_RANGE_MS, type Usage } from "./index.js";

function parseInstant(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new HttpError(400, "validation_failed", `Invalid request: ${name}`);
  return new Date(ms);
}

/** `from`/`to` query: the last 24 hours by default, at most 31 days. */
function range(req: FastifyRequest, clock: Clock): { from: Date; to: Date } {
  const query = req.query as Record<string, unknown>;
  const to = parseInstant(query.to, "to") ?? clock();
  const from = parseInstant(query.from, "from") ?? new Date(to.getTime() - 24 * 3_600_000);
  if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > MAX_QUERY_RANGE_MS) {
    throw new HttpError(400, "invalid_range", "from must be before to, and the range at most 31 days");
  }
  return { from, to };
}

async function report(usage: Usage, serviceInstanceId: string, from: Date, to: Date) {
  return {
    serviceInstanceId,
    from: from.toISOString(),
    to: to.toISOString(),
    records: await usage.records(serviceInstanceId, from, to),
  };
}

export function registerConsoleUsageRoutes(app: FastifyInstance, deps: { usage: Usage; clock: Clock }): void {
  app.get("/console/v1/usage", async (req) => {
    if (!req.consoleSession) throw new HttpError(401, "unauthorized", "Your session has ended");
    const { from, to } = range(req, deps.clock);
    return report(deps.usage, req.consoleSession.serviceInstance.id, from, to);
  });
}

export function registerCloudUsageRoutes(
  app: FastifyInstance,
  deps: { usage: Usage; clock: Clock; serviceInstances: ServiceInstances },
): void {
  app.get("/cloud/v1/service-instances/:serviceInstanceId/usage", async (req) => {
    const si = await deps.serviceInstances.require(serviceInstanceParam(req));
    const { from, to } = range(req, deps.clock);
    // Cloud reads the records from `usage` (C1c adapter).
    const { records, ...rest } = await report(deps.usage, si.id, from, to);
    return { ...rest, usage: records };
  });
}

export function registerAgentUsageRoutes(app: FastifyInstance, deps: { usage: Usage; clock: Clock }): void {
  app.post("/v1/agent/usage", async (req, reply) => {
    if (!req.agentHost) throw new HttpError(401, "agent_unauthenticated", "Agent request is not signed");
    const report = AgentUsageReport.parse(jsonBody(req));
    const result = await deps.usage.ingest(req.agentHost, report.samples, deps.clock());
    return reply.status(202).send(result);
  });
}
