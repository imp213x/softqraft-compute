/**
 * Pilot VM limits (founder decision F7): every VM's disk gets read and write
 * limits in MB/s and IOPS, and `onboot=0`, in the create's config call.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DriverError } from "@softqraft/compute-driver";
import { DISK_LIMIT_BOUNDS, loadProxmoxConfig, ProxmoxConfigError } from "./config.js";
import { diskWithLimits } from "./driver.js";
import { PROXMOX_ERRORS } from "./errors.js";
import { createInput, NODE, POOL, setup, STORAGE } from "./test-support.test-helper.js";

const Q = `/nodes/${NODE}/qemu`;
const code = (c: string) => (err: unknown) => err instanceof DriverError && err.code === c;

describe("pilot VM limits (F7)", () => {
  it("has the defaults 100 MB/s and 2000 IOPS, takes other values, and refuses out-of-range ones by name", async () => {
    const s = await setup();
    try {
      assert.deepEqual(s.config.diskLimits, { mbps: 100, iops: 2000 });
      assert.deepEqual(loadProxmoxConfig({ ...s.env, COMPUTE_VM_DISK_MBPS: "250", COMPUTE_VM_DISK_IOPS: "4000" }).diskLimits, {
        mbps: 250,
        iops: 4000,
      });
      assert.deepEqual(
        loadProxmoxConfig({ ...s.env, COMPUTE_VM_DISK_MBPS: "1000", COMPUTE_VM_DISK_IOPS: "50000" }).diskLimits,
        { mbps: DISK_LIMIT_BOUNDS.mbps.max, iops: DISK_LIMIT_BOUNDS.iops.max },
      );
      const bad: Array<[string, string]> = [
        ["COMPUTE_VM_DISK_MBPS", "0"],
        ["COMPUTE_VM_DISK_MBPS", "1001"],
        ["COMPUTE_VM_DISK_MBPS", "-5"],
        ["COMPUTE_VM_DISK_MBPS", "12.5"],
        ["COMPUTE_VM_DISK_MBPS", "fast"],
        ["COMPUTE_VM_DISK_IOPS", "9"],
        ["COMPUTE_VM_DISK_IOPS", "50001"],
        ["COMPUTE_VM_DISK_IOPS", "1e4"],
      ];
      for (const [name, value] of bad) {
        assert.throws(
          () => loadProxmoxConfig({ ...s.env, [name]: value }),
          (err: Error) => err instanceof ProxmoxConfigError && err.message.includes(name) && !err.message.includes(`"${value}"`),
          `${name}=${value}`,
        );
      }
    } finally {
      await s.close();
    }
  });

  it("puts the limits and onboot=0 in the create's config call, and a retry sets the same values again", async () => {
    const s = await setup({ env: { COMPUTE_VM_DISK_MBPS: "150", COMPUTE_VM_DISK_IOPS: "3000" } });
    try {
      s.pve.addTemplate(9000);
      const id = randomUUID();
      await s.driver.create(createInput(id));
      const vm = s.pve.vms.get(2000)!;
      const limited = "iops_rd=3000,iops_wr=3000,mbps_rd=150,mbps_wr=150";
      const put = () => s.pve.calls.filter((c) => c.method === "PUT" && c.path === `${Q}/2000/config`);
      assert.equal(put().length, 1, "one config write");
      assert.equal(put()[0]!.params.onboot, "0");
      assert.equal(put()[0]!.params.scsi0, `${STORAGE}:vm-2000-disk-0,size=3G,${limited}`);
      assert.equal(vm.config.scsi0, `${STORAGE}:vm-2000-disk-0,size=16G,${limited}`, "the resize kept the limits");
      assert.equal(vm.config.onboot, "0");

      // A retried create reads the disk and writes the same limits, once each.
      s.pve.reset();
      await s.driver.create(createInput(id));
      assert.equal(put().length, 1);
      assert.equal(put()[0]!.params.scsi0, `${STORAGE}:vm-2000-disk-0,size=16G,${limited}`);
      assert.equal(vm.config.scsi0, `${STORAGE}:vm-2000-disk-0,size=16G,${limited}`);
      assert.equal(vm.config.onboot, "0");
    } finally {
      await s.close();
    }
  });

  it("replaces looser limits and bursts left on a VM, and turns onboot off", async () => {
    const s = await setup();
    try {
      s.pve.addTemplate(9001);
      const id = randomUUID();
      // A VM from an earlier attempt, edited by hand: higher limits, a burst and onboot on.
      s.pve.addVm({
        vmid: 2004,
        pool: POOL,
        name: `sqc-${id}`,
        config: {
          scsi0: `${STORAGE}:vm-2004-disk-0,discard=on,iops_rd=99999,mbps=900,mbps_wr_max=2000,size=16G`,
          onboot: "1",
        },
      });
      await s.driver.create(createInput(id, { imageId: "ubuntu-24.04" }));
      const vm = s.pve.vms.get(2004)!;
      assert.equal(vm.config.scsi0, `${STORAGE}:vm-2004-disk-0,discard=on,size=16G,iops_rd=2000,iops_wr=2000,mbps_rd=100,mbps_wr=100`);
      assert.equal(vm.config.onboot, "0");
    } finally {
      await s.close();
    }
  });

  it("builds the disk spec idempotently", () => {
    const limits = { mbps: 100, iops: 2000 };
    const once = diskWithLimits("compute-pilot:vm-2000-disk-0,size=16G", limits);
    assert.equal(once, "compute-pilot:vm-2000-disk-0,size=16G,iops_rd=2000,iops_wr=2000,mbps_rd=100,mbps_wr=100");
    assert.equal(diskWithLimits(once, limits), once);
    assert.equal(
      diskWithLimits("compute-pilot:vm-2000-disk-0,iops=5,iops_max=9,iops_rd_max_length=3,cache=none", limits),
      "compute-pilot:vm-2000-disk-0,cache=none,iops_rd=2000,iops_wr=2000,mbps_rd=100,mbps_wr=100",
    );
  });

  it("refuses a config write naming another volume or an import, before sending", async () => {
    const s = await setup();
    try {
      s.pve.addVm({ vmid: 2000, pool: POOL, tags: `sqc-${randomUUID()}`, config: { scsi0: `${STORAGE}:vm-2000-disk-0,size=16G` } });
      await s.driver.resources();
      s.pve.reset();
      const refused = code(PROXMOX_ERRORS.fenceRefused);
      for (const scsi0 of [
        `${STORAGE}:vm-101-disk-0,mbps_rd=100`,
        `local-lvm:vm-2000-disk-0,mbps_rd=100`,
        `${STORAGE}:base-9000-disk-0`,
        `${STORAGE}:16`,
        `${STORAGE}:vm-2000-disk-0,import-from=local:import/x.qcow2`,
      ]) {
        await assert.rejects(s.driver.client.call("PUT", `${Q}/2000/config`, { scsi0 }), refused, scsi0);
      }
      assert.equal(s.pve.calls.length, 0, "nothing reached Proxmox");
    } finally {
      await s.close();
    }
  });

  it("stops before configuring a VM whose disk is not on the pilot storage", async () => {
    const s = await setup();
    try {
      const id = randomUUID();
      s.pve.addVm({ vmid: 2001, pool: POOL, name: `sqc-${id}`, config: { scsi0: "local-lvm:vm-2001-disk-0,size=16G" } });
      await assert.rejects(s.driver.create(createInput(id)), code(PROXMOX_ERRORS.badResponse));
      assert.equal(s.pve.writes().length, 0);
    } finally {
      await s.close();
    }
  });
});
