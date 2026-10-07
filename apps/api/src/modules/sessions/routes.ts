/**
 * Session routes and guards.
 *
 * Cloud-signed (inside the Cloud context):
 *   POST /cloud/v1/service-instances/:id/console-launches   (§3.2)
 *   POST /cloud/v1/principals/:subject/revocations          (§3.3)
 *   POST /cloud/v1/operator-launches                        (§8.2, only while operator launch is on)
 *
 * Browser, same origin:
 *   POST /console/v1/auth/cloud-launch/redeem, /console/v1/auth/logout, GET /console/v1/auth/me
 *   POST /admin/v1/auth/cloud-launch/redeem,   /admin/v1/auth/logout,   GET /admin/v1/auth/me
 *
 * Cookies follow Realtime Media: HttpOnly, SameSite=Strict, Secure when the
 * public URL is https (COMPUTE_COOKIE_SECURE overrides), Path=/console or
 * Path=/admin, and Max-Age equal to the session's absolute lifetime
 * (8 hours, 1 hour). Sessions do not slide and are not idle-timed, as in
 * Media; a new launch issues a new token and ends the browser's previous
 * session. Cookie-authenticated mutations must carry this service's Origin.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import {
  CONSOLE_SESSION_TTL_SECONDS,
  ENDPOINTS,
  ERROR_CODES,
  FRESH_WRITE_SECONDS,
  OPERATOR_SESSION_TTL_SECONDS,
  SECURITY_EVENTS,
} from "@softqraft/federation";
import { ConsoleLaunchRequest, OperatorLaunchRequest, PRINCIPAL_SUBJECT_RE } from "@softqraft/compute-contracts";
import { requireSameOriginMutation } from "../../lib/browser.js";
import { parseCookies, serializeCookie } from "../../lib/cookies.js";
import { HttpError, sendError } from "../../lib/errors.js";
import { jsonBody, type Clock } from "../../lib/http.js";
import { serviceInstanceParam } from "../../lib/params.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import type { ServiceInstances } from "../service-instances/index.js";
import {
  ADMIN_COOKIE,
  COMPUTE_SESSION_POLICY,
  CONSOLE_COOKIE,
  CONSOLE_RETURN_PATHS,
  OPERATOR_RETURN_PATHS,
  consoleMayWrite,
  isSafeReturnPath,
  operatorMayWrite,
  type ConsoleSession,
  type OperatorSession,
  type Sessions,
} from "./index.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the Console guard on a valid Console session. */
    consoleSession?: ConsoleSession;
    /** Set by the Admin guard on a valid operator session. */
    operatorSession?: OperatorSession;
  }
}

/** Contract §4: 20 redemptions per minute per IP. */
const REDEEM_LIMIT = { max: 20, windowMs: 60_000 } as const;

const READ_METHODS = new Set(["GET", "HEAD"]);

export interface BrowserDeps {
  sessions: Sessions;
  clock: Clock;
  publicUrl: string | null;
  cookieSecure: boolean;
  limiter: RateLimiter;
}

function setCookie(
  reply: FastifyReply,
  name: string,
  path: string,
  token: string,
  secure: boolean,
  maxAgeSec: number,
  clear = false,
): void {
  reply.header(
    "Set-Cookie",
    serializeCookie(name, token, { httpOnly: true, secure, sameSite: "Strict", path, maxAgeSec, clear }),
  );
}

const returnPathError = (where: string) =>
  new HttpError(400, ERROR_CODES.RETURN_PATH, `returnPath must be a relative ${where} path`);

export function registerCloudLaunchRoutes(
  app: FastifyInstance,
  deps: { sessions: Sessions; serviceInstances: ServiceInstances; clock: Clock; operatorLaunch: boolean },
): void {
  const { sessions, serviceInstances, clock } = deps;

  app.post("/cloud/v1/service-instances/:serviceInstanceId/console-launches", async (req, reply) => {
    const serviceInstanceId = serviceInstanceParam(req);
    const body = ConsoleLaunchRequest.parse(jsonBody(req));
    await serviceInstances.requireActive(serviceInstanceId);
    if (!isSafeReturnPath(body.returnPath, CONSOLE_RETURN_PATHS)) throw returnPathError("/console/");
    const launch = await sessions.createConsoleLaunch({ serviceInstanceId, ...body, now: clock() });
    // The URL carries the grant in its fragment: never cache or log it.
    return reply
      .status(201)
      .header("cache-control", "no-store")
      .send({ launchUrl: launch.launchUrl, expiresAt: launch.expiresAt.toISOString() });
  });

  app.post("/cloud/v1/principals/:subject/revocations", async (req) => {
    const { subject } = req.params as { subject: string };
    if (!PRINCIPAL_SUBJECT_RE.test(subject)) throw new HttpError(400, "validation_failed", "Invalid subject");
    return { revokedSessions: await sessions.revoke(subject, clock()) };
  });

  if (deps.operatorLaunch) {
    app.post(ENDPOINTS.operatorLaunches, async (req, reply) => {
      const body = OperatorLaunchRequest.parse(jsonBody(req));
      if (!isSafeReturnPath(body.returnPath, OPERATOR_RETURN_PATHS)) throw returnPathError("/admin/ page");
      const launch = await sessions.createOperatorLaunch({ ...body, now: clock() });
      return reply
        .status(201)
        .header("cache-control", "no-store")
        .send({ launchUrl: launch.launchUrl, expiresAt: launch.expiresAt.toISOString() });
    });
  }
}

function takeRedeemBudget(req: FastifyRequest, deps: BrowserDeps, scope: string): void {
  if (!deps.limiter.take(scope, req.ip || "unknown", REDEEM_LIMIT.max, REDEEM_LIMIT.windowMs, deps.clock())) {
    throw new HttpError(429, "rate_limited", "Too many launch attempts. Try again shortly");
  }
}

function grantOf(req: FastifyRequest): unknown {
  const body = jsonBody(req);
  return body && typeof body === "object" ? (body as { grant?: unknown }).grant : undefined;
}

export function registerConsoleAuthRoutes(app: FastifyInstance, deps: BrowserDeps): void {
  const { sessions, clock } = deps;

  // Contract §4: redeem a one-time Console grant for a session cookie.
  app.post("/console/v1/auth/cloud-launch/redeem", async (req, reply) => {
    requireSameOriginMutation(req, deps.publicUrl);
    takeRedeemBudget(req, deps, "console-cloud-launch-ip");
    const grant = grantOf(req);
    const previous = parseCookies(req.headers.cookie)[CONSOLE_COOKIE];
    const { token, returnPath } = await sessions.redeemConsole(grant, clock());
    await sessions.endConsole(previous);
    setCookie(reply, CONSOLE_COOKIE, "/console", token, deps.cookieSecure, CONSOLE_SESSION_TTL_SECONDS);
    return reply.send({ returnPath });
  });

  app.post("/console/v1/auth/logout", async (req, reply) => {
    requireSameOriginMutation(req, deps.publicUrl);
    await sessions.endConsole(parseCookies(req.headers.cookie)[CONSOLE_COOKIE]);
    setCookie(reply, CONSOLE_COOKIE, "/console", "", deps.cookieSecure, 0, true);
    return reply.send({ ok: true });
  });
}

export function registerAdminAuthRoutes(app: FastifyInstance, deps: BrowserDeps): void {
  const { sessions, clock } = deps;

  // Contract §8.3: only `sqog_` grants are accepted here.
  app.post("/admin/v1/auth/cloud-launch/redeem", async (req, reply) => {
    requireSameOriginMutation(req, deps.publicUrl);
    takeRedeemBudget(req, deps, "admin-cloud-launch-ip");
    const grant = grantOf(req);
    const previous = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const { token, session, returnPath } = await sessions.redeemOperator(grant, clock());
    await sessions.endOperator(previous);
    setCookie(reply, ADMIN_COOKIE, "/admin", token, deps.cookieSecure, OPERATOR_SESSION_TTL_SECONDS);
    return reply.send({ returnPath, sessionExpiresAt: session.expiresAt.toISOString() });
  });

  app.post("/admin/v1/auth/logout", async (req, reply) => {
    requireSameOriginMutation(req, deps.publicUrl);
    await sessions.endOperator(parseCookies(req.headers.cookie)[ADMIN_COOKIE]);
    setCookie(reply, ADMIN_COOKIE, "/admin", "", deps.cookieSecure, 0, true);
    return reply.send({ ok: true });
  });
}

const signInAgain = () => new HttpError(401, "unauthorized", "Your session has ended. Open Compute again from SoftQraft");

/**
 * Console guard (§5): a valid Console session for this service instance.
 * Writes (anything but GET and HEAD) need this service's Origin and the
 * `developer` or `admin` role; `viewer` is read-only.
 */
export function consoleSessionGuard(deps: BrowserDeps): preHandlerAsyncHookHandler {
  return async function requireConsoleSession(req: FastifyRequest, reply: FastifyReply) {
    const write = !READ_METHODS.has(req.method);
    if (write) requireSameOriginMutation(req, deps.publicUrl);
    const session = await deps.sessions.resolveConsole(parseCookies(req.headers.cookie)[CONSOLE_COOKIE], deps.clock());
    if (!session) return sendError(req, reply, signInAgain());
    if (write && !consoleMayWrite(session.role)) {
      return sendError(req, reply, new HttpError(403, "forbidden", "Your role can view but not change"));
    }
    req.consoleSession = session;
  };
}

/**
 * Admin guard (§8.4): a valid operator session. Writes need this service's
 * Origin, the `owner` or `admin` role, and a session younger than
 * 15 minutes (403 `reauth_required`, recorded as
 * `auth.operator_reauth_required`).
 */
export function operatorSessionGuard(deps: BrowserDeps): preHandlerAsyncHookHandler {
  return async function requireOperatorSession(req: FastifyRequest, reply: FastifyReply) {
    const write = !READ_METHODS.has(req.method);
    if (write) requireSameOriginMutation(req, deps.publicUrl);
    const now = deps.clock();
    const session = await deps.sessions.resolveOperator(parseCookies(req.headers.cookie)[ADMIN_COOKIE], now);
    if (!session) return sendError(req, reply, signInAgain());
    if (write) {
      if (!operatorMayWrite(session.role)) {
        return sendError(req, reply, new HttpError(403, "forbidden", "Your role can view but not change"));
      }
      if (!COMPUTE_SESSION_POLICY.isFresh({ createdAt: session.createdAt, now })) {
        await deps.sessions.record(
          {
            action: SECURITY_EVENTS.operatorReauthRequired,
            subject: session.subject,
            sessionId: session.id,
            role: session.role,
          },
          now,
        );
        return sendError(
          req,
          reply,
          new HttpError(403, ERROR_CODES.REAUTH_REQUIRED, "Open Compute again from SoftQraft to make changes"),
        );
      }
    }
    req.operatorSession = session;
  };
}

/** Compute's security event for a Console delete refused by the 15-minute rule. */
export const CONSOLE_REAUTH_REQUIRED_EVENT = "auth.console_reauth_required";

/**
 * The 15-minute rule for Console deletes (founder, 2026-10-07): a route
 * preHandler, after the Console guard. A session whose sign-in (its
 * `createdAt`, which a new Cloud launch resets) is 15 minutes old or more
 * gets 403 `reauth_required`, recorded as `auth.console_reauth_required`.
 * The kit's `isFresh` decides, as for operator writes.
 */
export function consoleFreshGuard(deps: BrowserDeps): preHandlerAsyncHookHandler {
  return async function requireFreshConsoleSignIn(req: FastifyRequest, reply: FastifyReply) {
    const session = req.consoleSession;
    if (!session) return sendError(req, reply, signInAgain());
    const now = deps.clock();
    if (COMPUTE_SESSION_POLICY.isFresh({ createdAt: session.createdAt, now })) return;
    await deps.sessions.record(
      {
        action: CONSOLE_REAUTH_REQUIRED_EVENT,
        subject: session.subject,
        serviceInstanceId: session.serviceInstance.id,
        sessionId: session.id,
        role: session.role,
      },
      now,
    );
    return sendError(
      req,
      reply,
      new HttpError(403, ERROR_CODES.REAUTH_REQUIRED, "Sign in again to delete. Open Compute again from SoftQraft"),
    );
  };
}

const freshUntil = (createdAt: Date) => new Date(createdAt.getTime() + FRESH_WRITE_SECONDS * 1000).toISOString();

/** `GET /console/v1/auth/me`, inside the Console guard. */
export function registerConsoleMeRoute(app: FastifyInstance): void {
  app.get("/console/v1/auth/me", async (req) => {
    const s = req.consoleSession!;
    return {
      principal: { subject: s.subject, displayName: s.principal.displayName, email: s.principal.email },
      role: s.role,
      serviceInstance: { id: s.serviceInstance.id, displayName: s.serviceInstance.displayName, regionId: s.serviceInstance.regionId },
      session: { createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString(), freshUntil: freshUntil(s.createdAt) },
    };
  });
}

/** `GET /admin/v1/auth/me`, inside the Admin guard. */
export function registerAdminMeRoute(app: FastifyInstance): void {
  app.get("/admin/v1/auth/me", async (req) => {
    const s = req.operatorSession!;
    return {
      operator: { subject: s.subject, displayName: s.principal.displayName, email: s.principal.email, role: s.role },
      session: { createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString(), freshUntil: freshUntil(s.createdAt) },
    };
  });
}
