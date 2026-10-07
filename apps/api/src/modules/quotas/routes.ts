/** `GET /console/v1/sizes`, inside the Console session guard: the Create screen's presets. */

import type { FastifyInstance } from "fastify";
import type { Quotas } from "./index.js";

export function registerConsoleSizeRoutes(app: FastifyInstance, deps: { quotas: Quotas; defaultDiskGb: number }): void {
  app.get("/console/v1/sizes", async () => deps.quotas.sizes(deps.defaultDiskGb));
}
