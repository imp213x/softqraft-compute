/**
 * Transports carry one Proxmox API call each.
 *
 * - `PinnedHttpsTransport` talks to the local API over TLS pinned to the
 *   certificate's SHA-256 fingerprint. Only this transport's own sockets skip
 *   CA verification; they are handed to the HTTP client only after the
 *   peer's fingerprint matched, so no request byte (and so no token) is ever
 *   sent to an unpinned peer. Nothing global is changed.
 * - `DryRunTransport` passes reads through and never sends a write: it logs
 *   the call it would make, without secrets, and returns null.
 *
 * Neither transport logs or returns headers, bodies or the token.
 */

import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { ProxmoxConfig } from "./config.js";
import { PROXMOX_ERRORS, proxmoxError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type Params = Record<string, string | number>;

export interface ProxmoxCall {
  method: HttpMethod;
  /** Path under `/api2/json`, for example `/nodes/n1/qemu/2000/config`. */
  path: string;
  params: Params;
}

export interface ProxmoxTransport {
  /** Send one call and return the response's `data`. */
  send(call: ProxmoxCall): Promise<unknown>;
}

export const API_PREFIX = "/api2/json";

/** Form-encode params (Proxmox takes `application/x-www-form-urlencoded`). */
export function encodeParams(params: Params): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join("&");
}

class PinnedAgent extends https.Agent {
  constructor(private readonly fingerprint: string) {
    super({ keepAlive: false });
  }

  // Async createConnection: the socket reaches the HTTP client only after
  // the pin matched, so the request (with its token) is never written to an
  // unverified peer.
  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): undefined {
    let settled = false;
    const done = (err: Error | null, socket?: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      callback?.(err, socket as Duplex);
    };
    const socket = tls.connect({
      host: options.host ?? "127.0.0.1",
      port: Number(options.port ?? 8006),
      // Verification happens below, by fingerprint, for this socket only.
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      if (!peer || peer.fingerprint256 !== this.fingerprint) {
        socket.destroy();
        done(proxmoxError(PROXMOX_ERRORS.tlsPinMismatch, "The Proxmox API certificate does not match the pinned fingerprint"));
        return;
      }
      done(null, socket);
    });
    socket.once("error", (err) => done(err));
    return undefined;
  }
}

export interface PinnedHttpsTransportOptions {
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

export class PinnedHttpsTransport implements ProxmoxTransport {
  private readonly base: URL;
  private readonly authorization: string;
  private readonly fingerprint: string;
  private readonly timeoutMs: number;

  constructor(config: Pick<ProxmoxConfig, "url" | "tokenId" | "tokenSecret" | "tlsFingerprint">, options: PinnedHttpsTransportOptions = {}) {
    this.base = new URL(config.url);
    this.authorization = `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`;
    this.fingerprint = config.tlsFingerprint;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  send(call: ProxmoxCall): Promise<unknown> {
    const query = call.method === "GET" || call.method === "DELETE" ? encodeParams(call.params) : "";
    const body = call.method === "POST" || call.method === "PUT" ? encodeParams(call.params) : "";
    const path = `${API_PREFIX}${call.path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = { authorization: this.authorization, accept: "application/json" };
    if (call.method === "POST" || call.method === "PUT") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.base.hostname.replace(/^\[|\]$/g, ""),
          port: Number(this.base.port || 443),
          method: call.method,
          path,
          headers,
          agent: new PinnedAgent(this.fingerprint),
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", () => reject(proxmoxError(PROXMOX_ERRORS.unreachable, "The Proxmox API connection broke", true)));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status === 401) return reject(proxmoxError(PROXMOX_ERRORS.auth, "Proxmox refused the API token"));
            if (status === 403) return reject(proxmoxError(PROXMOX_ERRORS.forbidden, "The API token lacks a privilege for this call"));
            if (status >= 500) return reject(proxmoxError(PROXMOX_ERRORS.server, `Proxmox answered ${status}`, true));
            if (status >= 400) return reject(proxmoxError(PROXMOX_ERRORS.rejected, `Proxmox refused the call (${status})`));
            if (status < 200 || status >= 300) {
              return reject(proxmoxError(PROXMOX_ERRORS.badResponse, `Unexpected Proxmox status ${status}`));
            }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown };
              resolve(parsed.data ?? null);
            } catch {
              reject(proxmoxError(PROXMOX_ERRORS.badResponse, "Proxmox did not answer with JSON"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(proxmoxError(PROXMOX_ERRORS.unreachable, "The Proxmox API timed out", true)));
      req.on("error", (err) => {
        if (err instanceof Error && err.name === "DriverError") return reject(err);
        reject(proxmoxError(PROXMOX_ERRORS.unreachable, "The Proxmox API could not be reached", true));
      });
      req.end(body || undefined);
    });
  }
}

/** Parameter names whose values are never logged. */
const SECRET_PARAM = /pass|secret|token|key(?!s$)|cookie|ticket/i;

/** A copy of the params that is safe to log: secrets replaced, SSH keys counted. */
export function redactParams(params: Params): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "sshkeys") {
      const count = decodeURIComponent(String(value)).split("\n").filter(Boolean).length;
      out[key] = `[${count} public key${count === 1 ? "" : "s"}]`;
    } else if (SECRET_PARAM.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type DryRunLogger = (call: ProxmoxCall) => void;

/**
 * Reads go to the real API; writes are logged and never sent. A write's
 * result is null, which the client treats as "no task to wait for".
 */
export class DryRunTransport implements ProxmoxTransport {
  /** Every write that was not sent, redacted, in order. */
  readonly skipped: ProxmoxCall[] = [];

  constructor(
    private readonly reads: ProxmoxTransport,
    private readonly log: DryRunLogger,
  ) {}

  async send(call: ProxmoxCall): Promise<unknown> {
    if (call.method === "GET") return this.reads.send(call);
    const safe = { method: call.method, path: call.path, params: redactParams(call.params) };
    this.skipped.push(safe);
    this.log(safe);
    return null;
  }
}
