import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentUsageSample, ConsoleTicket, EnrolRequest, EnrolResponse, JobEnvelope, SignedJob } from "@softqraft/compute-contracts";
import { FakeDriver } from "@softqraft/compute-driver";
import { REPIN_DOC_URL, TlsPinMismatchError } from "@softqraft/compute-driver-proxmox";
import { publicKeyPem, signJob } from "@softqraft/compute-jobs";
import { Agent, TEMPLATES_MISSING, type AgentDriver } from "./agent.js";
import { ApiError, ApiUnreachable, type AgentApi, type Identity } from "./api.js";
import { loadAgentConfig } from "./config.js";
import { createLogger } from "./log.js";
import { RUNBOOK_RULES } from "./rules.test-helper.js";

const HOST = randomUUID();
const jobKeys = generateKeyPairSync("ed25519");

/** An in-memory API: hands out queued jobs and records every report. */
class StubApi implements AgentApi {
  jobs: Array<SignedJob | Error> = [];
  claims = 0;
  reports: Array<{ kind: "complete" | "fail"; jobId: string; attempt: number; error?: string; result?: ConsoleTicket }> = [];
  usageReports: AgentUsageSample[][] = [];
  heartbeats = 0;
  enrolled: EnrolRequest | null = null;
  identity: Identity | null = null;
  usageError: ((samples: AgentUsageSample[]) => Error | null) | null = null;

  async enrol(body: EnrolRequest): Promise<EnrolResponse> {
    this.enrolled = body;
    return { hostId: HOST, state: "enrolled", jobSigningKeys: { "job-1": publicKeyPem(jobKeys.publicKey) } };
  }
  setIdentity(identity: Identity): void {
    this.identity = identity;
  }
  async claim(): Promise<SignedJob | null> {
    this.claims += 1;
    const next = this.jobs.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  }
  async heartbeat(): Promise<void> {
    this.heartbeats += 1;
  }
  async complete(jobId: string, attempt: number, result?: ConsoleTicket): Promise<void> {
    this.reports.push({ kind: "complete", jobId, attempt, ...(result ? { result } : {}) });
  }
  async fail(jobId: string, attempt: number, error: string): Promise<void> {
    this.reports.push({ kind: "fail", jobId, attempt, error });
  }
  async usage(samples: AgentUsageSample[]): Promise<void> {
    const err = this.usageError?.(samples);
    if (err) throw err;
    this.usageReports.push(samples);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function build(options: { env?: Record<string, string>; guard?: boolean; driver?: FakeDriver & AgentDriver; now?: () => Date } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sq-agent-"));
  dirs.push(dir);
  const guardFile = path.join(dir, "forward.rules");
  if (options.guard !== false) writeFileSync(guardFile, RUNBOOK_RULES);
  const config = loadAgentConfig({
    COMPUTE_API_URL: "https://compute.test",
    COMPUTE_HOST_NAME: "sq-node-01",
    COMPUTE_ENROLMENT_TOKEN: `sqet_${"a".repeat(43)}`,
    COMPUTE_AGENT_STATE_DIR: path.join(dir, "state"),
    COMPUTE_AGENT_NETWORK_GUARD_FILE: guardFile,
    COMPUTE_AGENT_POLL_SECONDS: "0.01",
    COMPUTE_AGENT_HEARTBEAT_SECONDS: "0.01",
    COMPUTE_AGENT_USAGE_SECONDS: "600",
    COMPUTE_AGENT_BACKOFF_MAX_SECONDS: "0.02",
    COMPUTE_AGENT_ENSURE_IMAGES: "false",
    ...options.env,
  });
  const api = new StubApi();
  const lines: string[] = [];
  const log = createLogger("debug", (l) => lines.push(l));
  const driver = options.driver ?? new FakeDriver();
  const agent = new Agent({ config, driver, api, log, now: options.now, random: () => 1 });
  return { agent, api, driver, lines, config };
}

const ISSUED = new Date();
function job(overrides: Partial<JobEnvelope> = {}, keyId = "job-1", key = jobKeys.privateKey): SignedJob {
  return signJob(
    {
      id: randomUUID(),
      hostId: HOST,
      type: "create",
      instanceId: randomUUID(),
      attempt: 1,
      payload: {
        spec: { name: "web-1", imageId: "debian-12", vcpu: 1, memoryMb: 1024, diskGb: 16, sshPublicKeys: [] },
        privateIp: "10.30.0.10",
        network: { cidr: "10.30.0.0/24", gateway: "10.30.0.1" },
      },
      issuedAt: ISSUED.toISOString(),
      expiresAt: new Date(ISSUED.getTime() + 300_000).toISOString(),
      ...overrides,
    },
    key,
    keyId,
  );
}

async function runUntil(agent: Agent, done: () => boolean, ms = 3000): Promise<void> {
  const running = agent.run();
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  await agent.stop();
  await running;
}

describe("Agent job handling", () => {
  it("enrols, verifies a job, runs it on the driver and completes it", async () => {
    const { agent, api, driver } = build();
    const good = job();
    api.jobs.push(good);
    await runUntil(agent, () => api.reports.length === 1);
    assert.equal(api.enrolled?.driver, "fake");
    assert.equal(api.enrolled?.name, "sq-node-01");
    assert.equal(api.identity?.hostId, HOST);
    assert.deepEqual(api.reports, [{ kind: "complete", jobId: good.envelope.id, attempt: 1 }]);
    assert.deepEqual(driver.calls, [{ op: "create", instanceId: good.envelope.instanceId }]);
  });

  it("refuses a tampered, expired, misaddressed or unknown-key job without touching the driver", async () => {
    const { agent, api, driver, lines } = build();
    const tampered = job();
    tampered.envelope = { ...tampered.envelope, payload: { ...tampered.envelope.payload, privateIp: "10.20.0.5" } };
    const retyped = job();
    retyped.envelope = { ...retyped.envelope, type: "delete" };
    const expired = job({ issuedAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    const otherHost = job({ hostId: randomUUID() });
    const unknownKey = job({}, "job-9");
    const forged = job({}, "job-1", generateKeyPairSync("ed25519").privateKey);
    api.jobs.push(tampered, retyped, expired, otherHost, unknownKey, forged);
    await runUntil(agent, () => api.reports.length === 6);
    assert.deepEqual(driver.calls, [], "the driver was never called");
    assert.deepEqual(
      api.reports.map((r) => [r.kind, r.error]),
      [
        ["fail", "job_refused_signature"],
        ["fail", "job_refused_signature"],
        ["fail", "job_refused_expired"],
        ["fail", "job_refused_wrong_host"],
        ["fail", "job_refused_unknown_key"],
        ["fail", "job_refused_signature"],
      ],
    );
    const text = lines.join("");
    assert.ok(!text.includes(tampered.signature), "no signature in the logs");
    assert.ok(!text.includes("10.20.0.5"), "no payload in the logs");
  });

  it("reports driver failures with their stable code, and heartbeats while a job runs", async () => {
    const driver = new FakeDriver();
    const { agent, api } = build({ driver });
    const start = job({ type: "start", payload: { name: "web-1" } });
    api.jobs.push(start);
    await runUntil(agent, () => api.reports.length === 1);
    assert.deepEqual(api.reports[0], { kind: "fail", jobId: start.envelope.id, attempt: 1, error: "vm_not_found" });

    const slow = new FakeDriver();
    const original = slow.create.bind(slow);
    slow.create = async (input) => {
      await new Promise((r) => setTimeout(r, 60));
      return original(input);
    };
    const b = build({ driver: slow });
    b.api.jobs.push(job());
    await runUntil(b.agent, () => b.api.reports.length === 1);
    assert.ok(b.api.heartbeats >= 2, `heartbeats: ${b.api.heartbeats}`);
  });

  it("in dry run, runs the driver for its log and fails the job with dry_run", async () => {
    const { agent, api, driver } = build({ env: { COMPUTE_AGENT_DRY_RUN: "true" } });
    const one = job();
    api.jobs.push(one);
    await runUntil(agent, () => api.reports.length === 1);
    assert.equal(driver.calls.length, 1);
    assert.deepEqual(api.reports, [{ kind: "fail", jobId: one.envelope.id, attempt: 1, error: "dry_run" }]);
  });

  it("claims nothing while the network guard is missing", async () => {
    const { agent, api, driver, lines } = build({ guard: false });
    api.jobs.push(job());
    await runUntil(agent, () => false, 150);
    assert.equal(api.claims, 0);
    assert.equal(driver.calls.length, 0);
    assert.ok(lines.some((l) => l.includes("network_guard_missing")));
  });

  it("backs off while the API is unreachable, then carries on", async () => {
    const { agent, api, lines } = build();
    api.jobs.push(new ApiUnreachable(), new ApiUnreachable(), new ApiError(503, "unknown"), job());
    await runUntil(agent, () => api.reports.length === 1);
    assert.equal(api.reports[0]!.kind, "complete");
    assert.equal(lines.filter((l) => l.includes("api_unreachable")).length, 2);
  });

  it("reports usage for every VM, and resends one by one when the API does not know one", async () => {
    const { agent, api, driver } = build();
    await agent.enrol();
    const a = randomUUID();
    const b = randomUUID();
    const input = (instanceId: string) => ({
      instanceId,
      spec: { name: "x", imageId: "debian-12", vcpu: 1, memoryMb: 512, diskGb: 10, sshPublicKeys: [] },
      privateIp: "10.30.0.5",
      network: { cidr: "10.30.0.0/24", gateway: "10.30.0.1" },
    });
    await driver.create(input(a));
    await driver.create(input(b));
    await driver.stop(b);
    assert.equal(await agent.reportUsage(), 2);
    const [batch] = api.usageReports;
    assert.deepEqual(
      batch!.map((s) => [s.instanceId, s.powerState, s.intervalSeconds]),
      [
        [a, "running", 600],
        [b, "stopped", 600],
      ],
    );
    api.usageError = (samples) => (samples.length > 1 || samples[0]!.instanceId === b ? new ApiError(400, "unknown_instance") : null);
    assert.equal(await agent.reportUsage(), 1);
    assert.equal(api.usageReports.at(-1)![0]!.instanceId, a);
  });

  it("refuses to start without a token when not enrolled", async () => {
    const { agent } = build({ env: { COMPUTE_ENROLMENT_TOKEN: "" } });
    await assert.rejects(agent.run(), /COMPUTE_ENROLMENT_TOKEN/);
  });

  it("with hand-built templates, checks them at start and refuses create jobs while one is missing (F4)", async () => {
    const driver = new FakeDriver() as FakeDriver & AgentDriver;
    let missing = [{ imageId: "debian-12", templateVmid: 9000 }];
    let reads = 0;
    driver.missingTemplates = async () => {
      reads += 1;
      return missing;
    };
    const { agent, api, lines } = build({ driver });
    const create = job();
    const stop = job({ type: "stop", payload: { name: "web-1" } });
    api.jobs.push(create, stop);
    await runUntil(agent, () => api.reports.length === 2);
    assert.deepEqual(
      api.reports.map((r) => [r.jobId, r.error]),
      [
        [create.envelope.id, TEMPLATES_MISSING],
        [stop.envelope.id, "vm_not_found"],
      ],
      "the create is refused; other jobs still run",
    );
    assert.deepEqual(driver.calls, [{ op: "stop", instanceId: stop.envelope.instanceId }], "the driver never saw the create");
    const missingLines = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === TEMPLATES_MISSING);
    assert.equal(missingLines.length, 2, "at start, and again before the refused create");
    assert.deepEqual(missingLines[0]!.missing, [{ imageId: "debian-12", templateVmid: 9000 }]);
    assert.equal(missingLines[0]!.level, "error");

    // The founder builds the template: the next create checks again and runs.
    missing = [];
    const again = job();
    const b = build({ driver });
    b.api.jobs.push(again, job());
    await runUntil(b.agent, () => b.api.reports.length === 2);
    assert.deepEqual(b.api.reports.map((r) => r.kind), ["complete", "complete"]);
    assert.ok(b.lines.some((l) => l.includes('"msg":"templates_ok"')));
    assert.equal(reads, 3, "at each start and before the refused create; once seen, not again");
  });

  it("does not check templates when it builds them itself (COMPUTE_AGENT_ENSURE_IMAGES=true)", async () => {
    const driver = new FakeDriver() as FakeDriver & AgentDriver;
    driver.missingTemplates = async () => [{ imageId: "debian-12", templateVmid: 9000 }];
    const { agent, api } = build({ driver, env: { COMPUTE_AGENT_ENSURE_IMAGES: "true" } });
    api.jobs.push(job());
    await runUntil(agent, () => api.reports.length === 1);
    assert.equal(api.reports[0]!.kind, "complete");
  });

  it("logs one plain proxmox_tls_pin_mismatch line with both fingerprints and the re-pin procedure (F9)", async () => {
    const pinned = "AA:".repeat(31) + "AA";
    const presented = "BB:".repeat(31) + "BB";
    const driver = new FakeDriver();
    driver.create = async () => {
      throw new TlsPinMismatchError(pinned, presented);
    };
    const { agent, api, lines } = build({ driver });
    api.jobs.push(job(), job());
    await runUntil(agent, () => api.reports.length === 2);
    assert.deepEqual(api.reports.map((r) => r.error), ["proxmox_tls_pin_mismatch", "proxmox_tls_pin_mismatch"]);
    const pin = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "proxmox_tls_pin_mismatch");
    assert.equal(pin.length, 1, "one line while the same certificate is presented");
    assert.equal(pin[0]!.level, "error");
    assert.equal(pin[0]!.pinnedFingerprint, pinned);
    assert.equal(pin[0]!.presentedFingerprint, presented);
    assert.equal(pin[0]!.doc, REPIN_DOC_URL);
    assert.match(String(pin[0]!.action), /PROXMOX_TLS_FINGERPRINT/);
  });
});
