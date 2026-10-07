/**
 * Behaviour that must hold on every store. `memory-store.test.ts` runs it on
 * the in-memory store; `postgres.pg-test.ts` runs it on real Postgres.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CreateJobPayload, type Instance } from "@softqraft/compute-contracts";
import { DriverError } from "@softqraft/compute-driver";
import type { ComputeStore } from "../src/store/index.js";
import { harness, idempotencyKey, instanceOf, SI, type FakeAgent, type Harness } from "./helpers.js";

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

  describe(`${label}: resize, snapshots and console`, () => {
    let h: Harness;
    let agent: FakeAgent;
    let inst: Instance;
    let other: Instance;
    const act = (id: string, body: Record<string, unknown>) =>
      h.console("POST", `/console/v1/instances/${id}/actions`, body);
    before(async () => {
      h = await harness({ store: await makeStore() });
      agent = await h.enrolAgent();
      await agent.claim();
      inst = instanceOf(await h.createInstance({ name: "sizer", vcpu: 1, memoryMb: 1024, diskGb: 20 }));
      other = instanceOf(await h.createInstance({ name: "neighbour", vcpu: 1, memoryMb: 512, diskGb: 10 }));
      await agent.drain();
    });
    after(async () => {
      await h.close();
      await h.store.close();
    });

    it("resizes only a stopped instance, never shrinks the disk, and keeps the pool caps", async () => {
      const running = await act(inst.id, { action: "resize", vcpu: 2 });
      assert.equal(running.statusCode, 409);
      assert.equal(running.json().error.code, "invalid_state");
      await act(inst.id, { action: "stop" });
      await agent.drain();

      const shrink = await act(inst.id, { action: "resize", diskGb: 16 });
      assert.equal(shrink.statusCode, 400);
      assert.equal(shrink.json().error.code, "invalid_resize");
      const same = await act(inst.id, { action: "resize", vcpu: 1 });
      assert.equal(same.json().error.code, "invalid_resize");
      const tooBig = await act(inst.id, { action: "resize", vcpu: 4 });
      assert.equal(tooBig.statusCode, 409, "1 + 4 vCPU is over the 4-vCPU pool");
      assert.match(tooBig.json().error.message, /vcpu/);

      const ok = await act(inst.id, { action: "resize", vcpu: 2, memoryMb: 2048, diskGb: 32 });
      assert.equal(ok.statusCode, 202, ok.body);
      assert.equal(instanceOf(ok).state, "resizing");
      assert.deepEqual(
        [instanceOf(ok).spec.vcpu, instanceOf(ok).spec.memoryMb, instanceOf(ok).spec.diskGb],
        [2, 2048, 32],
      );
      await agent.drain();
      assert.equal((await getInstance(h, inst.id)).state, "stopped");
      assert.deepEqual(agent.driver.sizeOf(inst.id), { vcpu: 2, memoryMb: 2048, diskGb: 32 });
    });

    it("takes, lists and deletes snapshots, holding their disk against the pool", async () => {
      const base = `/console/v1/instances/${inst.id}/snapshots`;
      const taken = await h.console("POST", base, { name: "before-upgrade" });
      assert.equal(taken.statusCode, 202, taken.body);
      assert.equal(taken.json().snapshot.state, "creating");
      assert.equal(taken.json().snapshot.sizeGb, 32);
      const dup = await h.console("POST", base, { name: "before-upgrade" });
      assert.equal(dup.json().error.code, "snapshot_name_taken");
      await agent.drain();
      const listed = (await h.console("GET", base)).json().snapshots;
      assert.deepEqual(listed.map((x: { name: string; state: string }) => [x.name, x.state]), [["before-upgrade", "available"]]);
      assert.deepEqual(await agent.driver.listSnapshots(inst.id), [{ name: "before-upgrade" }]);

      // Pool disk: 32 + 10 + 32 = 74 GB; another 32 fits (106), a third does not (138 > 120).
      assert.equal((await h.console("POST", base, { name: "second" })).statusCode, 202);
      await agent.drain();
      const full = await h.console("POST", base, { name: "third" });
      assert.equal(full.statusCode, 409);
      assert.match(full.json().error.message, /diskGb/);
      const [host] = await h.services.hosts.list();
      assert.equal(host!.allocated.diskGb, 106, "host allocation counts snapshots");

      const second = (await h.console("GET", base)).json().snapshots.find((x: { name: string }) => x.name === "second");
      const del = await h.console("DELETE", `${base}/${second.id}`);
      assert.equal(del.statusCode, 202);
      assert.equal(del.json().snapshot.state, "deleting");
      const again = await h.console("DELETE", `${base}/${second.id}`);
      assert.equal(again.statusCode, 409);
      await agent.drain();
      assert.deepEqual((await h.console("GET", base)).json().snapshots.map((x: { name: string }) => x.name), ["before-upgrade"]);
      assert.deepEqual(await agent.driver.listSnapshots(inst.id), [{ name: "before-upgrade" }]);
      assert.equal((await h.console("DELETE", `${base}/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11`)).statusCode, 404);
      assert.equal((await h.console("POST", base, { name: "third" })).statusCode, 202, "the freed disk is usable again");
      await agent.drain();
    });

    it("marks a failed snapshot error without touching its instance", async () => {
      agent.driver.failNext("snapshot", new DriverError("broken", "scripted", false), 3);
      const res = await h.console("POST", `/console/v1/instances/${other.id}/snapshots`, { name: "doomed" });
      assert.equal(res.statusCode, 202, res.body);
      await agent.drain();
      const snaps = (await h.console("GET", `/console/v1/instances/${other.id}/snapshots`)).json().snapshots;
      assert.equal(snaps[0].state, "error");
      assert.equal((await getInstance(h, other.id)).state, "running");
      const del = await h.console("DELETE", `/console/v1/instances/${other.id}/snapshots/${snaps[0].id}`);
      assert.equal(del.statusCode, 202, "an errored snapshot can be deleted");
      await agent.drain();
    });

    it("hands out a console ticket from the agent, once, and never for a stopped instance", async () => {
      const stopped = await h.console("POST", `/console/v1/instances/${inst.id}/console`);
      assert.equal(stopped.statusCode, 409);

      const pending = h.console("POST", `/console/v1/instances/${other.id}/console`);
      let served = false;
      for (let i = 0; i < 200 && !served; i += 1) {
        const step = await agent.step();
        if (step?.job.envelope.type === "console") served = true;
        else await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(served, "the agent served a console job");
      const res = await pending;
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers["cache-control"], "no-store");
      const ticket = res.json().console;
      assert.equal(ticket.protocol, "vnc");
      assert.match(ticket.ticket, new RegExp(`^FAKEVNC:${other.id}:`));
      const jobs = await h.store.transaction((tx) => tx.listJobsForInstance(other.id));
      const consoleJob = jobs.find((j) => j.type === "console")!;
      assert.equal(consoleJob.result, null, "the ticket is not kept after it is handed over");
      assert.equal(consoleJob.maxAttempts, 1);
    });

    it("reports a failed console job as 502 and leaves the instance running", async () => {
      agent.driver.failNext("console", new DriverError("vm_not_running", "scripted", false));
      const pending = h.console("POST", `/console/v1/instances/${other.id}/console`);
      for (let i = 0; i < 200; i += 1) {
        const step = await agent.step();
        if (step?.job.envelope.type === "console") break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const res = await pending;
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().error.code, "console_unavailable");
      assert.equal((await getInstance(h, other.id)).state, "running");
    });

    it("marks snapshots deleted with their instance", async () => {
      const del = await h.console("DELETE", `/console/v1/instances/${inst.id}`);
      assert.equal(del.statusCode, 202);
      await agent.drain();
      const snaps = await h.store.transaction((tx) => tx.listSnapshots(inst.id, { includeDeleted: true }));
      assert.ok(snaps.length > 0);
      assert.ok(snaps.every((x) => x.state === "deleted"));
    });
  });

  describe(`${label}: console timeout`, () => {
    it("cancels a console job nobody answered, with 504", async () => {
      const h = await harness({ store: await makeStore(), env: { COMPUTE_CONSOLE_WAIT_SECONDS: "1" } });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "quiet" }));
        await agent.drain();
        const res = await h.console("POST", `/console/v1/instances/${inst.id}/console`);
        assert.equal(res.statusCode, 504);
        assert.equal(res.json().error.code, "console_timeout");
        assert.equal(await agent.claim(), null, "the cancelled job is never handed out");
        const jobs = await h.store.transaction((tx) => tx.listJobsForInstance(inst.id));
        assert.equal(jobs.find((j) => j.type === "console")?.lastError, "console_timeout");
      } finally {
        await h.close();
        await h.store.close();
      }
    });
  });

  describe(`${label}: kill switch`, () => {
    it("stops every running instance, lets the host claim only stops, and stops what comes up later", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const a = instanceOf(await h.createInstance({ name: "ks-a", memoryMb: 512 }));
        const b = instanceOf(await h.createInstance({ name: "ks-b", memoryMb: 512 }));
        await agent.drain();
        const late = instanceOf(await h.createInstance({ name: "ks-late", memoryMb: 512 }));
        const leased = await agent.claim();
        assert.equal(leased?.envelope.instanceId, late.id, "the create is mid-flight");

        const off = await h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/disable`);
        assert.equal(off.statusCode, 200, off.body);
        assert.equal(off.json().stopsQueued, 2);
        assert.equal((await getInstance(h, a.id)).state, "stopping");

        // The in-flight create finishes: the instance is stopped straight away.
        await agent.driver.create({ instanceId: late.id, ...CreateJobPayload.parse(leased!.envelope.payload) });
        const done = await agent.request("POST", `/v1/agent/jobs/${leased!.envelope.id}/complete`, { attempt: 1 });
        assert.equal(done.statusCode, 200, done.body);
        assert.equal((await getInstance(h, late.id)).state, "stopping");

        const types: string[] = [];
        for (let job = await agent.step(); job; job = await agent.step()) types.push(job.job.envelope.type);
        assert.deepEqual(types, ["stop", "stop", "stop"]);
        for (const i of [a, b, late]) assert.equal((await getInstance(h, i.id)).state, "stopped");

        const start = await h.console("POST", `/console/v1/instances/${a.id}/actions`, { action: "start" });
        assert.equal(start.statusCode, 409);
        assert.equal(start.json().error.code, "host_disabled");
        const snap = await h.console("POST", `/console/v1/instances/${a.id}/snapshots`, { name: "x" });
        assert.equal(snap.json().error.code, "host_disabled");

        const on = await h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/enable`);
        assert.equal(on.json().host.state, "active");
        assert.equal((await h.console("POST", `/console/v1/instances/${a.id}/actions`, { action: "start" })).statusCode, 202);
        await agent.drain();
        assert.equal((await getInstance(h, a.id)).state, "running");
        assert.equal((await getInstance(h, b.id)).state, "stopped", "enable does not restart anything");
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

        const cloud = await h.cloud(
          "GET",
          `/cloud/v1/service-instances/${SI}/usage?from=2026-10-07T00:00:00.000Z&to=2026-10-08T00:00:00.000Z`,
        );
        assert.equal(cloud.statusCode, 200, cloud.body);
        assert.deepEqual(cloud.json().usage, usage.json().records, "Cloud and Console read the same records");

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
