/**
 * Usage: the host agent reports samples; the API stores them and adds them
 * into per-service-instance, per-UTC-hour records of vCPU-hours, memory GB-hours and
 * disk GB-hours. No prices (decision D7); Cloud prices from the ledger.
 *
 * Metering rule: vCPU and memory count while the instance is running; disk
 * counts while it exists. Sizes come from the API's own record of the
 * instance, never from the agent: the size in force at the sample's
 * `sampledAt` (from the instance's size history), so a late sample from
 * before a resize is metered at the old size. A sample repeated with the same
 * (instanceId, sampledAt) is ignored, so retries never double count.
 * A sample that spans an hour boundary is split between the two hours.
 */

import type { AgentUsageSample, UsageRecord } from "@softqraft/compute-contracts";
import { HttpError } from "../../lib/errors.js";
import type { ComputeStore, HostRow, UsageRecordRow } from "../../store/index.js";

export { registerAgentUsageRoutes, registerCloudUsageRoutes, registerConsoleUsageRoutes } from "./routes.js";

const HOUR_MS = 3_600_000;
/** Samples may be at most this far in the future (clock drift). */
const MAX_FUTURE_MS = 300_000;
/** And at most this old. */
const MAX_AGE_MS = 7 * 24 * HOUR_MS;
/** Longest range one usage query may cover. */
export const MAX_QUERY_RANGE_MS = 31 * 24 * HOUR_MS;

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

export interface Usage {
  ingest(host: HostRow, samples: AgentUsageSample[], now: Date): Promise<IngestResult>;
  records(serviceInstanceId: string, from: Date, to: Date): Promise<UsageRecord[]>;
}

/** Split [end − seconds, end] into whole-second slices per UTC hour. */
export function splitByHour(end: Date, seconds: number): Array<{ hourStart: Date; seconds: number }> {
  const out: Array<{ hourStart: Date; seconds: number }> = [];
  let endMs = end.getTime();
  let remaining = seconds * 1000;
  while (remaining > 0) {
    // The hour that contains the instant just before endMs.
    const hourStartMs = Math.floor((endMs - 1) / HOUR_MS) * HOUR_MS;
    const sliceMs = Math.min(remaining, endMs - hourStartMs);
    out.push({ hourStart: new Date(hourStartMs), seconds: sliceMs / 1000 });
    remaining -= sliceMs;
    endMs -= sliceMs;
  }
  return out.reverse();
}

export function toUsageRecord(row: UsageRecordRow): UsageRecord {
  return {
    serviceInstanceId: row.serviceInstanceId,
    hourStart: row.hourStart.toISOString(),
    vcpuHours: row.vcpuSeconds / 3600,
    memoryGbHours: row.memoryMbSeconds / 1024 / 3600,
    diskGbHours: row.diskGbSeconds / 3600,
  };
}

export function createUsage(deps: { store: ComputeStore }): Usage {
  return {
    async ingest(host, samples, now) {
      return deps.store.transaction(async (tx) => {
        let accepted = 0;
        let duplicates = 0;
        for (const sample of samples) {
          const sampledAt = new Date(sample.sampledAt);
          const age = now.getTime() - sampledAt.getTime();
          if (age < -MAX_FUTURE_MS || age > MAX_AGE_MS) {
            throw new HttpError(400, "sample_out_of_range", "sampledAt is too far from the current time");
          }
          const instance = await tx.getInstance(sample.instanceId);
          // An instance that is not on this host reads as unknown.
          if (!instance || instance.hostId !== host.id) {
            throw new HttpError(400, "unknown_instance", "A sample names an instance this host does not run");
          }
          const size = (await tx.instanceSizeAt(instance.id, sampledAt)) ?? instance.spec;
          const inserted = await tx.insertUsageSample({
            instanceId: instance.id,
            hostId: host.id,
            serviceInstanceId: instance.serviceInstanceId,
            sampledAt,
            intervalSeconds: sample.intervalSeconds,
            powerState: sample.powerState,
            vcpu: size.vcpu,
            memoryMb: size.memoryMb,
            diskGb: size.diskGb,
          });
          if (!inserted) {
            duplicates += 1;
            continue;
          }
          accepted += 1;
          const running = sample.powerState === "running";
          for (const slice of splitByHour(sampledAt, sample.intervalSeconds)) {
            await tx.addUsage({
              serviceInstanceId: instance.serviceInstanceId,
              hourStart: slice.hourStart,
              vcpuSeconds: running ? Math.round(size.vcpu * slice.seconds) : 0,
              memoryMbSeconds: running ? Math.round(size.memoryMb * slice.seconds) : 0,
              diskGbSeconds: Math.round(size.diskGb * slice.seconds),
            });
          }
        }
        return { accepted, duplicates };
      });
    },

    async records(serviceInstanceId, from, to) {
      return deps.store.transaction(async (tx) =>
        (await tx.listUsageRecords(serviceInstanceId, from, to)).map(toUsageRecord),
      );
    },
  };
}
