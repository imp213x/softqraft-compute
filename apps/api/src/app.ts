/**
 * Builds the services and the Fastify app from injected dependencies.
 * `index.ts` supplies real ones; tests supply a memory store and a clock.
 *
 * Route contexts:
 * - probes: `/health`, `/ready`, no auth;
 * - agent: `/v1/agent/enrol` (one-time token), other `/v1/agent/*` signed by
 *   the host's key;
 * - Cloud-facing: projects, images and usage, Cloud-signed, registered only
 *   when CLOUD_FEDERATION_ENABLED=true (otherwise 404, as if unrouted);
 * - fleet: inside the Cloud context, plus an operator check.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { DriverRegistry } from "@softqraft/compute-driver";
import type { ComputeConfig } from "./config.js";
import { HttpError, sendError, toHttpError } from "./lib/errors.js";
import { MAX_BODY_BYTES, registerRawBody, systemClock, type Clock } from "./lib/http.js";
import { agentAuth, cloudAuth, denyAllOperators, operatorAuth, type OperatorAuthorizer } from "./modules/auth/index.js";
import { registerHealthRoutes } from "./modules/health/index.js";
import { createHosts, registerEnrolRoute, registerFleetRoutes, type Hosts } from "./modules/hosts/index.js";
import { createImages, registerImageRoutes, type Images } from "./modules/images/index.js";
import {
  createInstances,
  InvalidTransitionError,
  registerInstanceRoutes,
  type Instances,
} from "./modules/instances/index.js";
import { createIpam } from "./modules/ipam/index.js";
import { createJobs, registerAgentJobRoutes, type Jobs } from "./modules/jobs/index.js";
import { createQuotas, type Quotas } from "./modules/quotas/index.js";
import { createScheduler } from "./modules/scheduler/index.js";
import { createUsage, registerAgentUsageRoutes, registerUsageRoutes, type Usage } from "./modules/usage/index.js";
import type { ComputeStore } from "./store/index.js";

export interface AppDeps {
  config: ComputeConfig;
  store: ComputeStore;
  drivers: DriverRegistry;
  clock?: Clock;
  /** Fleet route authoriser. Defaults to deny-all (see modules/auth). */
  operatorAuthorizer?: OperatorAuthorizer;
  /** Where logs go (tests capture them). Defaults to stdout. */
  logStream?: { write(line: string): void };
}

export interface Services {
  images: Images;
  quotas: Quotas;
  instances: Instances;
  jobs: Jobs;
  hosts: Hosts;
  usage: Usage;
  /** Periodic work: expired leases, pending placement, old nonces. */
  maintenance(now: Date): Promise<void>;
}

export function buildServices(deps: AppDeps): Services {
  const { config, store, drivers } = deps;
  const images = createImages();
  const quotas = createQuotas({ caps: config.pool, allowedProjects: config.allowedProjects });
  const scheduler = createScheduler();
  const ipam = createIpam({ cidr: config.pilotCidr });

  let jobs: Jobs | undefined;
  const instances = createInstances({
    store,
    quotas,
    scheduler,
    ipam,
    images,
    jobs: () => {
      if (!jobs) throw new Error("jobs module is not ready");
      return jobs;
    },
  });
  jobs = createJobs({
    store,
    signing: config.jobSigning,
    maxAttempts: config.jobMaxAttempts,
    leaseSeconds: config.jobLeaseSeconds,
    envelopeTtlSeconds: config.jobEnvelopeTtlSeconds,
    outcomes: instances.jobOutcomes,
    beforeClaim: async (now) => {
      await instances.placePending(now);
    },
  });
  const hosts = createHosts({
    store,
    isKnownDriver: (name) => drivers.has(name),
    defaultTokenTtlSeconds: config.enrolmentTokenTtlSeconds,
  });
  const usage = createUsage({ store });
  const readyJobs = jobs;

  return {
    images,
    quotas,
    instances,
    jobs: readyJobs,
    hosts,
    usage,
    async maintenance(now) {
      await readyJobs.reapExpiredLeases(now);
      await instances.placePending(now);
      await store.transaction((tx) => tx.pruneNonces(now));
    },
  };
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; services: Services }> {
  const clock = deps.clock ?? systemClock;
  const services = buildServices(deps);
  const { config, store } = deps;

  const app = Fastify({
    logger:
      config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            // Belt and braces: request headers are not logged by default.
            redact: ["req.headers", "res.headers"],
            ...(deps.logStream ? { stream: deps.logStream } : {}),
          },
    bodyLimit: MAX_BODY_BYTES,
    genReqId: () => randomUUID(),
  });

  registerRawBody(app);

  app.setErrorHandler((err, req, reply) => {
    const http =
      toHttpError(err) ??
      (err instanceof InvalidTransitionError ? new HttpError(409, "invalid_state", err.message) : null);
    if (http) return sendError(req, reply, http);
    // Log the error class and message only: never bodies, headers or keys.
    req.log.error({ err: { type: (err as Error)?.name, message: (err as Error)?.message } }, "request failed");
    return sendError(req, reply, new HttpError(500, "internal_error", "Something went wrong"));
  });

  app.setNotFoundHandler((req, reply) => sendError(req, reply, new HttpError(404, "not_found", "Not found")));

  registerHealthRoutes(app, { store });

  await app.register(async (agent) => {
    registerEnrolRoute(agent, { hosts: services.hosts, clock, jobSigningKeys: () => services.jobs.publicKeys() });
    await agent.register(async (signed) => {
      signed.addHook("preHandler", agentAuth({ store, hosts: services.hosts, clock }));
      registerAgentJobRoutes(signed, { jobs: services.jobs, clock });
      registerAgentUsageRoutes(signed, { usage: services.usage, clock });
    });
  });

  if (config.federation.enabled) {
    const publicKeys = config.federation.publicKeys;
    await app.register(async (cloud) => {
      cloud.addHook("preHandler", cloudAuth({ publicKeys, store, clock }));
      registerInstanceRoutes(cloud, { instances: services.instances, clock });
      registerImageRoutes(cloud, services.images);
      registerUsageRoutes(cloud, { usage: services.usage, clock });
      await cloud.register(async (fleet) => {
        fleet.addHook("preHandler", operatorAuth(deps.operatorAuthorizer ?? denyAllOperators));
        registerFleetRoutes(fleet, { hosts: services.hosts, clock });
      });
    });
  }

  return { app, services };
}
