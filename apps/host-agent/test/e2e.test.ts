import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Instance, Snapshot } from "@softqraft/compute-contracts";
import { loadSigningKey } from "@softqraft/compute-jobs";
import { ComputeApi } from "../src/api.js";
import { startE2E, type E2E } from "./harness.js";

const Q = "/nodes/sq-node-01/qemu";

async function instance(e: E2E, id: string): Promise<Instance> {
  const res = await e.browser(e.console, "GET", `/console/v1/instances/${id}`);
  return ((await res.json()) as { instance: Instance }).instance;
}

async function state(e: E2E, id: string, want: Instance["state"]): Promise<Instance> {
  return e.waitFor(`instance ${want}`, async () => {
    const i = await instance(e, id);
    if (i.state === "error") throw new Error("instance went to error");
    return i.state === want ? i : null;
  });
}

async function act(e: E2E, id: string, body: unknown): Promise<void> {
  const res = await e.browser(e.console, "POST", `/console/v1/instances/${id}/actions`, body);
  assert.equal(res.status, 202, await res.text());
}

async function create(e: E2E, name = "web-1"): Promise<Instance> {
  const res = await e.browser(
    e.console,
    "POST",
    "/console/v1/instances",
    { name, imageId: "debian-12", vcpu: 1, memoryMb: 1024, diskGb: 16 },
    { "idempotency-key": `e2e-${name}-${Date.now()}` },
  );
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as { instance: Instance }).instance;
}

describe("host agent end to end: real API, real agent, fake Proxmox", () => {
  it("enrols, builds images, and runs create, stop, resize, start, snapshot and delete; usage arrives", async () => {
    const e = await startE2E();
    try {
      e.start();
      await e.waitFor("host active", async () => {
        const res = await e.browser(e.admin, "GET", "/admin/v1/fleet/hosts");
        const hosts = ((await res.json()) as { hosts: Array<{ state: string; driver: string }> }).hosts;
        return hosts[0]?.state === "active" && hosts[0].driver === "proxmox";
      });
      assert.ok(!readFileSync(e.envFile, "utf8").includes("sqet_"), "the enrolment token was blanked");
      await e.waitFor("templates", async () => e.pve.vms.get(9000)?.template === 1 && e.pve.vms.get(9001)?.template === 1);

      // Create.
      const created = await create(e);
      const running = await state(e, created.id, "running");
      assert.deepEqual(running.capabilities, { console: false, resize: true, snapshot: true });
      const vm = e.pve.findByTag(`sqc-${created.id}`)!;
      assert.ok(vm, "the VM exists in Proxmox");
      assert.equal(vm.pool, "compute-pilot");
      assert.ok(vm.vmid >= 2000 && vm.vmid <= 2999);
      assert.equal(vm.status, "running");
      assert.equal(vm.name, "web-1");
      assert.equal(vm.config.net0, "virtio,bridge=vmbr10,firewall=1");
      assert.equal(vm.config.ipconfig0, `ip=${running.privateIp}/24,gw=10.30.0.1`);
      assert.equal(vm.config.cores, "1");
      assert.equal(vm.config.memory, "1024");
      // F7: the disk is IO-limited and the VM never starts with the host.
      assert.match(vm.config.scsi0!, /^compute-pilot:vm-\d+-disk-0,size=16G,iops_rd=2000,iops_wr=2000,mbps_rd=100,mbps_wr=100$/);
      assert.equal(vm.config.onboot, "0");
      assert.deepEqual(vm.ipsets.get("ipfilter-net0"), [running.privateIp]);
      assert.equal(vm.firewall.ipfilter, "1");
      assert.equal(vm.firewall.macfilter, "1");
      const vmPath = `${Q}/${vm.vmid}`;
      const writes = () => e.pve.summary(e.pve.writes());
      assert.ok(writes().includes(`POST ${Q}/9000/clone`));

      // Console is not offered by the Proxmox driver in C1.
      const consoleRes = await e.browser(e.console, "POST", `/console/v1/instances/${created.id}/console`);
      assert.equal(consoleRes.status, 409);

      // Stop.
      e.pve.reset();
      await act(e, created.id, { action: "stop" });
      await state(e, created.id, "stopped");
      assert.equal(vm.status, "stopped");
      assert.ok(writes().includes(`POST ${vmPath}/status/shutdown`));

      // Resize.
      e.pve.reset();
      await act(e, created.id, { action: "resize", vcpu: 2, memoryMb: 2048, diskGb: 20 });
      await e.waitFor("resized", async () => {
        const i = await instance(e, created.id);
        return i.state === "stopped" && i.spec.diskGb === 20 ? i : null;
      });
      assert.deepEqual(writes(), [`PUT ${vmPath}/config`, `PUT ${vmPath}/resize`]);
      assert.equal(vm.config.cores, "2");
      assert.equal(vm.config.memory, "2048");
      assert.match(vm.config.scsi0!, /,size=20G,iops_rd=2000,iops_wr=2000,mbps_rd=100,mbps_wr=100$/);

      // Start.
      e.pve.reset();
      await act(e, created.id, { action: "start" });
      await state(e, created.id, "running");
      assert.deepEqual(writes(), [`POST ${vmPath}/status/start`]);

      // Snapshot, then delete it.
      e.pve.reset();
      const snapRes = await e.browser(e.console, "POST", `/console/v1/instances/${created.id}/snapshots`, { name: "before-upgrade" });
      const snapText = await snapRes.text();
      assert.equal(snapRes.status, 202, snapText);
      const snap = (JSON.parse(snapText) as { snapshot: Snapshot }).snapshot;
      await e.waitFor("snapshot available", async () => {
        const res = await e.browser(e.console, "GET", `/console/v1/instances/${created.id}/snapshots`);
        const list = ((await res.json()) as { snapshots: Snapshot[] }).snapshots;
        return list.find((s) => s.id === snap.id)?.state === "available";
      });
      assert.deepEqual(vm.snapshots, ["before-upgrade"]);
      assert.deepEqual(writes(), [`POST ${vmPath}/snapshot`]);
      const delSnap = await e.browser(e.console, "DELETE", `/console/v1/instances/${created.id}/snapshots/${snap.id}`);
      assert.equal(delSnap.status, 202);
      await e.waitFor("snapshot deleted", async () => vm.snapshots.length === 0);

      // Usage arrives for the running VM.
      await e.waitFor("usage", async () => {
        const res = await e.browser(e.console, "GET", "/console/v1/usage");
        const records = ((await res.json()) as { records: Array<{ vcpuHours: number; diskGbHours: number }> }).records;
        return records.length > 0 && records[0]!.diskGbHours > 0;
      });

      // Delete.
      e.pve.reset();
      const del = await e.browser(e.console, "DELETE", `/console/v1/instances/${created.id}`);
      assert.equal(del.status, 202);
      await state(e, created.id, "deleted");
      assert.equal(e.pve.vms.has(vm.vmid), false);
      assert.deepEqual(writes(), [`POST ${vmPath}/status/stop`, `DELETE ${vmPath}`]);
      assert.deepEqual(e.pve.writes()[1]!.params, { purge: "1", "destroy-unreferenced-disks": "1" });

      assert.ok(e.pve.calls.every((c) => c.authorized), "every Proxmox call carried the token");
      const logText = e.logs.join("");
      for (const secret of [e.tokenSecret, "sqet_", "BEGIN PRIVATE KEY", "PVEAPIToken"]) {
        assert.ok(!logText.includes(secret), `logs contain ${secret}`);
      }
      assert.ok(logText.includes("job_succeeded"));
    } finally {
      await e.close();
    }
  });

  it("dry run verifies jobs and makes zero Proxmox write calls", async () => {
    const e = await startE2E({ dryRun: true, hostName: "sq-node-02" });
    try {
      e.pve.addTemplate(9000);
      e.start();
      const created = await create(e, "dry-1");
      await e.waitFor("instance error after dry-run attempts", async () => (await instance(e, created.id)).state === "error", 20_000);
      assert.equal(e.pve.writes().length, 0, "no write reached Proxmox");
      assert.ok(e.pve.calls.length > 0, "reads did");
      const lines = e.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      const planned = lines.filter((l) => l.msg === "proxmox_dry_run").map((l) => `${l.method} ${l.path}`);
      assert.ok(planned.includes(`POST ${Q}/9000/clone`), planned.join("\n"));
      assert.ok(planned.includes(`POST /nodes/sq-node-01/storage/local/download-url`), "the image plan was logged");
      assert.ok(lines.some((l) => l.msg === "job_dry_run"));
      const logText = e.logs.join("");
      assert.ok(!logText.includes(e.tokenSecret));
      assert.equal(e.pve.vms.size, 1, "only the pre-made template exists");
    } finally {
      await e.close();
    }
  });

  it("runs no job when the network guard is missing", async () => {
    const e = await startE2E({ guard: false, hostName: "sq-node-03" });
    try {
      e.pve.addTemplate(9000);
      e.start();
      await e.waitFor("guard check", async () => e.logs.some((l) => l.includes("network_guard_missing")));
      // The agent sends nothing while it runs no jobs, so its host stays
      // `enrolled` and gets no work. Make it active with one signed claim
      // made as the host (nothing is queued yet), so a job is queued for it.
      const enrolment = JSON.parse(readFileSync(path.join(e.stateDir, "enrolment.json"), "utf8")) as { hostId: string };
      const api = new ComputeApi(e.base);
      api.setIdentity({ hostId: enrolment.hostId, privateKey: loadSigningKey(readFileSync(path.join(e.stateDir, "host-key.pem"), "utf8")) });
      assert.equal(await api.claim(), null);
      const created = await create(e, "guarded-1");
      await new Promise((r) => setTimeout(r, 800));
      assert.equal((await instance(e, created.id)).state, "provisioning", "the create job is still queued");
      assert.equal(e.pve.writes().length, 0);
      assert.ok(!e.pve.calls.some((c) => c.path.includes("/clone")));
      assert.ok(e.logs.some((l) => l.includes("network_guard_missing")));
    } finally {
      await e.close();
    }
  });
});
