/**
 * Service instances (cloud-federation-v1 §3.1, §3.4, §7.1).
 *
 * A service instance is what Cloud provisions when a project turns Compute
 * on. Compute keys instances, usage and quotas by its id and keeps the Cloud
 * organisation and project ids on it. Provisioning is idempotent: the same
 * id with the same organisation and project returns the existing record; a
 * different organisation or project is a conflict.
 */

import { createHash } from "node:crypto";
import type { ProvisionServiceInstanceRequest } from "@softqraft/compute-contracts";
import { ERROR_CODES } from "@softqraft/federation";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, ServiceInstanceRow } from "../../store/index.js";

export { registerServiceInstanceRoutes } from "./routes.js";

/** A host counts as healthy when it is active and was seen this recently. */
export const HEALTHY_HOST_SEEN_SECONDS = 300;

export type HealthStatus = "operational" | "degraded" | "unavailable" | "unknown";

export interface ServiceInstances {
  provision(
    id: string,
    body: ProvisionServiceInstanceRequest,
    now: Date,
  ): Promise<{ outcome: "created" | "existing"; serviceInstance: ServiceInstanceRow }>;
  get(id: string): Promise<ServiceInstanceRow | null>;
  /** The instance when it exists, else 404 `federation_unknown_instance`. */
  require(id: string): Promise<ServiceInstanceRow>;
  /** As `require`, and 409 `federation_instance_disabled` unless it is active. */
  requireActive(id: string): Promise<ServiceInstanceRow>;
  health(id: string, now: Date): Promise<{ status: HealthStatus; checkedAt: string }>;
}

/**
 * The tenant id reported in the contract's `mediaTenantId` field (§3.1,
 * §7.1). The field keeps the contract's name; the value follows the
 * contract's rule for new tenants: `cld_` + the first 12 hex characters of
 * sha256(serviceInstanceId). It is derived, so it never changes.
 */
export function tenantIdOf(serviceInstanceId: string): string {
  return `cld_${createHash("sha256").update(serviceInstanceId, "utf8").digest("hex").slice(0, 12)}`;
}

export const unknownInstance = () =>
  new HttpError(404, ERROR_CODES.UNKNOWN_INSTANCE, "Unknown service instance");

export function createServiceInstances(deps: { store: ComputeStore; regionId: string }): ServiceInstances {
  const { store } = deps;

  async function get(id: string): Promise<ServiceInstanceRow | null> {
    return store.transaction((tx) => tx.getServiceInstance(id));
  }

  async function requireOne(id: string): Promise<ServiceInstanceRow> {
    const row = await get(id);
    if (!row) throw unknownInstance();
    return row;
  }

  return {
    async provision(id, body, now) {
      if (body.regionId !== deps.regionId) {
        throw new HttpError(400, "validation_failed", `regionId must be ${deps.regionId}`);
      }
      return store.transaction(async (tx) => {
        const draft: ServiceInstanceRow = {
          id,
          cloudOrganisationId: body.cloudOrganisationId.toLowerCase(),
          cloudProjectId: body.cloudProjectId.toLowerCase(),
          displayName: body.displayName,
          regionId: body.regionId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        if (await tx.insertServiceInstance(draft)) return { outcome: "created" as const, serviceInstance: draft };
        const existing = await tx.getServiceInstance(id);
        if (!existing) throw new Error("service instance vanished during provisioning");
        if (
          existing.cloudOrganisationId !== draft.cloudOrganisationId ||
          existing.cloudProjectId !== draft.cloudProjectId
        ) {
          throw new HttpError(
            409,
            ERROR_CODES.LINK_CONFLICT,
            "Service instance is linked to a different organisation or project",
          );
        }
        return { outcome: "existing" as const, serviceInstance: existing };
      });
    },

    get,
    require: requireOne,

    async requireActive(id) {
      const row = await requireOne(id);
      if (row.status !== "active") {
        throw new HttpError(409, ERROR_CODES.INSTANCE_DISABLED, "Service instance is disabled");
      }
      return row;
    },

    async health(id, now) {
      const row = await requireOne(id);
      let status: HealthStatus;
      if (row.status !== "active") {
        status = "unavailable";
      } else {
        const hosts = await store.transaction((tx) => tx.listHosts());
        const cutoff = now.getTime() - HEALTHY_HOST_SEEN_SECONDS * 1000;
        const healthy = hosts.some(
          (h) => h.state === "active" && h.lastSeenAt !== null && h.lastSeenAt.getTime() >= cutoff,
        );
        status = healthy ? "operational" : "degraded";
      }
      return { status, checkedAt: now.toISOString() };
    },
  };
}
