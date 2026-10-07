/**
 * Second review of PR #2: four findings, each pinned by a test that failed
 * before its fix. Runs on the memory store and on Postgres.
 *
 * 1. Usage was metered at the instance's current size, and a resize
 *    overwrote that size when it was requested, even if it then failed.
 * 2. The kill switch left VMs that were being deleted running: a disabled
 *    host could claim only stop jobs.
 * 3. (config, see api.test.ts) Secure cookies could be turned off.
 * 4. A fleet change committed before its audit event was written.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DriverError } from "@softqraft/compute-driver";
import type { ComputeStore } from "../src/store/index.js";
import { harness, instanceOf, SI } from "./helpers.js";
import { HookedStore } from "./hooked-store.js";

export type StoreFactory = () => Promise<ComputeStore>;

export function findingsSuite(label: string, makeStore: StoreFactory): void {
  describe(`${label}: review findings (PR #2, second round)`, () => {
    it("finding 1: a late sample from before a resize is metered at the size it ran with", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "metered", vcpu: 1, memoryMb: 1024, diskGb: 20 }));
        await agent.drain();
        h.clock.advance(3600); // 11:00
        await h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "stop" });
        await agent.drain();
        await h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "resize", vcpu: 2, memoryMb: 2048, diskGb: 32 });
        await agent.drain();
        await h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "start" });
        await agent.drain();
        h.clock.advance(1800); // 11:30

        // Reported after the resize, about 10:00-10:30, when it was small.
        const late = await agent.request("POST", "/v1/agent/usage", {
          samples: [{ instanceId: inst.id, sampledAt: "2026-10-07T10:30:00.000Z", intervalSeconds: 1800, powerState: "running" }],
        });
        assert.equal(late.statusCode, 202, late.body);
        const now = await agent.request("POST", "/v1/agent/usage", {
          samples: [{ instanceId: inst.id, sampledAt: "2026-10-07T11:30:00.000Z", intervalSeconds: 1800, powerState: "running" }],
        });
        assert.equal(now.statusCode, 202, now.body);

        const records = (
          await h.console("GET", "/console/v1/usage?from=2026-10-07T00:00:00.000Z&to=2026-10-08T00:00:00.000Z")
        ).json().records;
        assert.deepEqual(records, [
          { serviceInstanceId: SI, hourStart: "2026-10-07T10:00:00.000Z", vcpuHours: 0.5, memoryGbHours: 0.5, diskGbHours: 10 },
          { serviceInstanceId: SI, hourStart: "2026-10-07T11:00:00.000Z", vcpuHours: 1, memoryGbHours: 1, diskGbHours: 16 },
        ]);
      } finally {
        await h.close();
        await h.store.close();
      }
    });

    it("finding 1: a resize holds its target while pending, and a failed resize changes nothing", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "shrinker", vcpu: 1, memoryMb: 1024, diskGb: 20 }));
        await agent.drain();
        await h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "stop" });
        await agent.drain();

        const res = await h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "resize", vcpu: 4, diskGb: 40 });
        assert.equal(res.statusCode, 202, res.body);
        const pending = instanceOf(res);
        assert.equal(pending.state, "resizing");
        assert.deepEqual([pending.spec.vcpu, pending.spec.diskGb], [1, 20], "the spec is unchanged until the resize is done");
        assert.deepEqual((pending as unknown as Record<string, unknown>).pendingSize, { vcpu: 4, memoryMb: 1024, diskGb: 40 });

        // The pending target is reserved: no room for another vCPU.
        const usage = await h.store.transaction((tx) => tx.lockPool());
        assert.deepEqual([usage.vcpu, usage.diskGb], [4, 40]);
        const blocked = await h.createInstance({ name: "squeezed", vcpu: 1, memoryMb: 512 });
        assert.equal(blocked.statusCode, 409);

        agent.driver.failNext("resize", new DriverError("broken", "scripted", false), 3);
        await agent.drain();
        const after = (await h.console("GET", `/console/v1/instances/${inst.id}`)).json().instance;
        assert.equal(after.state, "error");
        assert.deepEqual([after.spec.vcpu, after.spec.memoryMb, after.spec.diskGb], [1, 1024, 20], "spec unchanged");
        assert.equal(after.pendingSize, null);
        const released = await h.store.transaction((tx) => tx.lockPool());
        assert.deepEqual([released.vcpu, released.diskGb], [1, 20], "the reservation is released");
        type SizeRow = { vcpu: number; memoryMb: number; diskGb: number };
        const sizes = await h.store.transaction((tx) =>
          (tx as unknown as { listInstanceSizes(id: string): Promise<SizeRow[]> }).listInstanceSizes(inst.id),
        );
        assert.deepEqual(
          sizes.map((s) => [s.vcpu, s.memoryMb, s.diskGb]),
          [[1, 1024, 20]],
          "the size history is unchanged",
        );
      } finally {
        await h.close();
        await h.store.close();
      }
    });

    it("finding 2: a disabled host still runs a pending delete", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "doomed", memoryMb: 512 }));
        await agent.drain();
        const del = await h.console("DELETE", `/console/v1/instances/${inst.id}`);
        assert.equal(instanceOf(del).state, "deleting");
        const off = await h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/disable`);
        assert.equal(off.statusCode, 200);
        const job = await agent.step();
        assert.equal(job?.job.envelope.type, "delete", "the disabled host claims the delete");
        assert.equal(job?.outcome, "complete");
        assert.equal((await h.console("GET", `/console/v1/instances/${inst.id}`)).json().instance.state, "deleted");
        assert.equal((await agent.driver.status(inst.id)).power, "absent", "the VM is gone");
      } finally {
        await h.close();
        await h.store.close();
      }
    });

    it("finding 4: a fleet change and its audit event commit together", async () => {
      const store = new HookedStore(await makeStore());
      const h = await harness({ store });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "audited", memoryMb: 512 }));
        await agent.drain();
        await h.admin("GET", "/admin/v1/fleet/hosts");

        for (const action of ["disable", "drain"] as const) {
          store.failNext("insertSecurityEvent");
          const res = await h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/${action}`);
          assert.equal(res.statusCode, 500, `${action}: the audit write failed`);
          const host = (await h.store.transaction((tx) => tx.getHost(agent.hostId)))!;
          assert.equal(host.state, "active", `${action} was rolled back with its audit event`);
        }
        assert.equal((await h.console("GET", `/console/v1/instances/${inst.id}`)).json().instance.state, "running", "no stop was queued");

        store.failNext("insertSecurityEvent");
        const token = await h.admin("POST", "/admin/v1/fleet/enrolment-tokens", { hostName: "never-used" });
        assert.equal(token.statusCode, 500);
        const disabled = await h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/disable`);
        assert.equal(disabled.statusCode, 200);
        store.failNext("insertSecurityEvent");
        assert.equal((await h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/enable`)).statusCode, 500);
        assert.equal((await h.store.transaction((tx) => tx.getHost(agent.hostId)))!.state, "disabled");

        const events = (await h.store.transaction((tx) => tx.listSecurityEvents())).filter((e) => e.action.startsWith("fleet."));
        assert.deepEqual(events.map((e) => e.action), ["fleet.host_disable"], "only the change that committed is recorded");
      } finally {
        await h.close();
        await store.close();
      }
    });
  });
}
