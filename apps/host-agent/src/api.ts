/**
 * The Compute API, as the agent sees it: enrolment (one-time token) and the
 * host-signed agent routes. Outbound HTTPS only; the agent opens no port.
 *
 * Errors carry the HTTP status and the API's error code, never a header,
 * a body, a token or a signature.
 */

import type { KeyObject } from "node:crypto";
import {
  ClaimResponse,
  EnrolResponse,
  HeartbeatResponse,
  type AgentUsageSample,
  type ConsoleTicket,
  type EnrolRequest,
  type SignedJob,
} from "@softqraft/compute-contracts";
import { signAgentRequest } from "@softqraft/compute-jobs";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Compute API answered ${status} ${code}`);
    this.name = "ApiError";
  }
}

/** The API could not be reached (network, DNS, TLS, timeout). Retry with backoff. */
export class ApiUnreachable extends Error {
  constructor() {
    super("The Compute API could not be reached");
    this.name = "ApiUnreachable";
  }
}

export interface AgentApi {
  enrol(body: EnrolRequest): Promise<EnrolResponse>;
  claim(): Promise<SignedJob | null>;
  heartbeat(jobId: string, attempt: number): Promise<void>;
  complete(jobId: string, attempt: number, result?: ConsoleTicket): Promise<void>;
  fail(jobId: string, attempt: number, error: string): Promise<void>;
  usage(samples: AgentUsageSample[]): Promise<void>;
}

export interface Identity {
  hostId: string;
  privateKey: KeyObject;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export class ComputeApi implements AgentApi {
  private identity: Identity | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 30_000,
  ) {}

  setIdentity(identity: Identity): void {
    this.identity = identity;
  }

  private async send(method: string, path: string, body: unknown, signed: boolean): Promise<unknown> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (payload) headers["content-type"] = "application/json";
    if (signed) {
      if (!this.identity) throw new Error("The agent is not enrolled");
      Object.assign(
        headers,
        signAgentRequest({ hostId: this.identity.hostId, privateKey: this.identity.privateKey, method, path, body: payload }),
      );
    }
    let res: { status: number; text(): Promise<string> };
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload || undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch {
      throw new ApiUnreachable();
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 400) {
      const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
      throw new ApiError(res.status, typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unknown");
    }
    return json;
  }

  async enrol(body: EnrolRequest): Promise<EnrolResponse> {
    return EnrolResponse.parse(await this.send("POST", "/v1/agent/enrol", body, false));
  }

  async claim(): Promise<SignedJob | null> {
    const raw = (await this.send("POST", "/v1/agent/jobs/claim", undefined, true)) as { job?: unknown } | null;
    // Shape-check only the outer response here; verifyJob checks the job itself.
    if (!raw || raw.job === null || raw.job === undefined) return null;
    const shaped = ClaimResponse.safeParse(raw);
    return shaped.success ? shaped.data.job : (raw.job as SignedJob);
  }

  async heartbeat(jobId: string, attempt: number): Promise<void> {
    HeartbeatResponse.parse(await this.send("POST", `/v1/agent/jobs/${jobId}/heartbeat`, { attempt }, true));
  }

  async complete(jobId: string, attempt: number, result?: ConsoleTicket): Promise<void> {
    await this.send("POST", `/v1/agent/jobs/${jobId}/complete`, { attempt, ...(result ? { result } : {}) }, true);
  }

  async fail(jobId: string, attempt: number, error: string): Promise<void> {
    await this.send("POST", `/v1/agent/jobs/${jobId}/fail`, { attempt, error }, true);
  }

  async usage(samples: AgentUsageSample[]): Promise<void> {
    await this.send("POST", "/v1/agent/usage", { samples }, true);
  }
}
