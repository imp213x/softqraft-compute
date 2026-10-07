/**
 * Test harness: an app on a chosen store with a controllable clock, a Cloud
 * signer for audience `compute`, and a fake host agent that does what the
 * C1b agent will do (verify the signed job, run it on FakeDriver, report).
 *
 * Every key here is generated at run time and never leaves the process.
 */

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Instance, SignedJob } from "@softqraft/compute-contracts";
import { DriverError, FakeDriver, defaultDriverRegistry } from "@softqraft/compute-driver";
import { loadPublicKey, signAgentRequest, verifyJob } from "@softqraft/compute-jobs";
import { signRequest } from "@softqraft/federation";
import { buildApp, type Services } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { OperatorAuthorizer } from "../src/modules/auth/index.js";
import { MemoryComputeStore, type ComputeStore } from "../src/store/index.js";

export const PROJECT = "22222222-2222-4222-8222-222222222222";
export const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
export const CLOUD_KEY_ID = "test-cloud-1";

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

export const allowOperators: OperatorAuthorizer = { authorize: async () => true };

export interface HarnessOptions {
  env?: Record<string, string>;
  store?: ComputeStore;
  federation?: boolean;
  operatorAuthorizer?: OperatorAuthorizer;
  logs?: string[];
}

export interface Harness {
  app: FastifyInstance;
  services: Services;
  store: ComputeStore;
  clock: TestClock;
  jobSigningPublicKey: KeyObject;
  cloud(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  createInstance(spec?: Partial<Record<string, unknown>>, key?: string, project?: string): Promise<LightMyRequestResponse>;
  enrolAgent(name?: string, capacity?: { vcpu: number; memoryMb: number; diskGb: number }): Promise<FakeAgent>;
  close(): Promise<void>;
}

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
    COMPUTE_ALLOWED_PROJECTS: PROJECT,
    COMPUTE_JOB_SIGNING_KEY_PEM: pem(jobKeys.privateKey, "pkcs8"),
    CLOUD_FEDERATION_ENABLED: federation ? "true" : "false",
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
    operatorAuthorizer: options.operatorAuthorizer,
    logStream: logs ? { write: (line: string) => void logs.push(line) } : undefined,
  });
  await app.ready();

  const h: Harness = {
    app,
    services,
    store,
    clock,
    jobSigningPublicKey: jobKeys.publicKey,

    async cloud(method, path, body, headers = {}) {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const signed = signRequest({
        audience: "compute",
        keyId: CLOUD_KEY_ID,
        privateKey: cloudKeys.privateKey,
        method,
        path,
        body: payload,
        now: clock.now(),
      });
      return app.inject({
        method: method as "GET",
        url: path,
        payload: payload || undefined,
        headers: { ...(payload ? { "content-type": "application/json" } : {}), ...signed, ...headers },
      });
    },

    async createInstance(spec = {}, key = idempotencyKey(), project = PROJECT) {
      return h.cloud("POST", `/v1/projects/${project}/instances`, { ...baseSpec, ...spec }, { "idempotency-key": key });
    },

    async enrolAgent(name = "sq-node-01", capacity = { vcpu: 4, memoryMb: 8192, diskGb: 120 }) {
      const { token } = await services.hosts.createEnrolmentToken({ hostName: name, now: clock.now() });
      const keys = ed25519();
      const res = await app.inject({
        method: "POST",
        url: "/v1/agent/enrol",
        payload: { token, name, driver: "fake", publicKey: pem(keys.publicKey, "spki"), capacity },
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
  return h;
}

/** What the C1b host agent does, against FakeDriver. */
export class FakeAgent {
  readonly driver = new FakeDriver();

  constructor(
    private readonly app: FastifyInstance,
    private readonly clock: TestClock,
    readonly hostId: string,
    private readonly privateKey: KeyObject,
    private readonly jobKeys: Map<string, KeyObject>,
  ) {}

  async request(method: string, path: string, body?: unknown, tweak?: (h: Record<string, string>) => void) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = signAgentRequest({
      hostId: this.hostId,
      privateKey: this.privateKey,
      method,
      path,
      body: payload,
      now: this.clock.now(),
    });
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
    try {
      const payload = env.payload as Record<string, never>;
      switch (env.type) {
        case "create":
          await this.driver.create({
            instanceId: env.instanceId,
            spec: payload.spec,
            privateIp: payload.privateIp,
            network: payload.network,
          });
          break;
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
          await this.driver.snapshot(env.instanceId, String(payload.snapshotName));
          break;
      }
    } catch (err) {
      const message = err instanceof DriverError ? err.code : "driver_error";
      const res = await this.request("POST", `/v1/agent/jobs/${env.id}/fail`, { attempt: env.attempt, error: message });
      return { job, outcome: "fail", status: res.statusCode };
    }
    const res = await this.request("POST", `/v1/agent/jobs/${env.id}/complete`, { attempt: env.attempt });
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
