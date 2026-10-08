/**
 * The host agent.
 *
 * 1. Enrol once with the one-time token; keep the host key and the job
 *    signing keys in the state directory; blank the token in the env file.
 * 2. Check the network guard. While it is missing, run no job. When the
 *    templates are built by hand (COMPUTE_AGENT_ENSURE_IMAGES=false), check
 *    that they exist; while one is missing, refuse create jobs
 *    (`templates_missing`).
 * 3. Loop: claim a job, verify it (`verifyJob`: signature, this host, not
 *    expired), run it on the driver while heartbeating well inside the
 *    120 s lease, then complete or fail it. Back off exponentially while the
 *    API is unreachable.
 * 4. Every 60 s, report a usage sample for every VM the driver manages.
 *
 * Dry run: jobs are verified and run on a driver whose writes are logged,
 * not sent; each job is then failed with `dry_run`, because nothing was done.
 *
 * Nothing here logs a token, key, signature, envelope or payload.
 */

import type { KeyObject } from "node:crypto";
import {
  JOB_PAYLOADS,
  type AgentUsageSample,
  type ConsoleTicket,
  type CreateJobPayload,
  type JobEnvelope,
  type ResizeJobPayload,
  type SignedJob,
  type SnapshotJobPayload,
} from "@softqraft/compute-contracts";
import { DriverError, type HypervisorDriver } from "@softqraft/compute-driver";
import { PROXMOX_ERRORS, REPIN_DOC_URL, TlsPinMismatchError } from "@softqraft/compute-driver-proxmox";
import { verifyJob } from "@softqraft/compute-jobs";
import { ApiError, ApiUnreachable, type AgentApi, type ComputeApi } from "./api.js";
import { wipeEnrolmentToken, type AgentConfig } from "./config.js";
import { checkNetworkGuardFile, type GuardResult } from "./guard.js";
import type { Logger } from "./log.js";
import { AgentState, type Enrolment } from "./state.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A driver that can also build, or check, its image templates. */
export interface AgentDriver extends HypervisorDriver {
  ensureImages?: () => Promise<Array<{ imageId: string; action: string }>>;
  /** Read-only: catalogue templates that are not ready. */
  missingTemplates?: () => Promise<Array<{ imageId: string; templateVmid: number }>>;
}

/** A create refused because a hand-built template is missing (decision F4). */
export const TEMPLATES_MISSING = "templates_missing";

/** How often the same pin mismatch is logged again while it lasts. */
const PIN_LOG_INTERVAL_MS = 5 * 60_000;

export interface AgentDeps {
  config: AgentConfig;
  driver: AgentDriver;
  api: AgentApi & Pick<ComputeApi, "setIdentity">;
  log: Logger;
  /** The env file, so the enrolment token can be blanked after use. */
  envFile?: string;
  now?: () => Date;
  /** Jitter source for backoff (tests pass a constant). */
  random?: () => number;
}

export class Backoff {
  private attempt = 0;
  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly random: () => number = Math.random,
  ) {}
  next(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    // Full jitter in the upper half: never zero, never above the ceiling.
    return Math.round(ceiling / 2 + (ceiling / 2) * this.random());
  }
  reset(): void {
    this.attempt = 0;
  }
}

export class Agent {
  private readonly config: AgentConfig;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly abort = new AbortController();
  private stopping = false;
  private current: Promise<void> | null = null;
  private hostId = "";
  private jobKeys = new Map<string, KeyObject>();
  private lastUsageAt: Date | null = null;
  guard: GuardResult = { ok: false, missing: [] };
  /** True once the hand-built templates were seen; checked again before a create until then. */
  templatesReady = false;
  private lastPinLog: { presented: string; at: number } | null = null;
  /** Jobs handled so far (for tests and logs). */
  handled = 0;

  constructor(private readonly deps: AgentDeps) {
    this.config = deps.config;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
  }

  /** Wait `ms`, or less if the agent is stopping. */
  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Enrol on first run; afterwards load the saved identity. */
  async enrol(): Promise<Enrolment> {
    const state = new AgentState(this.config.stateDir);
    state.prepare();
    const { privateKey, publicKeyPem } = state.hostKey();
    let enrolment = state.enrolment();
    if (enrolment) {
      if (enrolment.apiUrl !== this.config.apiUrl || enrolment.hostName !== this.config.hostName) {
        throw new Error("This host is enrolled with another API or name; move the state directory aside to enrol again");
      }
      if (this.config.enrolmentToken) {
        this.log.warn("enrolment_token_still_set", { hint: "Remove COMPUTE_ENROLMENT_TOKEN from the env file: it is used once and no longer needed" });
      }
    } else {
      if (!this.config.enrolmentToken) {
        throw new Error("Not enrolled yet: set COMPUTE_ENROLMENT_TOKEN in the env file (Ops → Fleet → New enrolment token)");
      }
      const backoff = new Backoff(1000, this.config.backoffMaxMs, this.deps.random);
      for (;;) {
        try {
          const res = await this.deps.api.enrol({
            token: this.config.enrolmentToken,
            name: this.config.hostName,
            driver: this.deps.driver.name,
            publicKey: publicKeyPem,
            capacity: this.config.capacity,
          });
          enrolment = {
            hostId: res.hostId,
            hostName: this.config.hostName,
            apiUrl: this.config.apiUrl,
            jobSigningKeys: res.jobSigningKeys,
            enrolledAt: this.now().toISOString(),
          };
          state.saveEnrolment(enrolment);
          break;
        } catch (err) {
          if (err instanceof ApiUnreachable && !this.stopping) {
            const wait = backoff.next();
            this.log.warn("api_unreachable", { during: "enrol", retryInMs: wait });
            await this.sleep(wait);
            if (this.stopping) throw new Error("Stopped before enrolment finished");
            continue;
          }
          if (err instanceof ApiError) throw new Error(`Enrolment refused: ${err.code}`);
          throw err;
        }
      }
      this.log.info("enrolled", { hostId: enrolment.hostId, hostName: enrolment.hostName });
      if (this.deps.envFile) {
        if (wipeEnrolmentToken(this.deps.envFile)) {
          this.log.info("enrolment_token_removed", { envFile: this.deps.envFile });
        } else {
          this.log.warn("enrolment_token_not_removed", {
            envFile: this.deps.envFile,
            hint: "The env file is read-only to the agent: remove COMPUTE_ENROLMENT_TOKEN from it by hand",
          });
        }
      }
    }
    this.hostId = enrolment.hostId;
    this.jobKeys = AgentState.jobKeyRing(enrolment);
    this.deps.api.setIdentity({ hostId: enrolment.hostId, privateKey });
    return enrolment;
  }

  checkGuard(): GuardResult {
    this.guard = checkNetworkGuardFile(this.config.guardFile, {
      pilotCidr: this.config.pilotCidr,
      productionCidr: this.config.productionCidr,
      bridge: this.config.bridge,
      productionBridge: this.config.productionBridge,
    });
    if (this.guard.ok) this.log.info("network_guard_ok", {});
    else this.log.error("network_guard_missing", { missing: this.guard.missing, rulesFile: this.config.guardFile });
    return this.guard;
  }

  /** Run until `stop()`. */
  async run(): Promise<void> {
    await this.enrol();
    this.checkGuard();
    this.log.info("agent_started", {
      hostId: this.hostId,
      driver: this.deps.driver.name,
      dryRun: this.config.dryRun,
      networkGuard: this.guard.ok,
    });
    const usage = this.usageLoop();
    if (this.config.ensureImages && this.guard.ok) await this.ensureImages();
    if (!this.config.ensureImages) await this.checkTemplates();
    const backoff = new Backoff(1000, this.config.backoffMaxMs, this.deps.random);
    let lastGuardLog = Date.now();
    while (!this.stopping) {
      if (!this.guard.ok) {
        if (Date.now() - lastGuardLog > 300_000) {
          this.log.error("network_guard_missing", { missing: this.guard.missing, jobs: "not running" });
          lastGuardLog = Date.now();
        }
        await this.sleep(this.config.pollMs);
        continue;
      }
      let job: SignedJob | null;
      try {
        job = await this.deps.api.claim();
        backoff.reset();
      } catch (err) {
        const wait = backoff.next();
        this.log.warn(err instanceof ApiUnreachable ? "api_unreachable" : "claim_failed", {
          ...(err instanceof ApiError ? { status: err.status, code: err.code } : {}),
          retryInMs: wait,
        });
        await this.sleep(wait);
        continue;
      }
      if (!job) {
        await this.sleep(this.config.pollMs);
        continue;
      }
      this.current = this.handle(job);
      await this.current;
      this.current = null;
    }
    await usage;
    this.log.info("agent_stopped", {});
  }

  /** Stop claiming, let the current job finish (up to the grace period), then return. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
    const current = this.current;
    if (current) {
      const grace = new Promise<void>((resolve) => setTimeout(resolve, this.config.shutdownGraceMs).unref());
      await Promise.race([current, grace]);
    }
  }

  private async ensureImages(): Promise<void> {
    if (!this.deps.driver.ensureImages) return;
    try {
      const results = await this.deps.driver.ensureImages();
      this.log.info("images_ready", { images: results.map((r) => ({ imageId: r.imageId, action: r.action })), dryRun: this.config.dryRun });
    } catch (err) {
      this.noteDriverError(err);
      this.log.error("images_failed", { code: err instanceof DriverError ? err.code : "error" });
    }
  }

  /**
   * F4: the founder builds the templates by hand, so the agent only checks
   * them (a read). Logs `templates_ok`, or one `templates_missing` line with
   * what is missing and what to do. Throws the driver's error when Proxmox
   * cannot be read; `checkTemplates` (at start) logs that instead.
   */
  private async readTemplates(): Promise<boolean> {
    const check = this.deps.driver.missingTemplates;
    if (!check) {
      this.templatesReady = true;
      return true;
    }
    const missing = await check.call(this.deps.driver);
    if (missing.length === 0) {
      if (!this.templatesReady) this.log.info("templates_ok", {});
      this.templatesReady = true;
      return true;
    }
    this.templatesReady = false;
    this.log.error(TEMPLATES_MISSING, {
      missing: missing.map((m) => ({ imageId: m.imageId, templateVmid: m.templateVmid })),
      jobs: "create jobs are refused until they exist",
      hint: "Build the templates by hand in the pool (Compute runbook, templates step); the agent checks again before the next create",
    });
    return false;
  }

  async checkTemplates(): Promise<boolean> {
    try {
      return await this.readTemplates();
    } catch (err) {
      this.noteDriverError(err);
      this.log.error("templates_unchecked", { code: err instanceof DriverError ? err.code : "error" });
      return false;
    }
  }

  /**
   * F9: a certificate that no longer matches the pin gets one plain line
   * with both fingerprints and the procedure to follow (at most every five
   * minutes while it lasts). Both values are public certificate data.
   */
  private noteDriverError(err: unknown): void {
    if (!(err instanceof TlsPinMismatchError) && !(err instanceof DriverError && err.code === PROXMOX_ERRORS.tlsPinMismatch)) return;
    const pinned = err instanceof TlsPinMismatchError ? err.pinnedFingerprint : "unknown";
    const presented = err instanceof TlsPinMismatchError ? err.presentedFingerprint : "unknown";
    const now = Date.now();
    if (this.lastPinLog && this.lastPinLog.presented === presented && now - this.lastPinLog.at < PIN_LOG_INTERVAL_MS) return;
    this.lastPinLog = { presented, at: now };
    this.log.error(PROXMOX_ERRORS.tlsPinMismatch, {
      pinnedFingerprint: pinned,
      presentedFingerprint: presented,
      action: "If the Proxmox certificate was renewed on purpose, set PROXMOX_TLS_FINGERPRINT to the presented value and restart the agent. Otherwise stop and investigate",
      doc: REPIN_DOC_URL,
    });
  }

  /** Verify, run and report one job. Never throws. */
  async handle(job: SignedJob): Promise<void> {
    this.handled += 1;
    const verified = verifyJob(job, { keys: this.jobKeys, hostId: this.hostId, now: this.now() });
    if (!verified.ok) {
      const env = (job as { envelope?: Partial<JobEnvelope> } | null)?.envelope;
      this.log.warn("job_refused", { reason: verified.reason, jobId: typeof env?.id === "string" && UUID_RE.test(env.id) ? env.id : null });
      // Tell the API, so the job is retried with a fresh envelope or ends; it
      // only accepts reports for this host's own leased jobs.
      if (env && typeof env.id === "string" && UUID_RE.test(env.id) && Number.isInteger(env.attempt) && (env.attempt as number) >= 1) {
        await this.report(() => this.deps.api.fail(env.id as string, env.attempt as number, `job_refused_${verified.reason}`));
      }
      return;
    }
    const envelope = verified.envelope;
    const fields = { jobId: envelope.id, type: envelope.type, instanceId: envelope.instanceId, attempt: envelope.attempt };
    const payload = JOB_PAYLOADS[envelope.type].safeParse(envelope.payload);
    if (!payload.success) {
      this.log.warn("job_invalid_payload", fields);
      await this.report(() => this.deps.api.fail(envelope.id, envelope.attempt, "invalid_payload"));
      return;
    }
    this.log.info("job_started", { ...fields, dryRun: this.config.dryRun });

    let leaseLost = false;
    const beat = setInterval(() => {
      this.deps.api.heartbeat(envelope.id, envelope.attempt).catch((err: unknown) => {
        if (err instanceof ApiError && (err.code === "lease_lost" || err.code === "lease_expired" || err.code === "job_not_found")) {
          leaseLost = true;
        }
        this.log.warn("heartbeat_failed", { ...fields, code: err instanceof ApiError ? err.code : "unreachable" });
      });
    }, this.config.heartbeatMs);

    let outcome: { ok: true; result?: ConsoleTicket } | { ok: false; error: string };
    try {
      const result = await this.execute(envelope, payload.data);
      outcome = { ok: true, ...(result ? { result } : {}) };
    } catch (err) {
      this.noteDriverError(err);
      outcome = { ok: false, error: err instanceof DriverError ? err.code : "driver_error" };
    } finally {
      clearInterval(beat);
    }
    if (leaseLost) {
      this.log.warn("job_lease_lost", fields);
      return;
    }
    if (this.config.dryRun) {
      // Nothing was changed on the host: never report success.
      this.log.info("job_dry_run", { ...fields, wouldHave: outcome.ok ? "succeeded" : outcome.error });
      await this.report(() => this.deps.api.fail(envelope.id, envelope.attempt, "dry_run"));
      return;
    }
    if (outcome.ok) {
      this.log.info("job_succeeded", fields);
      await this.report(() => this.deps.api.complete(envelope.id, envelope.attempt, outcome.result));
    } else {
      this.log.warn("job_failed", { ...fields, error: outcome.error });
      await this.report(() => this.deps.api.fail(envelope.id, envelope.attempt, outcome.error));
    }
  }

  private async execute(envelope: JobEnvelope, payload: unknown): Promise<ConsoleTicket | undefined> {
    const d = this.deps.driver;
    const id = envelope.instanceId;
    switch (envelope.type) {
      case "create": {
        if (!this.config.ensureImages && !this.templatesReady && !(await this.readTemplates())) {
          throw new DriverError(TEMPLATES_MISSING, "An image template is missing on this host", false);
        }
        const c = payload as CreateJobPayload;
        await d.create({ instanceId: id, spec: c.spec, privateIp: c.privateIp, network: c.network });
        return undefined;
      }
      case "start":
        await d.start(id);
        return undefined;
      case "stop":
        await d.stop(id);
        return undefined;
      case "delete":
        await d.delete(id);
        return undefined;
      case "resize": {
        const r = payload as ResizeJobPayload;
        await d.resize(id, { vcpu: r.vcpu, memoryMb: r.memoryMb, diskGb: r.diskGb });
        return undefined;
      }
      case "snapshot":
        await d.snapshot(id, (payload as SnapshotJobPayload).snapshotName);
        return undefined;
      case "snapshot_delete":
        await d.deleteSnapshot(id, (payload as SnapshotJobPayload).snapshotName);
        return undefined;
      case "console":
        return d.console(id);
    }
  }

  /** Send a job report, retrying while the API is unreachable (the lease still runs). */
  private async report(send: () => Promise<void>): Promise<void> {
    const backoff = new Backoff(500, Math.min(this.config.backoffMaxMs, 15_000), this.deps.random);
    for (let i = 0; i < 6; i += 1) {
      try {
        await send();
        return;
      } catch (err) {
        if (err instanceof ApiError) {
          // lease_lost and friends: the API has moved on; nothing to retry.
          this.log.warn("report_refused", { status: err.status, code: err.code });
          return;
        }
        await this.sleep(backoff.next());
      }
    }
    this.log.error("report_failed", { hint: "the lease will expire and the API will retry the job" });
  }

  private async usageLoop(): Promise<void> {
    while (!this.stopping) {
      await this.sleep(this.config.usageMs);
      if (this.stopping) break;
      await this.reportUsage();
    }
  }

  /** One usage report: every VM the driver manages, with its power state and the interval since the last report. */
  async reportUsage(): Promise<number> {
    let vms;
    try {
      vms = await this.deps.driver.list();
    } catch (err) {
      this.noteDriverError(err);
      this.log.warn("usage_list_failed", { code: err instanceof DriverError ? err.code : "error" });
      return 0;
    }
    const now = this.now();
    const elapsed = this.lastUsageAt ? (now.getTime() - this.lastUsageAt.getTime()) / 1000 : this.config.usageMs / 1000;
    this.lastUsageAt = now;
    const intervalSeconds = Math.min(3600, Math.max(1, Math.round(elapsed)));
    const samples: AgentUsageSample[] = vms.map((vm) => ({
      instanceId: vm.instanceId,
      sampledAt: now.toISOString(),
      intervalSeconds,
      powerState: vm.power,
    }));
    if (samples.length === 0) return 0;
    try {
      await this.deps.api.usage(samples);
      return samples.length;
    } catch (err) {
      if (err instanceof ApiError && err.code === "unknown_instance" && samples.length > 1) {
        // One VM the API does not know (for example deleted there) must not drop the others.
        let sent = 0;
        for (const sample of samples) {
          try {
            await this.deps.api.usage([sample]);
            sent += 1;
          } catch {
            this.log.warn("usage_sample_refused", { instanceId: sample.instanceId });
          }
        }
        return sent;
      }
      this.log.warn("usage_report_failed", err instanceof ApiError ? { status: err.status, code: err.code } : { code: "unreachable" });
      return 0;
    }
  }
}
