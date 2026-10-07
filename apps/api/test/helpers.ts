/**
 * Test harness: an app on a chosen store with a controllable clock, a Cloud
 * signer for audience `compute`, a provisioned service instance, Console and
 * operator sessions opened through the real launch and redeem routes, and a
 * fake host agent that does what the C1e agent will do (verify the signed
 * job, run it on FakeDriver, report).
 *
 * Every key here is generated at run time and never leaves the process.
 */

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  CreateJobPayload,
  ResizeJobPayload,
  SnapshotJobPayload,
  type ConsoleRole,
  type Instance,
  type OperatorRole,
  type SignedJob,
} from "@softqraft/compute-contracts";
import { DriverError, FakeDriver, defaultDriverRegistry } from "@softqraft/compute-driver";
import { loadPublicKey, signAgentRequest, verifyJob } from "@softqraft/compute-jobs";
import { signRequest } from "@softqraft/federation";
import { buildApp, type Services } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryComputeStore, type ComputeStore } from "../src/store/index.js";

export const ORG = "11111111-1111-4111-8111-111111111111";
export const PROJECT = "22222222-2222-4222-8222-222222222222";
export const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
/** The harness's service instance, linked to PROJECT (allow-listed). */
export const SI = "si-pilot-1";
/** A second service instance, linked to OTHER_PROJECT (not allow-listed). */
export const OTHER_SI = "si-other-1";
export const CLOUD_KEY_ID = "test-cloud-1";
export const ORIGIN = "http://compute.test";

export const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4Kp0Tj9nJ7mTq8z3mQxPzv8yq9V2Jm9b0Zb8t7L3Hx pilot@test";

export function pem(key: KeyObject, type: "pkcs8" | "spki"): string {
  return key.export({ type, format: "pem" }).toString();
}

export function ed25519() {
  return generateKeyPairSync("ed25519");
}

export class TestClock {
  constructor(public current = new Date("2026-10-07T10:00:00.000Z")) {}
  now = (): Date => new Date(this.current);
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export interface HarnessOptions {
  env?: Record<string, string>;
  store?: ComputeStore;
  federation?: boolean;
  /** Provision SI and OTHER_SI at start. Default true (when federation is on). */
  provision?: boolean;
  logs?: string[];
}

/** A browser session: its cookie value, ready for a `cookie` header. */
export interface BrowserSession {
  cookie: string;
  token: string;
}

export interface Harness {
  app: FastifyInstance;
  services: Services;
  store: ComputeStore;
  clock: TestClock;
  jobSigningPublicKey: KeyObject;
  /** The four Cloud signature headers for exactly these bytes. */
  signCloud(method: string, path: string, rawBody: string, audience?: string): Record<string, string>;
  cloud(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  provision(serviceInstanceId: string, project?: string): Promise<LightMyRequestResponse>;
  /** Launch and redeem a Console session for a service instance. */
  consoleSession(role?: ConsoleRole, serviceInstanceId?: string, subject?: string): Promise<BrowserSession>;
  /** Launch and redeem an operator session. */
  operatorSession(role?: OperatorRole, subject?: string): Promise<BrowserSession>;
  /** A same-origin browser request carrying a session cookie. */
  browser(
    session: BrowserSession | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  /** A Console request with the harness's default developer session on SI. */
  console(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  /** A fleet request with the harness's default admin operator session. */
  admin(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  createInstance(
    spec?: Partial<Record<string, unknown>>,
    key?: string,
    session?: BrowserSession,
  ): Promise<LightMyRequestResponse>;
  enrolAgent(
    name?: string,
    capacity?: { vcpu: number; memoryMb: number; diskGb: number },
    driver?: string,
  ): Promise<FakeAgent>;
  close(): Promise<void>;
}

/** The grant inside a launch URL's fragment. */
export function grantFrom(launchUrl: string): string {
  return new URL(launchUrl).hash.replace(/^#grant=/, "");
}

/** The session token from a Set-Cookie header. */
export function tokenFrom(res: LightMyRequestResponse, name: string): string {
  const raw = res.headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const line = lines.find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`no ${name} cookie: ${res.statusCode} ${res.body}`);
  return decodeURIComponent(line.slice(name.length + 1).split(";")[0]!);
}

export const principal = (subject: string) => ({ subject, displayName: "Test User", email: "test@example.com" });

export const baseSpec = { name: "web-1", imageId: "debian-12", vcpu: 1, memoryMb: 1024, diskGb: 10, sshPublicKeys: [SSH_KEY] };

let keyCounter = 0;
export function idempotencyKey(): string {
  keyCounter += 1;
  return `test-key-${process.pid}-${keyCounter}-${Date.now()}`;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new TestClock();
  const cloudKeys = ed25519();
  const jobKeys = ed25519();
  const federation = options.federation ?? true;
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: options.logs ? "info" : "silent",
    COMPUTE_STORE: "memory",
    COMPUTE_PUBLIC_URL: ORIGIN,
    COMPUTE_ALLOWED_PROJECTS: PROJECT,
    COMPUTE_JOB_SIGNING_KEY_PEM: pem(jobKeys.privateKey, "pkcs8"),
    COMPUTE_CONSOLE_WAIT_SECONDS: "5",
    CLOUD_FEDERATION_ENABLED: federation ? "true" : "false",
    CLOUD_OPERATOR_LAUNCH_ENABLED: "true",
    CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({ [CLOUD_KEY_ID]: pem(cloudKeys.publicKey, "spki") }),
    ...options.env,
  });
  const store = options.store ?? new MemoryComputeStore();
  const logs = options.logs;
  const { app, services } = await buildApp({
    config,
    store,
    drivers: defaultDriverRegistry(),
    clock: clock.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    logStream: logs ? { write: (line: string) => void logs.push(line) } : undefined,
  });
  await app.ready();
  let defaultConsole: BrowserSession | null = null;
  let defaultAdmin: BrowserSession | null = null;

  const h: Harness = {
    app,
    services,
    store,
    clock,
    jobSigningPublicKey: jobKeys.publicKey,

    signCloud(method, path, rawBody, audience = "compute") {
      return {
        ...signRequest({
          audience,
          keyId: CLOUD_KEY_ID,
          privateKey: cloudKeys.privateKey,
          method,
          path,
          body: rawBody,
          now: clock.now(),
        }),
      };
    },

    async cloud(method, path, body, headers = {}) {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const signed = h.signCloud(method, path, payload);
      return app.inject({
        method: method as "GET",
        url: path,
        payload: payload || undefined,
        headers: { ...(payload ? { "content-type": "application/json" } : {}), ...signed, ...headers },
      });
    },

    async provision(serviceInstanceId, project = PROJECT) {
      return h.cloud("PUT", `/cloud/v1/service-instances/${serviceInstanceId}`, {
        cloudOrganisationId: ORG,
        cloudProjectId: project,
        displayName: "Pilot",
        regionId: "eu-central",
      });
    },

    async consoleSession(role = "developer", serviceInstanceId = SI, subject = "user_dev") {
      const launch = await h.cloud("POST", `/cloud/v1/service-instances/${serviceInstanceId}/console-launches`, {
        principal: principal(subject),
        role,
        returnPath: "/console/instances",
      });
      if (launch.statusCode !== 201) throw new Error(`console launch failed: ${launch.statusCode} ${launch.body}`);
      const res = await h.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", {
        grant: grantFrom(launch.json().launchUrl),
      });
      if (res.statusCode !== 200) throw new Error(`redeem failed: ${res.statusCode} ${res.body}`);
      const token = tokenFrom(res, "sq_console_session");
      return { token, cookie: `sq_console_session=${token}` };
    },

    async operatorSession(role = "admin", subject = "user_staff") {
      const launch = await h.cloud("POST", "/cloud/v1/operator-launches", {
        principal: principal(subject),
        role,
        returnPath: "/admin/fleet",
      });
      if (launch.statusCode !== 201) throw new Error(`operator launch failed: ${launch.statusCode} ${launch.body}`);
      const res = await h.browser(null, "POST", "/admin/v1/auth/cloud-launch/redeem", {
        grant: grantFrom(launch.json().launchUrl),
      });
      if (res.statusCode !== 200) throw new Error(`redeem failed: ${res.statusCode} ${res.body}`);
      const token = tokenFrom(res, "sq_admin_session");
      return { token, cookie: `sq_admin_session=${token}` };
    },

    async browser(session, method, path, body, headers = {}) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return app.inject({
        method: method as "GET",
        url: path,
        payload,
        headers: {
          origin: ORIGIN,
          ...(payload ? { "content-type": "application/json" } : {}),
          ...(session ? { cookie: session.cookie } : {}),
          ...headers,
        },
      });
    },

    async console(method, path, body, headers) {
      defaultConsole ??= await h.consoleSession("developer");
      return h.browser(defaultConsole, method, path, body, headers);
    },

    async admin(method, path, body, headers) {
      defaultAdmin ??= await h.operatorSession("admin");
      return h.browser(defaultAdmin, method, path, body, headers);
    },

    async createInstance(spec = {}, key = idempotencyKey(), session) {
      const body = { ...baseSpec, ...spec };
      const headers = { "idempotency-key": key };
      return session
        ? h.browser(session, "POST", "/console/v1/instances", body, headers)
        : h.console("POST", "/console/v1/instances", body, headers);
    },

    async enrolAgent(name = "sq-node-01", capacity = { vcpu: 4, memoryMb: 8192, diskGb: 120 }, driver = "fake") {
      const { token } = await services.hosts.createEnrolmentToken({ hostName: name, now: clock.now() });
      const keys = ed25519();
      const res = await app.inject({
        method: "POST",
        url: "/v1/agent/enrol",
        payload: { token, name, driver, publicKey: pem(keys.publicKey, "spki"), capacity },
      });
      if (res.statusCode !== 201) throw new Error(`enrol failed: ${res.statusCode} ${res.body}`);
      const body = res.json() as { hostId: string; jobSigningKeys: Record<string, string> };
      const jobKeyRing = new Map(
        Object.entries(body.jobSigningKeys).map(([id, p]) => [id, loadPublicKey(p)] as const),
      );
      return new FakeAgent(app, clock, body.hostId, keys.privateKey, jobKeyRing);
    },

    async close() {
      await app.close();
    },
  };
  if (federation && options.provision !== false) {
    for (const [id, project] of [
      [SI, PROJECT],
      [OTHER_SI, OTHER_PROJECT],
    ] as const) {
      const res = await h.provision(id, project);
      if (res.statusCode !== 201) throw new Error(`provision failed: ${res.statusCode} ${res.body}`);
    }
  }
  return h;
}

/** What the C1b host agent does, against FakeDriver. */
export class FakeAgent {
  readonly driver: FakeDriver;

  constructor(
    private readonly app: FastifyInstance,
    private readonly clock: TestClock,
    readonly hostId: string,
    private readonly privateKey: KeyObject,
    private readonly jobKeys: Map<string, KeyObject>,
  ) {
    this.driver = new FakeDriver({ now: clock.now });
  }

  /** Signature headers for exactly these bytes, without sending anything. */
  sign(method: string, path: string, rawBody: string, nonce?: string): Record<string, string> {
    return signAgentRequest({
      hostId: this.hostId,
      privateKey: this.privateKey,
      method,
      path,
      body: rawBody,
      now: this.clock.now(),
      nonce,
    });
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    tweak?: (h: Record<string, string>) => void,
    nonce?: string,
  ) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = this.sign(method, path, payload, nonce);
    tweak?.(headers);
    return this.app.inject({
      method: method as "POST",
      url: path,
      payload: payload || undefined,
      headers: { ...(payload ? { "content-type": "application/json" } : {}), ...headers },
    });
  }

  async claim(): Promise<SignedJob | null> {
    const res = await this.request("POST", "/v1/agent/jobs/claim");
    if (res.statusCode !== 200) throw new Error(`claim failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { job: SignedJob | null }).job;
  }

  /** Claim one job, verify it, run it on the driver and report. Returns the job, or null. */
  async step(): Promise<{ job: SignedJob; outcome: "complete" | "fail"; status: number } | null> {
    const job = await this.claim();
    if (!job) return null;
    const verified = verifyJob(job, { keys: this.jobKeys, hostId: this.hostId, now: this.clock.now() });
    if (!verified.ok) throw new Error(`agent refused job: ${verified.reason}`);
    const env = verified.envelope;
    let result: unknown;
    try {
      switch (env.type) {
        case "create": {
          const payload = CreateJobPayload.parse(env.payload);
          await this.driver.create({ instanceId: env.instanceId, ...payload });
          break;
        }
        case "start":
          await this.driver.start(env.instanceId);
          break;
        case "stop":
          await this.driver.stop(env.instanceId);
          break;
        case "delete":
          await this.driver.delete(env.instanceId);
          break;
        case "snapshot":
          await this.driver.snapshot(env.instanceId, SnapshotJobPayload.parse(env.payload).snapshotName);
          break;
        case "snapshot_delete":
          await this.driver.deleteSnapshot(env.instanceId, SnapshotJobPayload.parse(env.payload).snapshotName);
          break;
        case "resize": {
          const { vcpu, memoryMb, diskGb } = ResizeJobPayload.parse(env.payload);
          await this.driver.resize(env.instanceId, { vcpu, memoryMb, diskGb });
          break;
        }
        case "console":
          result = await this.driver.console(env.instanceId);
          break;
      }
    } catch (err) {
      const message = err instanceof DriverError ? err.code : "driver_error";
      const res = await this.request("POST", `/v1/agent/jobs/${env.id}/fail`, { attempt: env.attempt, error: message });
      return { job, outcome: "fail", status: res.statusCode };
    }
    const res = await this.request("POST", `/v1/agent/jobs/${env.id}/complete`, {
      attempt: env.attempt,
      ...(result === undefined ? {} : { result }),
    });
    return { job, outcome: "complete", status: res.statusCode };
  }

  /** Run jobs until none is queued. */
  async drain(max = 20): Promise<number> {
    let n = 0;
    while (n < max && (await this.step())) n += 1;
    return n;
  }
}

export function instanceOf(res: LightMyRequestResponse): Instance {
  return (res.json() as { instance: Instance }).instance;
}
