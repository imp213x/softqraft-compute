import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitByHour, toUsageRecord } from "./index.js";

describe("splitByHour", () => {
  it("keeps a sample inside one hour", () => {
    assert.deepEqual(splitByHour(new Date("2026-10-07T10:30:00Z"), 600), [
      { hourStart: new Date("2026-10-07T10:00:00Z"), seconds: 600 },
    ]);
  });

  it("splits a sample across an hour boundary", () => {
    assert.deepEqual(splitByHour(new Date("2026-10-07T11:05:00Z"), 600), [
      { hourStart: new Date("2026-10-07T10:00:00Z"), seconds: 300 },
      { hourStart: new Date("2026-10-07T11:00:00Z"), seconds: 300 },
    ]);
  });

  it("puts a sample ending exactly on the hour into the hour before", () => {
    assert.deepEqual(splitByHour(new Date("2026-10-07T11:00:00Z"), 3600), [
      { hourStart: new Date("2026-10-07T10:00:00Z"), seconds: 3600 },
    ]);
  });
});

describe("toUsageRecord", () => {
  it("turns seconds into hours", () => {
    const r = toUsageRecord({
      serviceInstanceId: "si_1",
      hourStart: new Date("2026-10-07T10:00:00Z"),
      vcpuSeconds: 2 * 3600,
      memoryMbSeconds: 1024 * 1800,
      diskGbSeconds: 20 * 3600,
    });
    assert.deepEqual(r, {
      serviceInstanceId: "si_1",
      hourStart: "2026-10-07T10:00:00.000Z",
      vcpuHours: 2,
      memoryGbHours: 0.5,
      diskGbHours: 20,
    });
  });
});
