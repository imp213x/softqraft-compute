/** Probes: `/health` (the process is up) and `/ready` (the database answers). */

import type { FastifyInstance } from "fastify";
import type { ComputeStore } from "../../store/index.js";

export function registerHealthRoutes(app: FastifyInstance, deps: { store: ComputeStore }): void {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    try {
      await deps.store.ping();
      return { status: "ready", store: deps.store.kind };
    } catch {
      return reply.status(503).send({ status: "not_ready", store: deps.store.kind });
    }
  });
}
