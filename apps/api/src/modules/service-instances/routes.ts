/**
 * §3.1 provision, §7.1 look up and §3.4 health. Registered inside the
 * Cloud-signed context, so every request here is already verified.
 */

import type { FastifyInstance } from "fastify";
import { ProvisionServiceInstanceRequest } from "@softqraft/compute-contracts";
import { jsonBody, type Clock } from "../../lib/http.js";
import { serviceInstanceParam } from "../../lib/params.js";
import { tenantIdOf, type ServiceInstances } from "./index.js";

export function registerServiceInstanceRoutes(
  app: FastifyInstance,
  deps: { serviceInstances: ServiceInstances; clock: Clock; publicUrl: string },
): void {
  const { serviceInstances, clock } = deps;

  app.put("/cloud/v1/service-instances/:serviceInstanceId", async (req, reply) => {
    const id = serviceInstanceParam(req);
    const body = ProvisionServiceInstanceRequest.parse(jsonBody(req));
    const { outcome, serviceInstance } = await serviceInstances.provision(id, body, clock());
    return reply.status(outcome === "created" ? 201 : 200).send({
      serviceInstanceId: serviceInstance.id,
      mediaTenantId: tenantIdOf(serviceInstance.id),
      status: serviceInstance.status,
      connection: { gatewayUrl: deps.publicUrl, regionId: serviceInstance.regionId },
    });
  });

  app.get("/cloud/v1/service-instances/:serviceInstanceId", async (req) => {
    const row = await serviceInstances.require(serviceInstanceParam(req));
    return {
      serviceInstanceId: row.id,
      mediaTenantId: tenantIdOf(row.id),
      status: row.status,
      origin: "cloud",
      cloudOrganisationId: row.cloudOrganisationId,
      cloudProjectId: row.cloudProjectId,
      displayName: row.displayName,
      regionId: row.regionId,
      createdAt: row.createdAt.toISOString(),
    };
  });

  app.get("/cloud/v1/service-instances/:serviceInstanceId/health", async (req) =>
    serviceInstances.health(serviceInstanceParam(req), clock()),
  );
}
