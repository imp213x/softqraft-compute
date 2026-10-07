import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DriverError } from "@softqraft/compute-driver";
import { generateTestCertificate } from "@softqraft/compute-proxmox-fake";
import { PROXMOX_ERRORS } from "./errors.js";
import { diskSizeMb, encodeSshKeys, instanceTag, ipConfig } from "./driver.js";
import { createInput, IMPORT_STORAGE, NODE, POOL, setup, SSH_KEY, STORAGE } from "./test-support.test-helper.js";

const code = (c: string) => (err: unknown) => err instanceof DriverError && err.code === c;
const Q = `/nodes/${NODE}/qemu`;

describe("ProxmoxDriver lifecycle against the fake Proxmox", () => {
  it("creates a VM with the exact calls, then is idempotent", async () => {
    const s = await setup();
    try {
      s.pve.addTemplate(9000);
      const id = randomUUID();
      await s.driver.create(createInput(id));
      assert.deepEqual(s.pve.summary(), [
        "GET /cluster/resources",
        "GET /cluster/resources",
        "GET /cluster/nextid",
        `POST ${Q}/9000/clone`,
        `GET /nodes/${NODE}/tasks/<upid>/status`,
        `PUT ${Q}/2000/config`,
        `PUT ${Q}/2000/firewall/options`,
        `POST ${Q}/2000/firewall/ipset`,
        `POST ${Q}/2000/firewall/ipset/ipfilter-net0`,
        `PUT ${Q}/2000/resize`,
        `GET /nodes/${NODE}/tasks/<upid>/status`,
        `POST ${Q}/2000/status/start`,
        `GET /nodes/${NODE}/tasks/<upid>/status`,
      ]);
      assert.ok(s.pve.calls.every((c) => c.authorized), "every call carried the token");
      const byPath = (method: string, suffix: string) => s.pve.calls.find((c) => c.method === method && c.path.endsWith(suffix))!.params;
      assert.deepEqual(byPath("POST", "/9000/clone"), {
        newid: "2000",
        name: instanceTag(id),
        pool: POOL,
        storage: STORAGE,
        full: "1",
        description: `SoftQraft Compute instance ${id}`,
      });
      assert.deepEqual(byPath("PUT", "/2000/config"), {
        name: "web-1",
        tags: instanceTag(id),
        cores: "2",
        sockets: "1",
        memory: "2048",
        net0: "virtio,bridge=vmbr10,firewall=1",
        ciuser: "sq",
        sshkeys: encodeURIComponent(SSH_KEY),
        ipconfig0: "ip=10.30.0.10/24,gw=10.30.0.1",
        nameserver: "1.1.1.1 9.9.9.9",
      });
      assert.deepEqual(byPath("PUT", "/firewall/options"), {
        enable: "1", ipfilter: "1", macfilter: "1", dhcp: "0", ndp: "0", radv: "0", policy_in: "DROP", policy_out: "ACCEPT",
      });
      assert.deepEqual(byPath("POST", "/firewall/ipset"), { name: "ipfilter-net0", comment: "SoftQraft Compute address" });
      assert.deepEqual(byPath("POST", "/ipset/ipfilter-net0"), { cidr: "10.30.0.10" });
      assert.deepEqual(byPath("PUT", "/resize"), { disk: "scsi0", size: "16G" });

      const vm = s.pve.vms.get(2000)!;
      assert.equal(vm.status, "running");
      assert.equal(vm.pool, POOL);
      assert.match(vm.config.scsi0!, new RegExp(`^${STORAGE}:vm-2000-disk-0,size=16G$`));
      assert.deepEqual(vm.ipsets.get("ipfilter-net0"), ["10.30.0.10"]);

      // A retried create finds the VM: no clone, no second VM, still one address.
      s.pve.reset();
      await s.driver.create(createInput(id));
      assert.equal(s.pve.summary().filter((c) => c.includes("/clone")).length, 0);
      assert.equal(s.pve.summary().filter((c) => c.endsWith("/status/start")).length, 0, "already running");
      assert.equal([...s.pve.vms.values()].filter((v) => v.tags.includes(id)).length, 1);
      assert.deepEqual(vm.ipsets.get("ipfilter-net0"), ["10.30.0.10"]);
      assert.equal((await s.driver.list()).length, 1);
    } finally {
      await s.close();
    }
  });

  it("finishes a create that stopped after the clone, and re-pins a stray ipset entry", async () => {
    const s = await setup();
    try {
      s.pve.addTemplate(9001);
      const id = randomUUID();
      // A clone from an earlier attempt: named, not yet tagged or configured.
      s.pve.addVm({ vmid: 2003, pool: POOL, name: instanceTag(id), config: { scsi0: `${STORAGE}:vm-2003-disk-0,size=3G` } });
      s.pve.vms.get(2003)!.ipsets.set("ipfilter-net0", ["10.30.0.99"]);
      await s.driver.create(createInput(id, { imageId: "ubuntu-24.04", privateIp: "10.30.0.11" }));
      const vm = s.pve.vms.get(2003)!;
      assert.equal(vm.tags, instanceTag(id));
      assert.equal(vm.status, "running");
      assert.deepEqual(vm.ipsets.get("ipfilter-net0"), ["10.30.0.11"]);
      assert.equal(s.pve.summary().filter((c) => c.includes("/clone")).length, 0);
      assert.ok(s.pve.summary().includes(`DELETE ${Q}/2003/firewall/ipset/ipfilter-net0/10.30.0.99`));
    } finally {
      await s.close();
    }
  });

  it("skips VMIDs in use, including ones the token cannot see", async () => {
    const s = await setup();
    try {
      s.pve.addTemplate(9000);
      s.pve.addVm({ vmid: 2000, pool: POOL, tags: `sqc-${randomUUID()}` });
      s.pve.addVm({ vmid: 2001, hidden: true });
      await s.driver.create(createInput(randomUUID()));
      assert.ok(s.pve.vms.get(2002)?.tags.startsWith("sqc-"));
    } finally {
      await s.close();
    }
  });

  it("refuses a create while the image template is missing (retryable)", async () => {
    const s = await setup();
    try {
      await assert.rejects(s.driver.create(createInput(randomUUID())), (err: DriverError) => {
        return err.code === PROXMOX_ERRORS.imageUnavailable && err.retryable;
      });
      await assert.rejects(s.driver.create(createInput(randomUUID(), { imageId: "windows" })), code(PROXMOX_ERRORS.unknownImage));
      assert.equal(s.pve.writes().length, 0);
    } finally {
      await s.close();
    }
  });

  it("starts, stops, resizes, snapshots and deletes, each idempotently", async () => {
    const s = await setup();
    try {
      s.pve.addTemplate(9000);
      const id = randomUUID();
      await s.driver.create(createInput(id));
      const vm = s.pve.vms.get(2000)!;

      s.pve.reset();
      await s.driver.start(id);
      assert.equal(s.pve.writes().length, 0, "start on a running VM writes nothing");

      await s.driver.stop(id);
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`POST ${Q}/2000/status/shutdown`]);
      assert.deepEqual(s.pve.writes()[0]!.params, { timeout: "60" });
      assert.equal(vm.status, "stopped");
      s.pve.reset();
      await s.driver.stop(id);
      assert.equal(s.pve.writes().length, 0, "stop on a stopped VM writes nothing");

      await s.driver.start(id);
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`POST ${Q}/2000/status/start`]);
      await assert.rejects(s.driver.resize(id, { vcpu: 1, memoryMb: 1024, diskGb: 20 }), code("vm_running"));

      // A guest that ignores ACPI: shutdown, then stop.
      vm.ignoresShutdown = true;
      s.pve.reset();
      await s.driver.stop(id);
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`POST ${Q}/2000/status/shutdown`, `POST ${Q}/2000/status/stop`]);
      assert.equal(vm.status, "stopped");

      await assert.rejects(s.driver.resize(id, { vcpu: 1, memoryMb: 1024, diskGb: 10 }), code("disk_shrink"));
      s.pve.reset();
      await s.driver.resize(id, { vcpu: 4, memoryMb: 4096, diskGb: 32 });
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`PUT ${Q}/2000/config`, `PUT ${Q}/2000/resize`]);
      assert.deepEqual(s.pve.writes()[0]!.params, { cores: "4", memory: "4096" });
      assert.deepEqual(s.pve.writes()[1]!.params, { disk: "scsi0", size: "32G" });
      s.pve.reset();
      await s.driver.resize(id, { vcpu: 4, memoryMb: 4096, diskGb: 32 });
      assert.equal(s.pve.writes().length, 0, "the same size again writes nothing");
      await s.driver.resize(id, { vcpu: 1, memoryMb: 1024, diskGb: 32 });
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`PUT ${Q}/2000/config`], "vCPU and memory may go down");

      s.pve.reset();
      await s.driver.snapshot(id, "before-upgrade");
      await s.driver.snapshot(id, "before-upgrade");
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`POST ${Q}/2000/snapshot`]);
      assert.deepEqual(s.pve.writes()[0]!.params, { snapname: "before-upgrade", description: "SoftQraft Compute snapshot" });
      assert.deepEqual(await s.driver.listSnapshots(id), [{ name: "before-upgrade" }]);
      await assert.rejects(s.driver.snapshot(id, "x"), code(PROXMOX_ERRORS.snapshotName));
      await assert.rejects(s.driver.snapshot(id, "current"), code(PROXMOX_ERRORS.snapshotName));
      s.pve.reset();
      await s.driver.deleteSnapshot(id, "before-upgrade");
      await s.driver.deleteSnapshot(id, "before-upgrade");
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`DELETE ${Q}/2000/snapshot/before-upgrade`]);

      assert.deepEqual(await s.driver.status(id), { instanceId: id, power: "stopped", snapshots: [] });
      await s.driver.start(id);
      assert.deepEqual(await s.driver.list(), [{ instanceId: id, power: "running" }]);

      s.pve.reset();
      await s.driver.delete(id);
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`POST ${Q}/2000/status/stop`, `DELETE ${Q}/2000`]);
      assert.deepEqual(s.pve.writes()[1]!.params, { purge: "1", "destroy-unreferenced-disks": "1" });
      assert.equal(s.pve.vms.has(2000), false);
      s.pve.reset();
      await s.driver.delete(id);
      await s.driver.deleteSnapshot(id, "gone");
      assert.equal(s.pve.writes().length, 0, "deleting a deleted VM writes nothing");
      assert.deepEqual(await s.driver.status(id), { instanceId: id, power: "absent", snapshots: [] });
      await assert.rejects(s.driver.start(id), code("vm_not_found"));
      await assert.rejects(s.driver.stop(id), code("vm_not_found"));
      await assert.rejects(s.driver.snapshot(id, "later"), code("vm_not_found"));
    } finally {
      await s.close();
    }
  });

  it("has no console in C1", async () => {
    const s = await setup();
    try {
      assert.deepEqual(s.driver.capabilities, { console: false, resize: true, snapshot: true });
      await assert.rejects(s.driver.console(randomUUID()), code("unsupported"));
      assert.equal(s.pve.calls.length, 0);
    } finally {
      await s.close();
    }
  });
});

describe("fences: refused before anything is sent", () => {
  it("never touches a VM outside the VMID range or the pool", async () => {
    const s = await setup();
    try {
      const id = randomUUID();
      // Production VM 101, and a VM carrying our tag in another pool.
      s.pve.addVm({ vmid: 101, name: "prod", status: "running" });
      s.pve.addVm({ vmid: 2005, pool: "production", tags: instanceTag(id), status: "running" });
      await s.driver.client.get("/cluster/resources", { type: "vm" });
      s.pve.reset();

      const refused = code(PROXMOX_ERRORS.fenceRefused);
      for (const op of [() => s.driver.stop(id), () => s.driver.delete(id), () => s.driver.start(id), () => s.driver.snapshot(id, "ab")]) {
        await assert.rejects(op(), refused);
      }
      assert.equal(s.pve.writes().length, 0);

      s.pve.reset();
      const c = s.driver.client;
      const calls: Array<[string, string, Record<string, string | number>]> = [
        ["POST", `${Q}/101/status/stop`, {}],
        ["DELETE", `${Q}/101`, { purge: 1 }],
        ["PUT", `${Q}/2005/config`, { memory: 512 }],
        ["POST", `${Q}/2005/status/stop`, {}],
        ["GET", `${Q}/2005/config`, {}],
        ["POST", `${Q}/9050/status/start`, {}],
        ["PUT", `${Q}/9000/config`, { memory: 512 }],
        ["POST", `/nodes/other-node/qemu/2000/status/start`, {}],
        ["GET", "/nodes/" + NODE + "/qemu/2000/agent/exec", {}],
        ["POST", "/access/users", {}],
        ["GET", "/cluster/resources", { type: "storage" }],
        ["GET", "/cluster/nextid", { vmid: 101 }],
      ];
      for (const [method, path, params] of calls) {
        await assert.rejects(c.call(method as "GET", path, params), refused, `${method} ${path}`);
      }
      assert.equal(s.pve.calls.length, 0, "nothing reached Proxmox");
    } finally {
      await s.close();
    }
  });

  it("refuses another storage, pool or bridge, a linked clone and a disk import from elsewhere", async () => {
    const s = await setup();
    try {
      s.pve.addTemplate(9000);
      s.pve.addVm({ vmid: 2000, pool: POOL, tags: `sqc-${randomUUID()}` });
      await s.driver.resources();
      s.pve.reset();
      const c = s.driver.client;
      const refused = code(PROXMOX_ERRORS.fenceRefused);
      const clone = { newid: 2001, name: "x", pool: POOL, storage: STORAGE, full: 1 };
      const bad: Array<[string, string, Record<string, string | number>]> = [
        ["POST", `${Q}/9000/clone`, { ...clone, storage: "local-lvm" }],
        ["POST", `${Q}/9000/clone`, { ...clone, pool: "production" }],
        ["POST", `${Q}/9000/clone`, { ...clone, full: 0 }],
        ["POST", `${Q}/9000/clone`, { ...clone, newid: 101 }],
        ["POST", `${Q}/9000/clone`, { ...clone, target: "other-node" }],
        ["PUT", `${Q}/2000/config`, { net0: "virtio,bridge=vmbr0,firewall=1" }],
        ["PUT", `${Q}/2000/config`, { net0: "virtio,bridge=vmbr10,bridge=vmbr0" }],
        ["PUT", `${Q}/2000/config`, { net1: "virtio,bridge=vmbr10" }],
        ["PUT", `${Q}/2000/config`, { scsi1: "local-lvm:8" }],
        ["PUT", `${Q}/2000/config`, { delete: "net0" }],
        ["PUT", `${Q}/2000/resize`, { disk: "scsi1", size: "20G" }],
        ["POST", `/nodes/${NODE}/qemu`, { vmid: 9002, pool: POOL, scsi0: `${STORAGE}:0,import-from=nfs:import/x.qcow2` }],
        ["POST", `/nodes/${NODE}/qemu`, { vmid: 9002, pool: POOL, scsi0: `local-lvm:0` }],
        ["POST", `/nodes/${NODE}/qemu`, { vmid: 2001, pool: POOL }],
        ["POST", `/nodes/${NODE}/storage/${STORAGE}/download-url`, { content: "import", url: "https://x/y", checksum: "a", "checksum-algorithm": "sha256" }],
        ["POST", `/nodes/${NODE}/storage/${IMPORT_STORAGE}/download-url`, { content: "iso", url: "https://x/y", checksum: "a", "checksum-algorithm": "sha256" }],
        ["POST", `/nodes/${NODE}/storage/${IMPORT_STORAGE}/download-url`, { content: "import", url: "http://x/y", checksum: "a", "checksum-algorithm": "sha256" }],
        ["POST", `/nodes/${NODE}/storage/${IMPORT_STORAGE}/download-url`, { content: "import", url: "https://x/y" }],
      ];
      for (const [method, path, params] of bad) {
        await assert.rejects(c.call(method as "GET", path, params), refused, `${method} ${path} ${JSON.stringify(params)}`);
      }
      assert.equal(s.pve.calls.length, 0, "nothing reached Proxmox");
    } finally {
      await s.close();
    }
  });

  it("refuses a job address outside its network or on the production network", () => {
    const net = { cidr: "10.30.0.0/24", gateway: "10.30.0.1" };
    assert.equal(ipConfig("10.30.0.5", net), "ip=10.30.0.5/24,gw=10.30.0.1");
    for (const ip of ["10.30.1.5", "10.30.0.0", "10.30.0.255", "10.30.0.1", "nope"]) {
      assert.throws(() => ipConfig(ip, net), code(PROXMOX_ERRORS.network), ip);
    }
    assert.throws(() => ipConfig("10.20.0.5", { cidr: "10.20.0.0/24", gateway: "10.20.0.1" }), code(PROXMOX_ERRORS.network));
  });
});

describe("TLS pinning and the token", () => {
  it("sends nothing to a server whose certificate does not match the pin", async () => {
    const s = await setup({ env: { PROXMOX_TLS_FINGERPRINT: generateTestCertificate().fingerprint } });
    try {
      await assert.rejects(s.driver.list(), code(PROXMOX_ERRORS.tlsPinMismatch));
      assert.ok(s.pve.connections >= 1, "the client connected");
      assert.equal(s.pve.calls.length, 0, "no HTTP request, so no token, reached the server");
    } finally {
      await s.close();
    }
  });

  it("accepts the pin without colons or in lower case, and sends the token header", async () => {
    const certificate = generateTestCertificate();
    const s = await setup({ certificate, env: { PROXMOX_TLS_FINGERPRINT: certificate.fingerprint.replace(/:/g, "").toLowerCase() } });
    try {
      assert.deepEqual(await s.driver.list(), []);
      assert.equal(s.pve.calls[0]!.authorized, true);
    } finally {
      await s.close();
    }
  });

  it("maps a refused token, server errors and an unreachable API to stable codes", async () => {
    const s = await setup({ env: { PROXMOX_TOKEN_SECRET: randomUUID() } });
    try {
      await assert.rejects(s.driver.list(), (err: DriverError) => err.code === PROXMOX_ERRORS.auth && !err.message.includes(s.env.PROXMOX_TOKEN_SECRET!));
      assert.equal(s.pve.calls[0]!.authorized, false);
    } finally {
      await s.close();
    }
    const t = await setup();
    try {
      t.pve.failNext = 1;
      await assert.rejects(t.driver.list(), (err: DriverError) => err.code === PROXMOX_ERRORS.server && err.retryable);
      await t.pve.stop();
      await assert.rejects(t.driver.list(), (err: DriverError) => err.code === PROXMOX_ERRORS.unreachable && err.retryable);
    } finally {
      await t.close();
    }
  });
});

describe("helpers", () => {
  it("parses disk sizes and encodes SSH keys", () => {
    assert.equal(diskSizeMb("local:vm-1-disk-0,size=16G"), 16384);
    assert.equal(diskSizeMb("local:vm-1-disk-0,cache=none,size=2252M,ssd=1"), 2252);
    assert.equal(diskSizeMb("local:vm-1-disk-0"), null);
    assert.equal(encodeSshKeys(["a b", "c d"]), "a%20b%0Ac%20d");
  });
});
