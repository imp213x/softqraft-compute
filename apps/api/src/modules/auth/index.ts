/**
 * Auth: who may call which route.
 *
 * - `/cloud/v1/*`: Cloud-signed requests (cloud-federation-v1 §2, audience
 *   `compute`), verified by the vendored @softqraft/federation kit. Off
 *   unless CLOUD_FEDERATION_ENABLED=true; when off, the routes are not
 *   registered at all and answer 404.
 * - Agent routes: each host signs with its own enrolled Ed25519 key. Body
 *   hash, a timestamp within 300 s and a single-use nonce are checked. A
 *   disabled host still authenticates, so that it can claim the stop jobs
 *   the kill switch queued (the jobs module gives it nothing else).
 * - Console and Admin (browser) routes use Console and operator sessions;
 *   see the sessions module.
 *
 * Nothing here logs headers, signatures, keys or bodies.
 */

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { KeyObject } from "node:crypto";
import { verifyRequest, type NonceStore } from "@softqraft/federation";
import {
  AGENT_NONCE_TTL_SECONDS,
  agentTimestampFresh,
  loadPublicKey,
  parseAgentHeaders,
  verifyAgentSignature,
} from "@softqraft/compute-jobs";
import { HttpError, sendError } from "../../lib/errors.js";
import type { Clock } from "../../lib/http.js";
import type { ComputeStore, HostRow } from "../../store/index.js";
import type { Hosts } from "../hosts/index.js";

/** Compute's audience id in the Cloud service registry (contract §8.1). */
export const FEDERATION_AUDIENCE = "compute";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by agent auth on a verified agent request. */
    agentHost?: HostRow;
    /** Set by Cloud auth on a verified Cloud request. */
    cloudKeyId?: string;
  }
}

/** Federation nonces live in the store, so replay protection survives restarts. */
export function storeNonceStore(store: ComputeStore): NonceStore {
  return {
    claim: (nonce, ttlSeconds, now) =>
      store.transaction((tx) =>
        tx.claimNonce("cloud", nonce, new Date(now.getTime() + ttlSeconds * 1000), now),
      ),
  };
}

export interface CloudVerifyInput {
  method: string;
  path: string;
  rawBody: Buffer | string | undefined;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  now: Date;
  nonceStore: NonceStore;
}

/** Verify one Cloud-signed request for audience `compute` (contract §2, in order). */
export function verifyCloudSigned(publicKeys: ReadonlyMap<string, KeyObject>, input: CloudVerifyInput) {
  return verifyRequest({
    audience: FEDERATION_AUDIENCE,
    method: input.method,
    path: input.path,
    rawBody: input.rawBody,
    headers: input.headers,
    keyRing: publicKeys,
    nonceStore: input.nonceStore,
    now: input.now,
  });
}

export function cloudAuth(deps: {
  publicKeys: ReadonlyMap<string, KeyObject>;
  store: ComputeStore;
  clock: Clock;
}): preHandlerAsyncHookHandler {
  const nonceStore = storeNonceStore(deps.store);
  return async function verifyCloud(req: FastifyRequest, reply: FastifyReply) {
    const result = await verifyCloudSigned(deps.publicKeys, {
      method: req.method,
      path: req.url,
      rawBody: req.rawBody,
      headers: req.headers,
      now: deps.clock(),
      nonceStore,
    });
    if (!result.ok) {
      return sendError(req, reply, new HttpError(result.status, result.code, failureMessage(result.reason)));
    }
    req.cloudKeyId = result.keyId;
  };
}

function failureMessage(reason: string): string {
  switch (reason) {
    case "malformed":
      return "Signed request headers are missing or malformed";
    case "unknown_key":
      return "Unknown signing key";
    case "stale":
      return "Signed request timestamp is outside the allowed window";
    case "replay":
      return "Signed request nonce was already used";
    default:
      return "Signed request signature is invalid";
  }
}

/** Errors agent auth returns, in check order. */
export const AGENT_AUTH_ERRORS = Object.freeze({
  malformed: { status: 400, code: "agent_malformed", message: "Agent signature headers are missing or malformed" },
  unknownHost: { status: 401, code: "agent_unknown_host", message: "Unknown host" },
  stale: { status: 401, code: "agent_stale", message: "Agent request timestamp is outside the allowed window" },
  signature: { status: 401, code: "agent_signature", message: "Agent request signature is invalid" },
  replay: { status: 401, code: "agent_replay", message: "Agent request nonce was already used" },
} as const);

type AgentAuthError = (typeof AGENT_AUTH_ERRORS)[keyof typeof AGENT_AUTH_ERRORS];

const asHttp = (e: AgentAuthError) => new HttpError(e.status, e.code, e.message);

export function agentAuth(deps: { store: ComputeStore; hosts: Hosts; clock: Clock }): preHandlerAsyncHookHandler {
  return async function verifyAgent(req: FastifyRequest, reply: FastifyReply) {
    const headers = parseAgentHeaders(req.headers);
    if (!headers) return sendError(req, reply, asHttp(AGENT_AUTH_ERRORS.malformed));
    const now = deps.clock();
    const outcome = await deps.store.transaction(async (tx) => {
      const host = await tx.getHost(headers.hostId);
      if (!host) return AGENT_AUTH_ERRORS.unknownHost;
      if (!agentTimestampFresh(headers.timestamp, now)) return AGENT_AUTH_ERRORS.stale;
      let publicKey: KeyObject;
      try {
        publicKey = loadPublicKey(host.publicKeyPem);
      } catch {
        return AGENT_AUTH_ERRORS.signature;
      }
      const valid = verifyAgentSignature({
        headers,
        method: req.method,
        path: req.url,
        rawBody: req.rawBody,
        publicKey,
      });
      if (!valid) return AGENT_AUTH_ERRORS.signature;
      const expiresAt = new Date(now.getTime() + AGENT_NONCE_TTL_SECONDS * 1000);
      if (!(await tx.claimNonce(`host:${host.id}`, headers.nonce, expiresAt, now))) {
        return AGENT_AUTH_ERRORS.replay;
      }
      return deps.hosts.markSeen(tx, host, now);
    });
    if ("code" in outcome) return sendError(req, reply, asHttp(outcome));
    req.agentHost = outcome;
  };
}
