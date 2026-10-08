/**
 * Builds the services and the Fastify app from injected dependencies.
 * `index.ts` supplies real ones; tests supply a memory store and a clock.
 *
 * Route contexts:
 * - probes: `/health`, `/ready`, no auth;
 * - agent: `/v1/agent/enrol` (one-time token), other `/v1/agent/*` signed by
 *   the host's key; all of them only from COMPUTE_AGENT_ALLOWED_IPS;
 * - Cloud (server): `/cloud/v1/*`, Cloud-signed (audience `compute`);
 * - Console (browser): `/console/v1/*`, a Console session cookie;
 * - Admin (browser, staff): `/admin/v1/*`, an operator session cookie;
 * - pages: `/console/` and `/admin/` (static, see the web module), in the
 *   same contexts as their APIs.
 * Cloud and Console exist only when CLOUD_FEDERATION_ENABLED=true, and
 * Admin and `/cloud/v1/operator-launches` only when
 * CLOUD_OPERATOR_LAUNCH_ENABLED=true as well; otherwise they are not
 * registered and answer 404, as if unrouted.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { DriverRegistry } from "@softqraft/compute-driver";
import { agentIpMatcher, type ComputeConfig } from "./config.js";
import { applyBrowserSecurityHeaders } from "./lib/browser.js";
import { HttpError, sendError, toHttpError } from "./lib/errors.js";
import { MAX_BODY_BYTES, registerRawBody, systemClock, type Clock } from "./lib/http.js";
import { MemoryRateLimiter, type RateLimiter } from "./lib/rate-limit.js";
import { agentAuth, agentIpGuard, cloudAuth } from "./modules/auth/index.js";
import { registerHealthRoutes } from "./modules/health/index.js";
import { createHosts, registerEnrolRoute, registerFleetRoutes, type FleetAudit, type Hosts } from "./modules/hosts/index.js";
import { createImages, registerConsoleImageRoutes, type Images } from "./modules/images/index.js";
import {
  createInstances,
  InvalidTransitionError,
  registerCloudInstanceRoutes,
  registerConsoleInstanceRoutes,
  registerFleetInstanceRoutes,
  type Instances,
} from "./modules/instances/index.js";
import { createIpam } from "./modules/ipam/index.js";
import { createJobs, registerAgentJobRoutes, type Jobs } from "./modules/jobs/index.js";
import { createQuotas, registerConsoleSizeRoutes, type Quotas } from "./modules/quotas/index.js";
import { createScheduler } from "./modules/scheduler/index.js";
import {
  createServiceInstances,
  registerServiceInstanceRoutes,
  type ServiceInstances,
} from "./modules/service-instances/index.js";
import { createSshKeys, registerConsoleSshKeyRoutes, type SshKeys } from "./modules/ssh-keys/index.js";
import { registerAdminWebRoutes, registerConsoleWebRoutes } from "./modules/web/index.js";
import {
  consoleFreshGuard,
  consoleSessionGuard,
  createSessions,
  operatorSessionGuard,
  registerAdminAuthRoutes,
  registerAdminMeRoute,
  registerCloudLaunchRoutes,
  registerConsoleAuthRoutes,
  registerConsoleMeRoute,
  type BrowserDeps,
  type Sessions,
} from "./modules/sessions/index.js";
import {
  createUsage,
  registerAgentUsageRoutes,
  registerCloudUsageRoutes,
  registerConsoleUsageRoutes,
  type Usage,
} from "./modules/usage/index.js";
import type { ComputeStore } from "./store/index.js";

export interface AppDeps {
  config: ComputeConfig;
  store: ComputeStore;
  drivers: DriverRegistry;
  clock?: Clock;
  /** Real-time pause between console polls (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
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
  serviceInstances: ServiceInstances;
  sessions: Sessions;
  sshKeys: SshKeys;
  /** Periodic work: expired leases, pending placement, old nonces, grants, sessions and results. */
  maintenance(now: Date): Promise<void>;
}

/** The URL launch links point at: COMPUTE_PUBLIC_URL, or the local listener. */
export function publicBase(config: ComputeConfig): string {
  return config.publicUrl ?? `http://127.0.0.1:${config.port}`;
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
    defaultDiskGb: config.defaultDiskGb,
    consoleWaitMs: config.consoleWaitSeconds * 1000,
    sleep: deps.sleep,
    driverCapabilities: (name) => drivers.capabilities(name),
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
    onDisable: (tx, hostId, now) => instances.stopAllOnHost(tx, hostId, now),
  });
  const usage = createUsage({ store });
  const serviceInstances = createServiceInstances({ store, regionId: config.regionId });
  const sessions = createSessions({ store, publicUrl: publicBase(config) });
  const sshKeys = createSshKeys({ store });
  const readyJobs = jobs;

  return {
    images,
    quotas,
    instances,
    jobs: readyJobs,
    hosts,
    usage,
    serviceInstances,
    sessions,
    sshKeys,
    async maintenance(now) {
      await readyJobs.reapExpiredLeases(now);
      await instances.placePending(now);
      await readyJobs.clearStaleResults(now);
      await sessions.prune(now);
      await store.transaction((tx) => tx.pruneNonces(now));
    },
  };
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; services: Services }> {
  const clock = deps.clock ?? systemClock;
  const services = buildServices(deps);
  const { config, store } = deps;
  const limiter: RateLimiter = new MemoryRateLimiter();

  const app = Fastify({
    logger:
      config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            // Belt and braces: request and response headers (cookies,
            // signatures, Set-Cookie) are never logged.
            redact: ["req.headers", "res.headers"],
            ...(deps.logStream ? { stream: deps.logStream } : {}),
          },
    bodyLimit: MAX_BODY_BYTES,
    genReqId: () => randomUUID(),
    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
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
    // F3: only the allowed host IPs reach enrolment and every /v1/agent/ route.
    agent.addHook(
      "onRequest",
      agentIpGuard({
        allowed: agentIpMatcher(config.agentAllowedIps),
        record: (event, now) => services.sessions.record(event, now),
        limiter,
        clock,
      }),
    );
    registerEnrolRoute(agent, { hosts: services.hosts, clock, jobSigningKeys: () => services.jobs.publicKeys() });
    await agent.register(async (signed) => {
      signed.addHook("preHandler", agentAuth({ store, hosts: services.hosts, clock }));
      registerAgentJobRoutes(signed, { jobs: services.jobs, clock });
      registerAgentUsageRoutes(signed, { usage: services.usage, clock });
    });
  });

  if (config.federation.enabled) {
    const publicKeys = config.federation.publicKeys;
    const operatorLaunch = config.federation.operatorLaunch;

    // Cloud (server to server): every request Cloud-signed.
    await app.register(async (cloud) => {
      cloud.addHook("preHandler", cloudAuth({ publicKeys, store, clock }));
      registerServiceInstanceRoutes(cloud, {
        serviceInstances: services.serviceInstances,
        clock,
        publicUrl: publicBase(config),
      });
      registerCloudLaunchRoutes(cloud, {
        sessions: services.sessions,
        serviceInstances: services.serviceInstances,
        clock,
        operatorLaunch,
      });
      registerCloudInstanceRoutes(cloud, { instances: services.instances, serviceInstances: services.serviceInstances });
      registerCloudUsageRoutes(cloud, { usage: services.usage, clock, serviceInstances: services.serviceInstances });
    });

    const browser: BrowserDeps = {
      sessions: services.sessions,
      clock,
      publicUrl: config.publicUrl,
      cookieSecure: config.cookieSecure,
      limiter,
    };

    const web = { cloudOrigin: config.cloudOrigin, hostRunbookUrl: config.hostRunbookUrl };

    // Console (customer browser, same origin).
    await app.register(async (consoleApp) => {
      consoleApp.addHook("onSend", async (_req, reply, payload) => {
        applyBrowserSecurityHeaders(reply);
        return payload;
      });
      registerConsoleWebRoutes(consoleApp, web);
      registerConsoleAuthRoutes(consoleApp, browser);
      await consoleApp.register(async (guarded) => {
        guarded.addHook("preHandler", consoleSessionGuard(browser));
        registerConsoleMeRoute(guarded);
        registerConsoleInstanceRoutes(guarded, {
          instances: services.instances,
          clock,
          requireFreshSignIn: consoleFreshGuard(browser),
        });
        registerConsoleImageRoutes(guarded, services.images);
        registerConsoleSizeRoutes(guarded, { quotas: services.quotas, defaultDiskGb: config.defaultDiskGb });
        registerConsoleSshKeyRoutes(guarded, { sshKeys: services.sshKeys, clock });
        registerConsoleUsageRoutes(guarded, { usage: services.usage, clock });
      });
    });

    // Admin (staff browser, same origin), only while operator launch is on.
    if (operatorLaunch) {
      const audit: FleetAudit = (req, action, now) => async (tx, detail) => {
        const s = req.operatorSession;
        await services.sessions.recordIn(
          tx,
          { action, subject: s?.subject ?? null, sessionId: s?.id ?? null, role: s?.role ?? null, detail },
          now,
        );
      };
      await app.register(async (adminApp) => {
        adminApp.addHook("onSend", async (_req, reply, payload) => {
          applyBrowserSecurityHeaders(reply);
          return payload;
        });
        registerAdminWebRoutes(adminApp, web);
        registerAdminAuthRoutes(adminApp, browser);
        await adminApp.register(async (guarded) => {
          guarded.addHook("preHandler", operatorSessionGuard(browser));
          registerAdminMeRoute(guarded);
          registerFleetRoutes(guarded, { hosts: services.hosts, clock, audit });
          registerFleetInstanceRoutes(guarded, { instances: services.instances });
        });
      });
    }
  }

  return { app, services };
}
