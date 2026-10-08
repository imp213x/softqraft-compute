import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DriverError } from "@softqraft/compute-driver";
import { loadProxmoxConfig, ProxmoxConfigError } from "./config.js";
import { PROXMOX_ERRORS } from "./errors.js";
import { checksumFor, IMAGE_CATALOGUE, importFileName } from "./images.js";
import { redactParams } from "./transport.js";
import { createInput, IMPORT_STORAGE, NODE, POOL, setup, STORAGE } from "./test-support.test-helper.js";

const code = (c: string) => (err: unknown) => err instanceof DriverError && err.code === c;
const Q = `/nodes/${NODE}/qemu`;

const DEBIAN = IMAGE_CATALOGUE["debian-12"]!;
const UBUNTU = IMAGE_CATALOGUE["ubuntu-24.04"]!;
const debianHash = createHash("sha512").update("debian image bytes").digest("hex");
const ubuntuHash = createHash("sha256").update("ubuntu image bytes").digest("hex");
const vendorLists: Record<string, string> = {
  [DEBIAN.checksumsUrl]: `${"0".repeat(128)}  debian-12-nocloud-amd64.qcow2\n${debianHash}  ${DEBIAN.fileName}\n`,
  [UBUNTU.checksumsUrl]: `${"1".repeat(64)} *noble-server-cloudimg-arm64.img\n${ubuntuHash} *${UBUNTU.fileName}\n`,
};
const vendorFiles: Record<string, Record<string, string>> = {
  [DEBIAN.url]: { sha512: debianHash },
  [UBUNTU.url]: { sha256: ubuntuHash },
};
const fetchText = async (url: string) => {
  const text = vendorLists[url];
  if (text === undefined) throw new Error("404");
  return text;
};

describe("configuration", () => {
  const base = {
    PROXMOX_NODE: NODE,
    PROXMOX_TOKEN_ID: "compute-agent@pve!agent",
    PROXMOX_TOKEN_SECRET: randomUUID(),
    PROXMOX_TLS_FINGERPRINT: "AB:".repeat(31) + "CD",
    PROXMOX_POOL: POOL,
    PROXMOX_STORAGE: STORAGE,
  };

  it("applies the pilot defaults", () => {
    const c = loadProxmoxConfig(base);
    assert.equal(c.url, "https://127.0.0.1:8006");
    assert.equal(c.bridge, "vmbr10");
    assert.deepEqual(c.vmidRange, { min: 2000, max: 2999 });
    assert.equal(c.importStorage, "local");
    assert.deepEqual(c.nameservers, ["1.1.1.1", "9.9.9.9"]);
  });

  it("refuses a remote or plain-http API, ranges that touch templates, and bad values, without echoing them", () => {
    const bad: Array<Record<string, string>> = [
      { PROXMOX_URL: "https://10.0.0.5:8006" },
      { PROXMOX_URL: "http://127.0.0.1:8006" },
      { PROXMOX_URL: "https://127.0.0.1:8006/api2/json" },
      { COMPUTE_VMID_RANGE: "8000-9050" },
      { COMPUTE_VMID_RANGE: "3000-2000" },
      { COMPUTE_VMID_RANGE: "50-99" },
      { PROXMOX_BRIDGE: "eth0" },
      { PROXMOX_TLS_FINGERPRINT: "abc" },
      { PROXMOX_TOKEN_SECRET: "hunter2-not-a-uuid" },
      { PROXMOX_IMPORT_STORAGE: STORAGE },
      { PROXMOX_NAMESERVERS: "dns.example" },
    ];
    for (const change of bad) {
      assert.throws(
        () => loadProxmoxConfig({ ...base, ...change }),
        (err: Error) => err instanceof ProxmoxConfigError && !err.message.includes("hunter2") && !err.message.includes(base.PROXMOX_TOKEN_SECRET),
        JSON.stringify(change),
      );
    }
    const { PROXMOX_TOKEN_SECRET: _s, ...missing } = base;
    assert.throws(() => loadProxmoxConfig(missing), /PROXMOX_TOKEN_SECRET/);
  });
});

describe("dry run", () => {
  it("reads, logs the exact writes without secrets, and sends none", async () => {
    const skipped: Array<{ method: string; path: string; params: Record<string, string | number> }> = [];
    const s = await setup({ dryRun: true, onDryRunCall: (call) => skipped.push(call), fetchText, vendorFiles });
    try {
      s.pve.addTemplate(9000);
      const id = randomUUID();
      await s.driver.create(createInput(id));
      assert.equal(s.pve.writes().length, 0, "no write reached Proxmox");
      assert.ok(s.pve.calls.length > 0, "reads did");
      assert.deepEqual(
        skipped.map((c) => `${c.method} ${c.path}`),
        [
          `POST ${Q}/9000/clone`,
          `PUT ${Q}/2000/config`,
          `PUT ${Q}/2000/firewall/options`,
          `POST ${Q}/2000/firewall/ipset`,
          `POST ${Q}/2000/firewall/ipset/ipfilter-net0`,
          `PUT ${Q}/2000/resize`,
          `POST ${Q}/2000/status/start`,
        ],
      );
      const config = skipped[1]!.params;
      assert.equal(config.sshkeys, "[1 public key]");
      assert.equal(config.net0, "virtio,bridge=vmbr10,firewall=1");
      // F7: the IO limits and onboot=0 are in the plan, on the volume a full clone gets.
      assert.equal(config.onboot, 0);
      assert.equal(config.scsi0, `${STORAGE}:vm-2000-disk-0,iops_rd=2000,iops_wr=2000,mbps_rd=100,mbps_wr=100`);
      assert.ok(!s.pve.calls.some((c) => c.path === `${Q}/2000/config`), "no read of a VM the dry run never cloned");
      const text = JSON.stringify(skipped);
      assert.ok(!text.includes(s.env.PROXMOX_TOKEN_SECRET!), "no token in the dry-run log");
      assert.equal(s.pve.vms.size, 1, "only the template exists");

      skipped.length = 0;
      const plan = await s.driver.ensureImages();
      assert.deepEqual(plan.map((r) => r.action), ["present", "created"], "debian's template exists; ubuntu's is planned");
      assert.deepEqual(
        skipped.map((c) => `${c.method} ${c.path}`),
        [`POST /nodes/${NODE}/storage/${IMPORT_STORAGE}/download-url`, `POST ${Q}`, `POST ${Q}/9001/template`],
      );
      assert.equal(s.pve.writes().length, 0, "still no write reached Proxmox");
    } finally {
      await s.close();
    }
  });

  it("redacts secret-looking parameters", () => {
    assert.deepEqual(redactParams({ cipassword: "x", token: "y", name: "web", sshkeys: encodeURIComponent("a\nb") }), {
      cipassword: "[redacted]",
      token: "[redacted]",
      name: "web",
      sshkeys: "[2 public keys]",
    });
  });
});

describe("ensureImages", () => {
  it("parses vendor checksum lists", () => {
    assert.equal(checksumFor(vendorLists[DEBIAN.checksumsUrl]!, DEBIAN.fileName, "sha512"), debianHash);
    assert.equal(checksumFor(vendorLists[UBUNTU.checksumsUrl]!, UBUNTU.fileName, "sha256"), ubuntuHash);
    assert.equal(checksumFor(vendorLists[UBUNTU.checksumsUrl]!, UBUNTU.fileName, "sha512"), null, "wrong length");
    assert.equal(checksumFor("garbage", UBUNTU.fileName, "sha256"), null);
  });

  it("downloads with the vendor checksum, builds both templates, and is idempotent", async () => {
    const s = await setup({ fetchText, vendorFiles });
    try {
      const first = await s.driver.ensureImages();
      assert.deepEqual(first.map((r) => [r.imageId, r.templateVmid, r.action]), [
        ["debian-12", 9000, "created"],
        ["ubuntu-24.04", 9001, "created"],
      ]);
      assert.deepEqual(s.pve.summary(s.pve.writes()), [
        `POST /nodes/${NODE}/storage/${IMPORT_STORAGE}/download-url`,
        `POST ${Q}`,
        `POST ${Q}/9000/template`,
        `POST /nodes/${NODE}/storage/${IMPORT_STORAGE}/download-url`,
        `POST ${Q}`,
        `POST ${Q}/9001/template`,
      ]);
      const [download, create] = s.pve.writes();
      assert.deepEqual(download!.params, {
        content: "import",
        filename: importFileName(DEBIAN, debianHash),
        url: DEBIAN.url,
        checksum: debianHash,
        "checksum-algorithm": "sha512",
        "verify-certificates": "1",
      });
      assert.equal(create!.params.scsi0, `${STORAGE}:0,import-from=${IMPORT_STORAGE}:import/${importFileName(DEBIAN, debianHash)}`);
      assert.equal(create!.params.ide2, `${STORAGE}:cloudinit`);
      assert.equal(create!.params.net0, "virtio,bridge=vmbr10,firewall=1");
      assert.equal(create!.params.pool, POOL);
      assert.equal(s.pve.vms.get(9000)!.template, 1);
      assert.equal(s.pve.vms.get(9001)!.template, 1);

      s.pve.reset();
      const again = await s.driver.ensureImages();
      assert.deepEqual(again.map((r) => r.action), ["present", "present"]);
      assert.equal(s.pve.writes().length, 0);

      // A create can now use the template.
      await s.driver.create(createInput(randomUUID(), { imageId: "ubuntu-24.04" }));
      assert.equal(s.pve.vms.get(2000)!.status, "running");
    } finally {
      await s.close();
    }
  });

  it("finishes a half-built template and reuses an existing download", async () => {
    const s = await setup({ fetchText, vendorFiles });
    try {
      s.pve.addVm({ vmid: 9000, pool: POOL, name: "sqc-tpl-debian-12" });
      s.pve.storageContent.add(`${IMPORT_STORAGE}:import/${importFileName(UBUNTU, ubuntuHash)}`);
      const results = await s.driver.ensureImages();
      assert.deepEqual(results.map((r) => r.action), ["converted", "created"]);
      assert.deepEqual(s.pve.summary(s.pve.writes()), [`POST ${Q}/9000/template`, `POST ${Q}`, `POST ${Q}/9001/template`]);
    } finally {
      await s.close();
    }
  });

  it("stops when the vendor list is missing or Proxmox finds a checksum mismatch", async () => {
    const s = await setup({ fetchText: async () => "nothing here", vendorFiles });
    try {
      await assert.rejects(s.driver.ensureImages(), code(PROXMOX_ERRORS.imageChecksum));
      assert.equal(s.pve.writes().length, 0);
    } finally {
      await s.close();
    }
    const t = await setup({ fetchText, vendorFiles: { [DEBIAN.url]: { sha512: "f".repeat(128) } } });
    try {
      await assert.rejects(t.driver.ensureImages(), code(PROXMOX_ERRORS.taskFailed));
      assert.deepEqual(t.pve.summary(t.pve.writes()), [`POST /nodes/${NODE}/storage/${IMPORT_STORAGE}/download-url`]);
      assert.equal(t.pve.vms.size, 0, "no template from an unverified image");
    } finally {
      await t.close();
    }
  });

  it("never touches a template VMID that belongs to a VM outside the pool", async () => {
    const s = await setup({ fetchText, vendorFiles });
    try {
      s.pve.addVm({ vmid: 9000, pool: "other", name: "someone-else" });
      await assert.rejects(s.driver.ensureImages(), code(PROXMOX_ERRORS.fenceRefused));
      assert.equal(s.pve.writes().length, 0);
    } finally {
      await s.close();
    }
  });
});
