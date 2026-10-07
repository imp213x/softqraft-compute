/** Usage routes: agent sample reports and the Cloud-facing project query. */

import type { FastifyInstance } from "fastify";
import { AgentUsageReport } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import { jsonBody, type Clock } from "../../lib/http.js";
import { uuidParam } from "../../lib/params.js";
import { MAX_QUERY_RANGE_MS, type Usage } from "./index.js";

function parseInstant(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new HttpError(400, "validation_failed", `Invalid request: ${name}`);
  return new Date(ms);
}

export function registerUsageRoutes(app: FastifyInstance, deps: { usage: Usage; clock: Clock }): void {
  app.get("/v1/projects/:projectId/usage", async (req) => {
    const projectId = uuidParam(req, "projectId", "project");
    const query = req.query as Record<string, unknown>;
    const to = parseInstant(query.to, "to") ?? deps.clock();
    const from = parseInstant(query.from, "from") ?? new Date(to.getTime() - 24 * 3_600_000);
    if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > MAX_QUERY_RANGE_MS) {
      throw new HttpError(400, "invalid_range", "from must be before to, and the range at most 31 days");
    }
    return {
      projectId,
      from: from.toISOString(),
      to: to.toISOString(),
      records: await deps.usage.records(projectId, from, to),
    };
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
