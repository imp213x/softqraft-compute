/**
 * Jobs: the signed work queue between the API and host agents.
 *
 * - `enqueue` adds a job inside the caller's transaction.
 * - An agent `claim`s its oldest queued job and receives a signed envelope;
 *   the claim leases the job and counts an attempt.
 * - `heartbeat` extends the lease. `complete` and `fail` report the outcome
 *   for the attempt the agent holds.
 * - A failed attempt goes back to the queue until COMPUTE_JOB_MAX_ATTEMPTS
 *   is reached; then the job and its instance go to `error`.
 * - An expired lease returns the job to the queue the same way.
 *
 * Envelopes, signatures and keys are never logged.
 */

import { randomUUID, type KeyObject } from "node:crypto";
import type { JobPayload, JobType, SignedJob } from "@softqraft/compute-contracts";
import { publicKeyPem, signJob } from "@softqraft/compute-jobs";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, JobRow, StoreTx } from "../../store/index.js";

export { registerAgentJobRoutes } from "./routes.js";

/** What happens to an instance when its job ends. Supplied by the instances module. */
export interface JobOutcomeHandler {
  succeeded(tx: StoreTx, job: JobRow, now: Date): Promise<void>;
  failed(tx: StoreTx, job: JobRow, now: Date): Promise<void>;
}

export interface JobsDeps {
  store: ComputeStore;
  signing: { keyId: string; privateKey: KeyObject };
  maxAttempts: number;
  leaseSeconds: number;
  envelopeTtlSeconds: number;
  outcomes: JobOutcomeHandler;
  /**
   * Runs before every claim. The instances module places pending instances
   * here, so a host that has just become active receives them on its first
   * claim.
   */
  beforeClaim?: (now: Date) => Promise<void>;
}

export interface Jobs {
  enqueue(
    tx: StoreTx,
    input: { hostId: string; instanceId: string; type: JobType; payload: JobPayload; now: Date },
  ): Promise<JobRow>;
  claim(hostId: string, now: Date): Promise<SignedJob | null>;
  heartbeat(hostId: string, jobId: string, attempt: number, now: Date): Promise<Date>;
  complete(hostId: string, jobId: string, attempt: number, now: Date): Promise<JobRow>;
  fail(hostId: string, jobId: string, attempt: number, error: string, now: Date): Promise<JobRow>;
  /** Return expired leases to the queue, or fail them after the last attempt. */
  reapExpiredLeases(now: Date): Promise<number>;
  /** `{ keyId: SPKI PEM }` for agents to verify envelopes. */
  publicKeys(): Record<string, string>;
}

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

export function createJobs(deps: JobsDeps): Jobs {
  const pem = publicKeyPem(deps.signing.privateKey);

  /** Requeue or finally fail a leased job. */
  async function endAttempt(tx: StoreTx, job: JobRow, error: string, now: Date): Promise<JobRow> {
    const next: JobRow = { ...job, leaseExpiresAt: null, lastError: error.slice(0, 500), updatedAt: now };
    if (job.attempt >= job.maxAttempts) {
      next.state = "failed";
      await tx.updateJob(next);
      await deps.outcomes.failed(tx, next, now);
    } else {
      next.state = "queued";
      await tx.updateJob(next);
    }
    return next;
  }

  async function heldJob(tx: StoreTx, hostId: string, jobId: string, attempt: number): Promise<JobRow> {
    const job = await tx.getJob(jobId);
    // Another host's job reads as unknown, so ids cannot be probed.
    if (!job || job.hostId !== hostId) throw new HttpError(404, "job_not_found", "Job not found");
    if (job.state !== "leased" || job.attempt !== attempt) {
      throw new HttpError(409, "lease_lost", "This attempt no longer holds the job");
    }
    return job;
  }

  async function reap(tx: StoreTx, now: Date): Promise<number> {
    const expired = await tx.listExpiredLeases(now);
    for (const job of expired) await endAttempt(tx, job, "lease_expired", now);
    return expired.length;
  }

  return {
    async enqueue(tx, input) {
      const job: JobRow = {
        id: randomUUID(),
        hostId: input.hostId,
        instanceId: input.instanceId,
        type: input.type,
        payload: input.payload as unknown as Record<string, unknown>,
        state: "queued",
        attempt: 0,
        maxAttempts: deps.maxAttempts,
        leaseExpiresAt: null,
        lastError: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      await tx.insertJob(job);
      return job;
    },

    async claim(hostId, now) {
      if (deps.beforeClaim) await deps.beforeClaim(now);
      return deps.store.transaction(async (tx) => {
        await reap(tx, now);
        const job = await tx.leaseNextJob(hostId, now, addSeconds(now, deps.leaseSeconds));
        if (!job) return null;
        return signJob(
          {
            id: job.id,
            hostId: job.hostId,
            type: job.type,
            payload: job.payload,
            instanceId: job.instanceId,
            attempt: job.attempt,
            issuedAt: now.toISOString(),
            expiresAt: addSeconds(now, deps.envelopeTtlSeconds).toISOString(),
          },
          deps.signing.privateKey,
          deps.signing.keyId,
        );
      });
    },

    async heartbeat(hostId, jobId, attempt, now) {
      const result = await deps.store.transaction(async (tx) => {
        const job = await heldJob(tx, hostId, jobId, attempt);
        if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= now.getTime()) {
          // Commit the requeue (or final failure), then tell the agent.
          await endAttempt(tx, job, "lease_expired", now);
          return null;
        }
        const leaseExpiresAt = addSeconds(now, deps.leaseSeconds);
        await tx.updateJob({ ...job, leaseExpiresAt, updatedAt: now });
        return leaseExpiresAt;
      });
      if (!result) {
        throw new HttpError(409, "lease_expired", "The lease expired; the job was returned to the queue");
      }
      return result;
    },

    async complete(hostId, jobId, attempt, now) {
      return deps.store.transaction(async (tx) => {
        const job = await heldJob(tx, hostId, jobId, attempt);
        const done: JobRow = { ...job, state: "succeeded", leaseExpiresAt: null, updatedAt: now };
        await tx.updateJob(done);
        await deps.outcomes.succeeded(tx, done, now);
        return done;
      });
    },

    async fail(hostId, jobId, attempt, error, now) {
      return deps.store.transaction(async (tx) => {
        const job = await heldJob(tx, hostId, jobId, attempt);
        return endAttempt(tx, job, error, now);
      });
    },

    async reapExpiredLeases(now) {
      return deps.store.transaction((tx) => reap(tx, now));
    },

    publicKeys() {
      return { [deps.signing.keyId]: pem };
    },
  };
}
