/**
 * Sessions: cloud-federation-v1 launches, redemption, sessions and
 * revocation (§3.2, §3.3, §4, §5, §8.2 to §8.4), mirroring Realtime Media.
 *
 * - Console launch (§3.2): Cloud asks for a one-time `sqlg_` grant for a
 *   principal, a service instance and a role (admin, developer, viewer).
 *   The browser redeems it at `/console/v1/auth/cloud-launch/redeem` and
 *   receives an `sqcs_` session cookie, scoped to that service instance and
 *   role, valid 8 hours (absolute).
 * - Operator launch (§8.2): the same for staff, with `sqog_` grants in a
 *   separate store, redeemed at `/admin/v1/auth/cloud-launch/redeem` for an
 *   `sqos_` session, valid 1 hour (absolute). Roles owner, admin, viewer.
 * - Revocation (§3.3): `revoked_after = now`, and every Console and operator
 *   session of that principal ends.
 *
 * The decisions (grant format, expiry, revocation, freshness, return
 * paths) are the vendored kit's. Grants and tokens are stored only as
 * SHA-256 hashes and are never logged.
 */

import { randomUUID } from "node:crypto";
import {
  CONSOLE_SESSION_TTL_SECONDS,
  GRANT_TTL_SECONDS,
  OPERATOR_SESSION_TTL_SECONDS,
  SECURITY_EVENTS,
  hashSessionToken,
  isFresh,
  isSessionValid,
  mintGrant,
  mintSessionToken,
  operatorRoleCanWrite,
  parseGrant,
  parseSessionToken,
  validateReturnPath,
  type GrantKind,
  type ReturnPathOptions,
} from "@softqraft/federation";
import type { CloudPrincipal, ConsoleRole, OperatorRole } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import type {
  ComputeStore,
  ConsoleSessionRow,
  OperatorSessionRow,
  PrincipalRow,
  ServiceInstanceRow,
  StoreTx,
} from "../../store/index.js";

export {
  CONSOLE_REAUTH_REQUIRED_EVENT,
  consoleFreshGuard,
  consoleSessionGuard,
  operatorSessionGuard,
  registerAdminAuthRoutes,
  registerCloudLaunchRoutes,
  registerAdminMeRoute,
  registerConsoleAuthRoutes,
  registerConsoleMeRoute,
  type BrowserDeps,
} from "./routes.js";

/** Compute's session policy: the kit's pure functions (§5, §8.4), run by the §9 conformance test. */
export const COMPUTE_SESSION_POLICY = Object.freeze({ isSessionValid, isFresh });

export const CONSOLE_BASE_PATH = "/console";
export const CONSOLE_API_PREFIX = "/console/v1/";
export const ADMIN_BASE_PATH = "/admin";
export const ADMIN_API_PREFIX = "/admin/v1/";

/** Cookie names. Paths, flags and lifetimes follow Media (see routes.ts). */
export const CONSOLE_COOKIE = "sq_console_session";
export const ADMIN_COOKIE = "sq_admin_session";

/** §3.2: `/console/…`, no `//`, `\`, scheme, host, dot segments or encoded separators. */
export const CONSOLE_RETURN_PATHS: ReturnPathOptions = Object.freeze({ basePath: CONSOLE_BASE_PATH });
/** §8.2: `/admin/…`, never under the Admin API prefix `/admin/v1/`. */
export const OPERATOR_RETURN_PATHS: ReturnPathOptions = Object.freeze({
  basePath: ADMIN_BASE_PATH,
  forbiddenPrefixes: Object.freeze([ADMIN_API_PREFIX]),
});

/** Compute's return-path check (the kit's validator), as the conformance runner calls it. */
export function isSafeReturnPath(path: unknown, options: ReturnPathOptions): boolean {
  return validateReturnPath(path, options);
}

/**
 * Compute's grant parser: the storage hash of a presented grant of exactly
 * one kind, or null. A Console grant never parses as an operator grant and
 * the other way round (§8.3).
 */
export function parsePresentedGrant(value: unknown, kind: GrantKind): string | null {
  return parseGrant(value, kind);
}

export interface ConsoleSession {
  id: string;
  subject: string;
  role: ConsoleRole;
  serviceInstance: ServiceInstanceRow;
  principal: PrincipalRow;
  createdAt: Date;
  expiresAt: Date;
}

export interface OperatorSession {
  id: string;
  subject: string;
  role: OperatorRole;
  principal: PrincipalRow;
  createdAt: Date;
  expiresAt: Date;
}

export interface SecurityEvent {
  action: string;
  subject?: string | null;
  serviceInstanceId?: string | null;
  sessionId?: string | null;
  role?: string | null;
  /** Ids and names only. Never a grant, token, cookie or signature. */
  detail?: Record<string, string> | null;
}

export interface Sessions {
  createConsoleLaunch(input: {
    serviceInstanceId: string;
    principal: CloudPrincipal;
    role: ConsoleRole;
    returnPath: string;
    now: Date;
  }): Promise<{ launchUrl: string; expiresAt: Date }>;
  createOperatorLaunch(input: {
    principal: CloudPrincipal;
    role: OperatorRole;
    returnPath: string;
    now: Date;
  }): Promise<{ launchUrl: string; expiresAt: Date }>;
  /** §3.3. Returns how many unexpired sessions ended. */
  revoke(subject: string, now: Date): Promise<number>;
  /** §4: consume a Console grant and open a session. 401 `launch_invalid` on any failure. */
  redeemConsole(grant: unknown, now: Date): Promise<{ token: string; session: ConsoleSession; returnPath: string }>;
  /** §8.3: consume an operator grant and open an operator session. 401 `launch_invalid` on any failure. */
  redeemOperator(grant: unknown, now: Date): Promise<{ token: string; session: OperatorSession; returnPath: string }>;
  /** A valid Console session for a cookie value, or null (§5). */
  resolveConsole(token: string | undefined, now: Date): Promise<ConsoleSession | null>;
  /** A valid operator session for a cookie value, or null (§8.4). */
  resolveOperator(token: string | undefined, now: Date): Promise<OperatorSession | null>;
  endConsole(token: string | undefined): Promise<void>;
  endOperator(token: string | undefined): Promise<void>;
  record(event: SecurityEvent, now: Date): Promise<void>;
  /** Write a security event inside the caller's transaction. */
  recordIn(tx: StoreTx, event: SecurityEvent, now: Date): Promise<void>;
  /** Drop expired grants and sessions. */
  prune(now: Date): Promise<number>;
}

const launchInvalid = () => new HttpError(401, "launch_invalid", "This launch link is invalid or has expired");

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

/** True when an operator role may write. `viewer` never may (§8.2). */
export function operatorMayWrite(role: OperatorRole): boolean {
  return operatorRoleCanWrite(role);
}

/** True when a Console role may write. `viewer` reads only. */
export function consoleMayWrite(role: ConsoleRole): boolean {
  return role === "admin" || role === "developer";
}

export function createSessions(deps: { store: ComputeStore; publicUrl: string }): Sessions {
  const { store } = deps;

  async function insertEvent(tx: StoreTx, event: SecurityEvent, now: Date): Promise<void> {
    await tx.insertSecurityEvent({
      id: randomUUID(),
      action: event.action,
      subject: event.subject ?? null,
      serviceInstanceId: event.serviceInstanceId ?? null,
      sessionId: event.sessionId ?? null,
      role: event.role ?? null,
      detail: event.detail ?? null,
      createdAt: now,
    });
  }

  function consoleValid(row: ConsoleSessionRow, principal: PrincipalRow | null, si: ServiceInstanceRow | null, now: Date) {
    if (!principal || !si || si.status !== "active") return false;
    return COMPUTE_SESSION_POLICY.isSessionValid({
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ttlSeconds: CONSOLE_SESSION_TTL_SECONDS,
      revokedAfter: principal.revokedAfter,
      now,
    });
  }

  function operatorValid(row: OperatorSessionRow, principal: PrincipalRow | null, now: Date) {
    if (!principal) return false;
    return COMPUTE_SESSION_POLICY.isSessionValid({
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ttlSeconds: OPERATOR_SESSION_TTL_SECONDS,
      revokedAfter: principal.revokedAfter,
      now,
    });
  }

  return {
    async createConsoleLaunch({ serviceInstanceId, principal, role, returnPath, now }) {
      const minted = mintGrant("console", { now, ttlSeconds: GRANT_TTL_SECONDS });
      await store.transaction(async (tx) => {
        await tx.upsertPrincipal(principal, now);
        await tx.insertConsoleGrant({
          grantHash: minted.hash,
          serviceInstanceId,
          subject: principal.subject,
          role,
          returnPath,
          expiresAt: minted.expiresAt,
          usedAt: null,
          createdAt: now,
        });
      });
      return { launchUrl: `${deps.publicUrl}${CONSOLE_BASE_PATH}/launch#grant=${minted.grant}`, expiresAt: minted.expiresAt };
    },

    async createOperatorLaunch({ principal, role, returnPath, now }) {
      const minted = mintGrant("operator", { now, ttlSeconds: GRANT_TTL_SECONDS });
      await store.transaction(async (tx) => {
        await tx.upsertPrincipal(principal, now);
        await tx.insertOperatorGrant({
          grantHash: minted.hash,
          subject: principal.subject,
          role,
          returnPath,
          expiresAt: minted.expiresAt,
          usedAt: null,
          createdAt: now,
        });
      });
      return { launchUrl: `${deps.publicUrl}${ADMIN_BASE_PATH}/launch#grant=${minted.grant}`, expiresAt: minted.expiresAt };
    },

    async revoke(subject, now) {
      return store.transaction((tx) => tx.revokePrincipal(subject, now));
    },

    async redeemConsole(grant, now) {
      // Only `sqlg_` grants parse here; `sqog_` and `sqlk_` never do (§8.3).
      const grantHash = parsePresentedGrant(grant, "console");
      if (!grantHash) throw launchInvalid();
      const minted = mintSessionToken("console");
      // The grant is marked used and the session created in one
      // transaction. A grant whose service instance is gone or disabled is
      // still used up: one generic failure for every case (§4).
      const session = await store.transaction(async (tx) => {
        const row = await tx.redeemConsoleGrant(grantHash, now);
        if (!row) return null;
        const si = await tx.getServiceInstance(row.serviceInstanceId);
        const principal = await tx.getPrincipal(row.subject);
        if (!si || si.status !== "active" || !principal) return null;
        const created: ConsoleSessionRow = {
          id: randomUUID(),
          tokenHash: minted.hash,
          subject: row.subject,
          serviceInstanceId: si.id,
          role: row.role,
          createdAt: now,
          expiresAt: addSeconds(now, CONSOLE_SESSION_TTL_SECONDS),
          lastSeenAt: now,
        };
        await tx.insertConsoleSession(created);
        await insertEvent(
          tx,
          {
            action: SECURITY_EVENTS.cloudLaunch,
            subject: row.subject,
            serviceInstanceId: si.id,
            sessionId: created.id,
            role: row.role,
          },
          now,
        );
        const session: ConsoleSession = {
          id: created.id,
          subject: created.subject,
          role: created.role,
          serviceInstance: si,
          principal,
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
        };
        return { session, returnPath: row.returnPath };
      });
      if (!session) throw launchInvalid();
      return { token: minted.token, ...session };
    },

    async redeemOperator(grant, now) {
      // Only `sqog_` grants parse here; `sqlg_` and `sqlk_` never do (§8.3).
      const grantHash = parsePresentedGrant(grant, "operator");
      if (!grantHash) throw launchInvalid();
      const minted = mintSessionToken("operator");
      const result = await store.transaction(async (tx) => {
        const row = await tx.redeemOperatorGrant(grantHash, now);
        if (!row) return null;
        const principal = await tx.getPrincipal(row.subject);
        if (!principal) return null;
        const created: OperatorSessionRow = {
          id: randomUUID(),
          tokenHash: minted.hash,
          subject: row.subject,
          role: row.role,
          createdAt: now,
          expiresAt: addSeconds(now, OPERATOR_SESSION_TTL_SECONDS),
          lastSeenAt: now,
        };
        await tx.insertOperatorSession(created);
        await insertEvent(
          tx,
          { action: SECURITY_EVENTS.operatorLaunch, subject: row.subject, sessionId: created.id, role: row.role },
          now,
        );
        const session: OperatorSession = {
          id: created.id,
          subject: created.subject,
          role: created.role,
          principal,
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
        };
        return { session, returnPath: row.returnPath };
      });
      if (!result) throw launchInvalid();
      return { token: minted.token, ...result };
    },

    async resolveConsole(token, now) {
      const tokenHash = parseSessionToken(token, "console");
      if (!tokenHash) return null;
      return store.transaction(async (tx) => {
        const row = await tx.getConsoleSession(tokenHash);
        if (!row) return null;
        const principal = await tx.getPrincipal(row.subject);
        const si = await tx.getServiceInstance(row.serviceInstanceId);
        if (!consoleValid(row, principal, si, now)) return null;
        await tx.touchConsoleSession(row.id, now);
        return {
          id: row.id,
          subject: row.subject,
          role: row.role,
          serviceInstance: si!,
          principal: principal!,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        };
      });
    },

    async resolveOperator(token, now) {
      const tokenHash = parseSessionToken(token, "operator");
      if (!tokenHash) return null;
      return store.transaction(async (tx) => {
        const row = await tx.getOperatorSession(tokenHash);
        if (!row) return null;
        const principal = await tx.getPrincipal(row.subject);
        if (!operatorValid(row, principal, now)) return null;
        await tx.touchOperatorSession(row.id, now);
        return {
          id: row.id,
          subject: row.subject,
          role: row.role,
          principal: principal!,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        };
      });
    },

    async endConsole(token) {
      if (!token) return;
      await store.transaction((tx) => tx.deleteConsoleSession(hashSessionToken(token)));
    },

    async endOperator(token) {
      if (!token) return;
      await store.transaction((tx) => tx.deleteOperatorSession(hashSessionToken(token)));
    },

    async record(event, now) {
      await store.transaction((tx) => insertEvent(tx, event, now));
    },

    async recordIn(tx, event, now) {
      await insertEvent(tx, event, now);
    },

    async prune(now) {
      return store.transaction((tx) => tx.pruneFederation(now));
    },
  };
}
