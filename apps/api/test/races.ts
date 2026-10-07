/**
 * Concurrency findings from review of PR #2, each pinned by a test that
 * failed before its fix:
 *
 * 1. Agent auth wrote a stale host row back and could undo the kill switch.
 * 2. A create/start completion racing with disable could leave an instance
 *    running on a disabled host with no stop queued.
 * 3. A snapshot read its instance before the pool lock, so a concurrent
 *    resize could leave it sized (and checked) against a stale disk.
 *
 * The interleaving tests pause one transaction inside the store
 * (HookedStore) while another request runs. They need real concurrent
 * transactions, so they run on Postgres only: the memory store runs one
 * transaction at a time, which rules these races out by construction.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CreateJobPayload, type Instance, type InstanceState } from "@softqraft/compute-contracts";
import type { ComputeStore, InstanceRow } from "../src/store/index.js";
import { harness, instanceOf } from "./helpers.js";
import { HookedStore, settlesWithin } from "./hooked-store.js";

export type StoreFactory = () => Promise<ComputeStore>;

/** How long a request may take before we call it blocked on a lock. */
const BLOCKED_MS = 750;

async function stateOf(h: Awaited<ReturnType<typeof harness>>, id: string): Promise<InstanceState> {
  return (await h.console("GET", `/console/v1/instances/${id}`)).json().instance.state;
}

export function raceSuite(label: string, makeStore: StoreFactory, options: { concurrent: boolean }): void {
  describe(`${label}: concurrency (PR #2 review)`, () => {
    it("finding 1: a stale host row seen by agent auth never undoes the kill switch", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const stale = (await h.store.transaction((tx) => tx.getHost(agent.hostId)))!;
        assert.equal(stale.state, "active");
        await h.services.hosts.disable(agent.hostId, h.clock.now());
        h.clock.advance(5);
        // What agent auth does with the row it read before the disable committed.
        const seen = await h.store.transaction((tx) => h.services.hosts.markSeen(tx, stale, h.clock.now()));
        const host = (await h.store.transaction((tx) => tx.getHost(agent.hostId)))!;
        assert.equal(host.state, "disabled", "the kill switch holds");
        assert.equal(seen.state, "disabled", "auth sees the current state");
        assert.equal(host.lastSeenAt?.toISOString(), h.clock.now().toISOString(), "last seen still recorded");
      } finally {
        await h.close();
        await h.store.close();
      }
    });

    it("a first verified request still activates an enrolled host, once", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        const before = (await h.store.transaction((tx) => tx.getHost(agent.hostId)))!;
        assert.equal(before.state, "enrolled");
        await agent.claim();
        assert.equal((await h.store.transaction((tx) => tx.getHost(agent.hostId)))!.state, "active");
        await h.services.hosts.drain(agent.hostId);
        await agent.claim();
        assert.equal((await h.store.transaction((tx) => tx.getHost(agent.hostId)))!.state, "draining", "only enrolled is promoted");
      } finally {
        await h.close();
        await h.store.close();
      }
    });

    if (!options.concurrent) return;

    it("finding 1, interleaved: disable commits while an agent request holds a stale row", async () => {
      const store = new HookedStore(await makeStore());
      const h = await harness({ store });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        await h.admin("GET", "/admin/v1/fleet/hosts"); // open the operator session first
        const pause = store.pauseAfter("getHost", (args) => args[0] === agent.hostId);
        const claim = agent.request("POST", "/v1/agent/jobs/claim");
        await pause.reached; // agent auth has read the host as active
        const disable = h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/disable`);
        assert.ok(await settlesWithin(disable, BLOCKED_MS * 4), "disable does not wait for a plain read");
        assert.equal((await disable).statusCode, 200);
        pause.release();
        assert.equal((await claim).statusCode, 200);
        const host = (await h.store.transaction((tx) => tx.getHost(agent.hostId)))!;
        assert.equal(host.state, "disabled");
      } finally {
        await h.close();
        await store.close();
      }
    });

    it("finding 2, interleaved: a create completing while the host is disabled is stopped", async () => {
      const store = new HookedStore(await makeStore());
      const h = await harness({ store });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst: Instance = instanceOf(await h.createInstance({ name: "racer", memoryMb: 512 }));
        const job = (await agent.claim())!;
        assert.equal(job.envelope.type, "create");
        await agent.driver.create({ instanceId: inst.id, ...CreateJobPayload.parse(job.envelope.payload) });
        await h.admin("GET", "/admin/v1/fleet/hosts");

        const pause = store.pauseBeforeCommit("updateInstance", (args) => (args[0] as InstanceRow).state === "running");
        const complete = agent.request("POST", `/v1/agent/jobs/${job.envelope.id}/complete`, { attempt: 1 });
        await pause.reached; // the completion wrote `running` and checked the host; it has not committed
        const disable = h.admin("POST", `/admin/v1/fleet/hosts/${agent.hostId}/disable`);
        const disableFinishedFirst = await settlesWithin(disable, BLOCKED_MS);
        pause.release();
        assert.equal((await complete).statusCode, 200);
        assert.equal((await disable).statusCode, 200);

        assert.equal(await stateOf(h, inst.id), "stopping", "the instance is not left running on a disabled host");
        assert.equal(disableFinishedFirst, false, "disable waits for the completion's host lock");
        const jobs = await h.store.transaction((tx) => tx.listJobsForInstance(inst.id));
        assert.ok(jobs.some((j) => j.type === "stop" && j.state === "queued"), "a stop is queued");
        const next = await agent.claim();
        assert.equal(next?.envelope.type, "stop");
      } finally {
        await h.close();
        await store.close();
      }
    });

    it("finding 3, interleaved: a snapshot never sizes against a disk a resize has already changed", async () => {
      const store = new HookedStore(await makeStore());
      const h = await harness({ store });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "snapper", memoryMb: 512, diskGb: 20 }));
        await agent.drain();
        await h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "stop" });
        await agent.drain();
        assert.equal(await stateOf(h, inst.id), "stopped");

        const pause = store.pauseAfter("getInstance", (args) => args[0] === inst.id);
        const snapshot = h.console("POST", `/console/v1/instances/${inst.id}/snapshots`, { name: "racy" });
        await pause.reached; // the snapshot has read the instance (20 GB, stopped)
        const resize = h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "resize", diskGb: 40 });
        const resizeFinishedFirst = await settlesWithin(resize, BLOCKED_MS);
        pause.release();
        const snap = await snapshot;
        const grown = await resize;

        assert.equal(resizeFinishedFirst, false, "resize waits for the snapshot's pool lock");
        assert.equal(snap.statusCode, 202, snap.body);
        assert.equal(snap.json().snapshot.sizeGb, 20, "sized against the disk it was taken from");
        assert.equal(grown.statusCode, 202, grown.body);
        assert.equal(instanceOf(grown).pendingSize?.diskGb, 40);
      } finally {
        await h.close();
        await store.close();
      }
    });

    it("finding 3, the other order: a resize committed first makes the snapshot see the new state", async () => {
      const store = new HookedStore(await makeStore());
      const h = await harness({ store });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "snapper-2", memoryMb: 512, diskGb: 20 }));
        await agent.drain();
        await h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "stop" });
        await agent.drain();
        await h.console("GET", "/console/v1/instances");

        // Hold the resize after it wrote `resizing`, then send the snapshot.
        const pause = store.pauseAfter("updateInstance", (args) => (args[0] as InstanceRow).state === "resizing");
        const resize = h.console("POST", `/console/v1/instances/${inst.id}/actions`, { action: "resize", diskGb: 40 });
        await pause.reached;
        const snapshot = h.console("POST", `/console/v1/instances/${inst.id}/snapshots`, { name: "late" });
        const snapshotFinishedFirst = await settlesWithin(snapshot, BLOCKED_MS);
        pause.release();
        assert.equal((await resize).statusCode, 202);
        const snap = await snapshot;
        assert.equal(snapshotFinishedFirst, false, "the snapshot waits for the resize's pool lock");
        assert.equal(snap.statusCode, 409, "a resizing instance cannot be snapshotted");
        assert.equal(snap.json().error.code, "invalid_state");
      } finally {
        await h.close();
        await store.close();
      }
    });
  });
}
