/**
 * Behaviour that must hold on every store. `memory-store.test.ts` runs it on
 * the in-memory store; `postgres.pg-test.ts` runs it on real Postgres.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Instance } from "@softqraft/compute-contracts";
import { DriverError } from "@softqraft/compute-driver";
import type { ComputeStore } from "../src/store/index.js";
import { harness, idempotencyKey, instanceOf, SI, type Harness } from "./helpers.js";

export type StoreFactory = () => Promise<ComputeStore>;

async function getInstance(h: Harness, id: string): Promise<Instance> {
  const res = await h.console("GET", `/console/v1/instances/${id}`);
  assert.equal(res.statusCode, 200, res.body);
  return instanceOf(res);
}

export function behaviourSuite(label: string, makeStore: StoreFactory): void {
  describe(`${label}: instance lifecycle through a fake agent`, () => {
    let h: Harness;
    before(async () => {
      h = await harness({ store: await makeStore() });
    });
    after(async () => {
      await h.close();
      await h.store.close();
    });

    it("keeps an instance pending with a reason when no host is active", async () => {
      const res = await h.createInstance({ name: "early" });
      assert.equal(res.statusCode, 201, res.body);
      const inst = instanceOf(res);
      assert.equal(inst.state, "pending");
      assert.equal(inst.pendingReason, "no_active_host");
      assert.equal(inst.hostId, null);
      assert.equal(inst.privateIp, "10.30.0.2");
    });

    it("places the pending instance when the host becomes active, and runs the whole loop", async () => {
      const agent = await h.enrolAgent();
      // The first signed call activates the host; the claim then places pending work.
      const ran = await agent.drain();
      assert.equal(ran, 1);
      const [early] = (await h.console("GET", `/console/v1/instances`)).json().instances as Instance[];
      assert.equal(early!.state, "running");
      assert.equal(early!.hostId, agent.hostId);
      assert.equal(early!.pendingReason, null);

      const created = instanceOf(await h.createInstance({ name: "loop" }));
      assert.equal(created.state, "provisioning");
      assert.equal(created.privateIp, "10.30.0.3");
      await agent.drain();
      assert.equal((await getInstance(h, created.id)).state, "running");
      assert.equal((await agent.driver.status(created.id)).power, "running");

      const stop = await h.console("POST", `/console/v1/instances/${created.id}/actions`, { action: "stop" });
      assert.equal(stop.statusCode, 202, stop.body);
      assert.equal(instanceOf(stop).state, "stopping");
      const again = await h.console("POST", `/console/v1/instances/${created.id}/actions`, { action: "stop" });
      assert.equal(again.statusCode, 409);
      assert.equal(again.json().error.code, "invalid_state");
      await agent.drain();
      assert.equal((await getInstance(h, created.id)).state, "stopped");

      const start = await h.console("POST", `/console/v1/instances/${created.id}/actions`, { action: "start" });
      assert.equal(instanceOf(start).state, "starting");
      await agent.drain();
      assert.equal((await getInstance(h, created.id)).state, "running");

      const del = await h.console("DELETE", `/console/v1/instances/${created.id}`);
      assert.equal(del.statusCode, 202);
      assert.equal(instanceOf(del).state, "deleting");
      await agent.drain();
      assert.equal((await getInstance(h, created.id)).state, "deleted");
      assert.equal((await agent.driver.status(created.id)).power, "absent");

      // Deleted instances leave the list, and their address is free again.
      const list = (await h.console("GET", `/console/v1/instances`)).json().instances as Instance[];
      assert.deepEqual(list.map((i) => i.spec.name), ["early"]);
      const reuse = instanceOf(await h.createInstance({ name: "after-delete" }));
      assert.equal(reuse.privateIp, "10.30.0.3");
      await agent.drain();

      // Clean up for the next tests.
      for (const i of [early!, reuse]) await h.console("DELETE", `/console/v1/instances/${i.id}`);
      await agent.drain();
    });

    it("deletes a never-placed instance at once", async () => {
      const agentless = await harness({ store: await makeStore() });
      try {
        const inst = instanceOf(await agentless.createInstance({ name: "lonely" }));
        const del = await agentless.console("DELETE", `/console/v1/instances/${inst.id}`);
        assert.equal(del.statusCode, 202);
        assert.equal(instanceOf(del).state, "deleted");
      } finally {
        await agentless.close();
        await agentless.store.close();
      }
    });
  });

  describe(`${label}: idempotency`, () => {
    let h: Harness;
    before(async () => {
      h = await harness({ store: await makeStore() });
    });
    after(async () => {
      await h.close();
      await h.store.close();
    });

    it("returns the same instance for a repeated key and body", async () => {
      const key = idempotencyKey();
      const first = await h.createInstance({ name: "idem" }, key);
      const second = await h.createInstance({ name: "idem" }, key);
      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 200);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.equal(instanceOf(first).id, instanceOf(second).id);
      const list = (await h.console("GET", `/console/v1/instances`)).json().instances as Instance[];
      assert.equal(list.filter((i) => i.spec.name === "idem").length, 1);
    });

    it("refuses a reused key with a different body", async () => {
      const key = idempotencyKey();
      await h.createInstance({ name: "idem-b" }, key);
      const res = await h.createInstance({ name: "idem-b", vcpu: 2 }, key);
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, "idempotency_key_reused");
    });

    it("creates once when the same key arrives concurrently", async () => {
      const key = idempotencyKey();
      const results = await Promise.all(Array.from({ length: 5 }, () => h.createInstance({ name: "idem-c" }, key)));
      const ids = new Set(results.map((r) => instanceOf(r).id));
      assert.equal(ids.size, 1);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 200, 200, 200, 201]);
    });
  });

  describe(`${label}: pool caps under concurrency`, () => {
    let h: Harness;
    before(async () => {
      h = await harness({ store: await makeStore() });
    });
    after(async () => {
      await h.close();
      await h.store.close();
    });

    it("lets exactly two of ten concurrent 2-vCPU creates through a 4-vCPU pool", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => h.createInstance({ name: `burst-${i}`, vcpu: 2, memoryMb: 1024 })),
      );
      const ok = results.filter((r) => r.statusCode === 201);
      const refused = results.filter((r) => r.statusCode === 409);
      assert.equal(ok.length, 2, results.map((r) => `${r.statusCode} ${r.body}`).join("\n"));
      assert.equal(refused.length, 8);
      for (const r of refused) assert.equal(r.json().error.code, "quota_exceeded");
      const addresses = new Set(ok.map((r) => instanceOf(r).privateIp));
      assert.equal(addresses.size, 2, "no address is handed out twice");
    });

    it("enforces the instance, memory and disk caps", async () => {
      const fresh = await harness({ store: await makeStore() });
      try {
        // memory: 8192 MB pool
        assert.equal((await fresh.createInstance({ name: "m1", memoryMb: 8192 })).statusCode, 201);
        const mem = await fresh.createInstance({ name: "m2", memoryMb: 512 });
        assert.equal(mem.statusCode, 409);
        assert.match(mem.json().error.message, /memoryMb/);
      } finally {
        await fresh.close();
        await fresh.store.close();
      }
      const disk = await harness({ store: await makeStore() });
      try {
        assert.equal((await disk.createInstance({ name: "d1", diskGb: 100, memoryMb: 512 })).statusCode, 201);
        const res = await disk.createInstance({ name: "d2", diskGb: 30, memoryMb: 512 });
        assert.equal(res.statusCode, 409);
        assert.match(res.json().error.message, /diskGb/);
      } finally {
        await disk.close();
        await disk.store.close();
      }
      const count = await harness({ store: await makeStore() });
      try {
        for (const n of ["c1", "c2", "c3"]) {
          assert.equal((await count.createInstance({ name: n, memoryMb: 512, diskGb: 10 })).statusCode, 201);
        }
        const res = await count.createInstance({ name: "c4", memoryMb: 512, diskGb: 10 });
        assert.equal(res.statusCode, 409);
        assert.match(res.json().error.message, /instances/);
      } finally {
        await count.close();
        await count.store.close();
      }
    });
  });

  describe(`${label}: retries and leases`, () => {
    let h: Harness;
    before(async () => {
      h = await harness({ store: await makeStore(), env: { COMPUTE_JOB_LEASE_SECONDS: "60" } });
    });
    after(async () => {
      await h.close();
      await h.store.close();
    });

    it("retries a failed create and succeeds on the third attempt", async () => {
      const agent = await h.enrolAgent("retry-host");
      await agent.claim(); // activates the host; nothing queued yet
      const inst = instanceOf(await h.createInstance({ name: "flaky", memoryMb: 512 }));
      agent.driver.failNext("create", new DriverError("transient", "scripted", true), 2);
      const first = await agent.step();
      const second = await agent.step();
      const third = await agent.step();
      assert.deepEqual([first?.outcome, second?.outcome, third?.outcome], ["fail", "fail", "complete"]);
      assert.deepEqual(
        [first?.job.envelope.attempt, second?.job.envelope.attempt, third?.job.envelope.attempt],
        [1, 2, 3],
      );
      assert.equal(first?.job.envelope.id, third?.job.envelope.id);
      assert.equal((await getInstance(h, inst.id)).state, "running");
    });

    it("sends the job and its instance to error after the last attempt", async () => {
      const agent = await h.enrolAgent("doomed-host");
      await agent.claim();
      // Drain the retry host so new work lands here: put it in draining via the service.
      const hosts = await h.services.hosts.list();
      for (const host of hosts) if (host.name !== "doomed-host") await h.services.hosts.drain(host.id);
      const inst = instanceOf(await h.createInstance({ name: "doomed", memoryMb: 512 }));
      assert.equal(inst.hostId, agent.hostId);
      agent.driver.failNext("create", new DriverError("broken", "scripted", false), 3);
      const outcomes = [await agent.step(), await agent.step(), await agent.step()];
      assert.deepEqual(outcomes.map((o) => o?.outcome), ["fail", "fail", "fail"]);
      assert.equal(await agent.claim(), null, "no fourth attempt");
      const final = await getInstance(h, inst.id);
      assert.equal(final.state, "error");
      const jobs = await h.store.transaction((tx) => tx.listJobsForInstance(inst.id));
      assert.equal(jobs[0]!.state, "failed");
      assert.equal(jobs[0]!.attempt, 3);
      assert.equal(jobs[0]!.lastError, "broken");
      // An errored instance can be deleted.
      const del = await h.console("DELETE", `/console/v1/instances/${inst.id}`);
      assert.equal(instanceOf(del).state, "deleting");
      await agent.drain();
      assert.equal((await getInstance(h, inst.id)).state, "deleted");
    });

    it("returns a job to the queue when its lease expires, and heartbeats extend leases", async () => {
      const agent = await h.enrolAgent("lease-host");
      await agent.claim();
      const hosts = await h.services.hosts.list();
      for (const host of hosts) if (host.name !== "lease-host") await h.services.hosts.drain(host.id);
      const inst = instanceOf(await h.createInstance({ name: "leased", memoryMb: 512 }));
      const job = await agent.claim();
      assert.ok(job);
      assert.equal(job.envelope.attempt, 1);

      h.clock.advance(50);
      const hb = await agent.request("POST", `/v1/agent/jobs/${job.envelope.id}/heartbeat`, { attempt: 1 });
      assert.equal(hb.statusCode, 200, hb.body);
      assert.equal(hb.json().leaseExpiresAt, new Date(h.clock.current.getTime() + 60_000).toISOString());

      h.clock.advance(50); // still inside the extended lease
      assert.equal(await agent.claim(), null);

      h.clock.advance(11); // lease over
      const again = await agent.claim();
      assert.ok(again);
      assert.equal(again.envelope.id, job.envelope.id);
      assert.equal(again.envelope.attempt, 2);

      // The first attempt can no longer report.
      const stale = await agent.request("POST", `/v1/agent/jobs/${job.envelope.id}/complete`, { attempt: 1 });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error.code, "lease_lost");

      // A heartbeat after expiry is refused and requeues the job.
      h.clock.advance(61);
      const late = await agent.request("POST", `/v1/agent/jobs/${job.envelope.id}/heartbeat`, { attempt: 2 });
      assert.equal(late.statusCode, 409);
      assert.equal(late.json().error.code, "lease_expired");

      // Third attempt expires too: that was the last one.
      const third = await agent.claim();
      assert.equal(third?.envelope.attempt, 3);
      h.clock.advance(61);
      await h.services.maintenance(h.clock.now());
      assert.equal((await getInstance(h, inst.id)).state, "error");
      assert.equal(await agent.claim(), null);
    });
  });

  describe(`${label}: drain and placement`, () => {
    it("never places new instances on a draining host", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        await h.services.hosts.drain(agent.hostId);
        const inst = instanceOf(await h.createInstance({ name: "drained" }));
        assert.equal(inst.state, "pending");
        assert.equal(inst.pendingReason, "no_active_host");
      } finally {
        await h.close();
        await h.store.close();
      }
    });

    it("reports no_host_capacity when the only host is full", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent("tiny", { vcpu: 1, memoryMb: 1024, diskGb: 20 });
        await agent.claim();
        assert.equal(instanceOf(await h.createInstance({ name: "fits" })).state, "provisioning");
        const second = instanceOf(await h.createInstance({ name: "no-room" }));
        assert.equal(second.state, "pending");
        assert.equal(second.pendingReason, "no_host_capacity");
      } finally {
        await h.close();
        await h.store.close();
      }
    });
  });

  describe(`${label}: enrolment tokens`, () => {
    it("works once, then never again, and expires", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const { publicKey } = (await import("node:crypto")).generateKeyPairSync("ed25519");
        const spki = publicKey.export({ type: "spki", format: "pem" }).toString();
        const body = (token: string, name: string) => ({
          token,
          name,
          driver: "fake",
          publicKey: spki,
          capacity: { vcpu: 4, memoryMb: 8192, diskGb: 120 },
        });
        const t1 = await h.services.hosts.createEnrolmentToken({ now: h.clock.now() });
        const ok = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: body(t1.token, "host-a") });
        assert.equal(ok.statusCode, 201, ok.body);
        assert.equal(ok.json().state, "enrolled");
        const reuse = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: body(t1.token, "host-b") });
        assert.equal(reuse.statusCode, 401);
        assert.equal(reuse.json().error.code, "enrolment_invalid");

        const bound = await h.services.hosts.createEnrolmentToken({ hostName: "host-c", now: h.clock.now() });
        const wrongName = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: body(bound.token, "host-x") });
        assert.equal(wrongName.statusCode, 401);
        const rightName = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: body(bound.token, "host-c") });
        assert.equal(rightName.statusCode, 201, "a refused attempt does not burn the token");

        const short = await h.services.hosts.createEnrolmentToken({ now: h.clock.now() });
        h.clock.advance(1799);
        const t3 = await h.services.hosts.createEnrolmentToken({ now: h.clock.now() });
        h.clock.advance(1);
        const expired = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: body(short.token, "host-d") });
        assert.equal(expired.statusCode, 401, "dead after exactly 30 minutes");
        const fresh = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: body(t3.token, "host-d") });
        assert.equal(fresh.statusCode, 201, "alive 1 second in");

        const t2 = await h.services.hosts.createEnrolmentToken({ now: h.clock.now() });
        const dup = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: body(t2.token, "host-a") });
        assert.equal(dup.statusCode, 409);
        assert.equal(dup.json().error.code, "host_name_taken");
      } finally {
        await h.close();
        await h.store.close();
      }
    });
  });

  describe(`${label}: usage`, () => {
    it("aggregates samples per project per hour and ignores repeats", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "metered", vcpu: 2, memoryMb: 2048, diskGb: 20 }));
        await agent.drain();
        const samples = [
          // 10:00-10:30 running
          { instanceId: inst.id, sampledAt: "2026-10-07T10:30:00.000Z", intervalSeconds: 1800, powerState: "running" },
          // 10:50-11:10 running, split 600 + 600
          { instanceId: inst.id, sampledAt: "2026-10-07T11:10:00.000Z", intervalSeconds: 1200, powerState: "running" },
          // 11:10-11:40 stopped: disk only
          { instanceId: inst.id, sampledAt: "2026-10-07T11:40:00.000Z", intervalSeconds: 1800, powerState: "stopped" },
        ];
        h.clock.current = new Date("2026-10-07T11:45:00.000Z");
        const res = await agent.request("POST", "/v1/agent/usage", { samples });
        assert.equal(res.statusCode, 202, res.body);
        assert.deepEqual(res.json(), { accepted: 3, duplicates: 0 });
        const repeat = await agent.request("POST", "/v1/agent/usage", { samples });
        assert.deepEqual(repeat.json(), { accepted: 0, duplicates: 3 });

        const usage = await h.console("GET", `/console/v1/usage?from=2026-10-07T00:00:00.000Z&to=2026-10-08T00:00:00.000Z`,
        );
        assert.equal(usage.statusCode, 200, usage.body);
        assert.deepEqual(usage.json().records, [
          {
            serviceInstanceId: SI,
            hourStart: "2026-10-07T10:00:00.000Z",
            vcpuHours: (2 * 2400) / 3600,
            memoryGbHours: (2 * 2400) / 3600,
            diskGbHours: (20 * 2400) / 3600,
          },
          {
            serviceInstanceId: SI,
            hourStart: "2026-10-07T11:00:00.000Z",
            vcpuHours: (2 * 600) / 3600,
            memoryGbHours: (2 * 600) / 3600,
            diskGbHours: (20 * 2400) / 3600,
          },
        ]);

        const other = await h.enrolAgent("other-host");
        const foreign = await other.request("POST", "/v1/agent/usage", {
          samples: [{ instanceId: inst.id, sampledAt: "2026-10-07T11:44:00.000Z", intervalSeconds: 60, powerState: "running" }],
        });
        assert.equal(foreign.statusCode, 400);
        assert.equal(foreign.json().error.code, "unknown_instance");
      } finally {
        await h.close();
        await h.store.close();
      }
    });
  });
}
