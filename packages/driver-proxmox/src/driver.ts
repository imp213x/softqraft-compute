/**
 * ProxmoxDriver: the HypervisorDriver for Proxmox VE 8, over its HTTP API.
 *
 * A VM is found by its tag `sqc-<instance id>` (or, between the clone and
 * the first config write, by its name `sqc-<instance id>`), in the pool, in
 * COMPUTE_VMID_RANGE. Every operation looks first and changes only what is
 * not already done, so a retried job is safe. The fences are enforced again
 * by the client on every call.
 */

import {
  DRIVER_ERRORS,
  DriverError,
  PROXMOX_DRIVER_CAPABILITIES,
  type ConsoleTicket,
  type CreateVmInput,
  type HypervisorDriver,
  type InstanceSize,
  type SnapshotInfo,
  type VmStatus,
  type VmSummary,
} from "@softqraft/compute-driver";
import { ProxmoxClient, type ProxmoxClientOptions } from "./client.js";
import type { ProxmoxConfig } from "./config.js";
import { PROXMOX_ERRORS, fenceRefused, proxmoxError } from "./errors.js";
import {
  IMAGE_CATALOGUE,
  defaultFetchText,
  ensureImages,
  type EnsureImageResult,
  type FetchText,
  type VmResource,
} from "./images.js";
import type { ProxmoxTransport } from "./transport.js";

export const INSTANCE_TAG_PREFIX = "sqc-";
export const IPSET_NAME = "ipfilter-net0";
const DISK = "scsi0";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Production's network (never configured on a pilot VM). */
const PRODUCTION = { base: ipToInt("10.20.0.0"), prefix: 24 };

export function instanceTag(instanceId: string): string {
  return `${INSTANCE_TAG_PREFIX}${instanceId}`;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return Number.NaN;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr(ip: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

/** `ip=<ip>/<prefix>,gw=<gateway>`, after checking the address belongs to the network. */
export function ipConfig(privateIp: string, network: { cidr: string; gateway: string }): string {
  const bad = () => proxmoxError(PROXMOX_ERRORS.network, "The job's address does not fit its network");
  const [baseText, prefixText] = network.cidr.split("/");
  const prefix = Number(prefixText);
  const base = ipToInt(baseText ?? "");
  const ip = ipToInt(privateIp);
  const gw = ipToInt(network.gateway);
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 30 || [base, ip, gw].some(Number.isNaN)) throw bad();
  if (!inCidr(ip, base, prefix) || !inCidr(gw, base, prefix) || ip === gw) throw bad();
  const host = ~((0xffffffff << (32 - prefix)) >>> 0) >>> 0;
  if ((ip & host) === 0 || (ip & host) === host) throw bad();
  if (inCidr(ip, PRODUCTION.base, PRODUCTION.prefix) || inCidr(base, PRODUCTION.base, PRODUCTION.prefix)) {
    throw proxmoxError(PROXMOX_ERRORS.network, "The job names the production network");
  }
  return `ip=${privateIp}/${prefix},gw=${network.gateway}`;
}

/** Proxmox wants `sshkeys` URL-encoded (and the form encoding adds a second layer). */
export function encodeSshKeys(keys: readonly string[]): string {
  return encodeURIComponent(keys.join("\n"));
}

/** Disk size in MiB from a disk spec such as `local-lvm:vm-2000-disk-0,size=16G`. */
export function diskSizeMb(spec: string): number | null {
  const match = /(?:^|,)size=([0-9]+(?:\.[0-9]+)?)([KMGT]?)(?:,|$)/.exec(spec);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] ?? "";
  const factor = unit === "T" ? 1024 * 1024 : unit === "G" ? 1024 : unit === "M" ? 1 : unit === "K" ? 1 / 1024 : 1 / (1024 * 1024);
  return n * factor;
}

/** Disk options the driver owns: the limits, and the bursts and combined forms that would loosen them. */
const LIMIT_OPTION = /^(?:mbps|iops)(?:_rd|_wr)?(?:_max(?:_length)?)?$/;

/**
 * The disk spec with the pilot IO limits (decision F7): the volume and its
 * other options as they are, any earlier limit or burst option replaced by
 * `iops_rd`, `iops_wr`, `mbps_rd` and `mbps_wr`. Applying it twice gives the
 * same spec, so a retried create sets the same limits again.
 */
export function diskWithLimits(spec: string, limits: { mbps: number; iops: number }): string {
  const [volume = "", ...options] = spec.split(",").filter((part, i) => i === 0 || part.length > 0);
  const kept = options.filter((option) => !LIMIT_OPTION.test(option.split("=")[0] ?? ""));
  return [
    volume,
    ...kept,
    `iops_rd=${limits.iops}`,
    `iops_wr=${limits.iops}`,
    `mbps_rd=${limits.mbps}`,
    `mbps_wr=${limits.mbps}`,
  ].join(",");
}

function snapshotNameOk(name: string): boolean {
  // Proxmox needs at least two characters and reserves `current`.
  return /^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(name) && name !== "current";
}

export interface ProxmoxDriverOptions extends ProxmoxClientOptions {
  /**
   * Writes are logged, not sent (the transport does that). The driver only
   * needs to know so it does not read back a VM a dry-run clone never made.
   */
  dryRun?: boolean;
  /** Vendor checksum list fetcher for ensureImages (tests inject one). */
  fetchText?: FetchText;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export class ProxmoxDriver implements HypervisorDriver {
  readonly name = "proxmox";
  readonly capabilities = PROXMOX_DRIVER_CAPABILITIES;
  readonly client: ProxmoxClient;
  private readonly fetchText: FetchText;
  private readonly log?: (event: string, fields: Record<string, unknown>) => void;
  private readonly dryRun: boolean;

  constructor(
    private readonly config: ProxmoxConfig,
    transport: ProxmoxTransport,
    options: ProxmoxDriverOptions = {},
  ) {
    this.client = new ProxmoxClient(config, transport, { taskTimeoutSeconds: config.taskTimeoutSeconds, ...options });
    this.fetchText = options.fetchText ?? defaultFetchText;
    this.log = options.log;
    this.dryRun = options.dryRun ?? false;
  }

  private path(vmid: number, rest = ""): string {
    return this.client.node(`/qemu/${vmid}${rest}`);
  }

  /** Every VM the token can see; pool members inside our ranges are noted for the fence. */
  async resources(): Promise<VmResource[]> {
    const data = (await this.client.get("/cluster/resources", { type: "vm" })) as VmResource[] | null;
    if (!Array.isArray(data)) throw proxmoxError(PROXMOX_ERRORS.badResponse, "Proxmox returned no VM list");
    const vms = data.filter((r) => r && typeof r.vmid === "number" && (r.type === undefined || r.type === "qemu"));
    for (const vm of vms) {
      if (vm.pool === this.config.pool && (vm.node === undefined || vm.node === this.config.node)) {
        this.client.notePoolMember(vm.vmid);
      }
    }
    return vms;
  }

  private static tags(vm: VmResource): string[] {
    return (vm.tags ?? "").split(/[;,\s]+/).filter(Boolean);
  }

  /** The instance's VM, or null. Refuses one found outside the pool, node or range. */
  private async find(instanceId: string): Promise<VmResource | null> {
    if (!UUID_RE.test(instanceId)) throw proxmoxError(PROXMOX_ERRORS.vmNotFound, "Not a Compute instance id");
    const tag = instanceTag(instanceId);
    const matches = (await this.resources()).filter((vm) => vm.name === tag || ProxmoxDriver.tags(vm).includes(tag));
    if (matches.length === 0) return null;
    if (matches.length > 1) throw proxmoxError(PROXMOX_ERRORS.badResponse, "More than one VM carries this instance's tag");
    const vm = matches[0]!;
    if (vm.pool !== this.config.pool) throw fenceRefused("the instance's VM is outside PROXMOX_POOL");
    if (vm.node !== undefined && vm.node !== this.config.node) throw fenceRefused("the instance's VM is on another node");
    if (!this.client.isInstanceVmid(vm.vmid)) throw fenceRefused("the instance's VM is outside COMPUTE_VMID_RANGE");
    return vm;
  }

  private async require(instanceId: string): Promise<VmResource> {
    const vm = await this.find(instanceId);
    if (!vm) throw new DriverError(DRIVER_ERRORS.vmNotFound, "VM does not exist", false);
    return vm;
  }

  private async power(vmid: number): Promise<"running" | "stopped"> {
    const current = (await this.client.get(this.path(vmid, "/status/current"))) as { status?: string } | null;
    return current?.status === "running" ? "running" : "stopped";
  }

  /** The lowest VMID in range that no visible VM uses and Proxmox confirms free. */
  private async allocateVmid(used: Set<number>): Promise<number> {
    const { min, max } = this.config.vmidRange;
    let tries = 0;
    for (let vmid = min; vmid <= max && tries < 50; vmid += 1) {
      if (used.has(vmid)) continue;
      tries += 1;
      try {
        await this.client.get("/cluster/nextid", { vmid });
        return vmid;
      } catch (err) {
        // 400: taken by a VM this token cannot see. Try the next one.
        if (err instanceof DriverError && err.code === PROXMOX_ERRORS.rejected) continue;
        throw err;
      }
    }
    throw proxmoxError(PROXMOX_ERRORS.vmidExhausted, "No free VMID in COMPUTE_VMID_RANGE");
  }

  async create(input: CreateVmInput): Promise<void> {
    const { instanceId, spec } = input;
    const ipconfig0 = ipConfig(input.privateIp, input.network);
    const image = IMAGE_CATALOGUE[spec.imageId];
    if (!image) throw proxmoxError(PROXMOX_ERRORS.unknownImage, "The image is not in the catalogue");
    const tag = instanceTag(instanceId);

    let vm = await this.find(instanceId);
    let fresh = false;
    if (!vm) {
      const vms = await this.resources();
      const template = vms.find((r) => r.vmid === image.templateVmid);
      if (!template || template.pool !== this.config.pool || template.template !== 1) {
        throw proxmoxError(PROXMOX_ERRORS.imageUnavailable, "The image's template is not ready on this host", true);
      }
      const vmid = await this.allocateVmid(new Set(vms.map((r) => r.vmid)));
      await this.client.task("POST", this.path(image.templateVmid, "/clone"), {
        newid: vmid,
        name: tag,
        pool: this.config.pool,
        storage: this.config.storage,
        full: 1,
        description: `SoftQraft Compute instance ${instanceId}`,
      });
      this.client.notePoolMember(vmid);
      vm = { vmid, pool: this.config.pool, status: "stopped" };
      fresh = true;
    }
    const vmid = vm.vmid;

    // The disk's IO limits (F7) need its volume, which the clone named. A
    // dry run made no clone, so it plans with the name a full clone gets.
    const disk =
      fresh && this.dryRun
        ? `${this.config.storage}:vm-${vmid}-disk-0`
        : String((((await this.client.get(this.path(vmid, "/config"))) as Record<string, unknown> | null) ?? {})[DISK] ?? "");
    if (!disk.startsWith(`${this.config.storage}:`)) {
      throw proxmoxError(PROXMOX_ERRORS.badResponse, "The VM has no scsi0 disk on PROXMOX_STORAGE");
    }

    await this.client.call("PUT", this.path(vmid, "/config"), {
      name: spec.name,
      tags: tag,
      cores: spec.vcpu,
      sockets: 1,
      memory: spec.memoryMb,
      net0: `virtio,bridge=${this.config.bridge},firewall=1`,
      ciuser: this.config.ciUser,
      ...(spec.sshPublicKeys.length > 0 ? { sshkeys: encodeSshKeys(spec.sshPublicKeys) } : {}),
      ipconfig0,
      nameserver: this.config.nameservers.join(" "),
      // F7: pilot VMs never start with the host, and their disk is IO-limited.
      onboot: 0,
      [DISK]: diskWithLimits(disk, this.config.diskLimits),
    });
    await this.antiSpoofing(vmid, input.privateIp, fresh);
    await this.client.task("PUT", this.path(vmid, "/resize"), { disk: DISK, size: `${spec.diskGb}G` });
    if (fresh || (await this.power(vmid)) !== "running") {
      await this.client.task("POST", this.path(vmid, "/status/start"));
    }
  }

  /** VM firewall on with IP and MAC filtering, and the ipset pinned to exactly the assigned address. */
  private async antiSpoofing(vmid: number, ip: string, fresh: boolean): Promise<void> {
    await this.client.call("PUT", this.path(vmid, "/firewall/options"), {
      enable: 1,
      ipfilter: 1,
      macfilter: 1,
      dhcp: 0,
      ndp: 0,
      radv: 0,
      policy_in: "DROP",
      policy_out: "ACCEPT",
    });
    const ipsetPath = this.path(vmid, `/firewall/ipset/${IPSET_NAME}`);
    if (fresh) {
      await this.client.call("POST", this.path(vmid, "/firewall/ipset"), { name: IPSET_NAME, comment: "SoftQraft Compute address" });
      await this.client.call("POST", ipsetPath, { cidr: ip });
      return;
    }
    const sets = ((await this.client.get(this.path(vmid, "/firewall/ipset"))) as Array<{ name?: string }> | null) ?? [];
    if (!sets.some((s) => s.name === IPSET_NAME)) {
      await this.client.call("POST", this.path(vmid, "/firewall/ipset"), { name: IPSET_NAME, comment: "SoftQraft Compute address" });
    }
    const entries = ((await this.client.get(ipsetPath)) as Array<{ cidr?: string }> | null) ?? [];
    const cidrs = entries.map((e) => String(e.cidr ?? ""));
    const wanted = (c: string) => c === ip || c === `${ip}/32`;
    if (!cidrs.some(wanted)) await this.client.call("POST", ipsetPath, { cidr: ip });
    for (const cidr of cidrs.filter((c) => c && !wanted(c))) {
      await this.client.call("DELETE", `${ipsetPath}/${encodeURIComponent(cidr)}`);
    }
  }

  async start(instanceId: string): Promise<void> {
    const vm = await this.require(instanceId);
    if ((await this.power(vm.vmid)) === "running") return;
    await this.client.task("POST", this.path(vm.vmid, "/status/start"));
  }

  /** A graceful shutdown with a timeout; if the VM is still up after it, a stop. */
  async stop(instanceId: string): Promise<void> {
    const vm = await this.require(instanceId);
    if ((await this.power(vm.vmid)) === "stopped") return;
    const timeout = this.config.shutdownTimeoutSeconds;
    try {
      await this.client.task("POST", this.path(vm.vmid, "/status/shutdown"), { timeout }, timeout + 30);
    } catch (err) {
      if (!(err instanceof DriverError) || (err.code !== PROXMOX_ERRORS.taskFailed && err.code !== PROXMOX_ERRORS.taskTimeout)) {
        throw err;
      }
      this.log?.("proxmox.shutdown_timed_out", { vmid: vm.vmid });
    }
    if ((await this.power(vm.vmid)) === "running") {
      await this.client.task("POST", this.path(vm.vmid, "/status/stop"));
    }
  }

  async delete(instanceId: string): Promise<void> {
    const vm = await this.find(instanceId);
    if (!vm) return;
    if ((await this.power(vm.vmid)) === "running") {
      await this.client.task("POST", this.path(vm.vmid, "/status/stop"));
    }
    await this.client.task("DELETE", this.path(vm.vmid), { purge: 1, "destroy-unreferenced-disks": 1 });
    this.client.forgetPoolMember(vm.vmid);
  }

  async resize(instanceId: string, size: InstanceSize): Promise<void> {
    const vm = await this.require(instanceId);
    if ((await this.power(vm.vmid)) === "running") {
      throw new DriverError(DRIVER_ERRORS.vmRunning, "Stop the VM before resizing it", false);
    }
    const config = ((await this.client.get(this.path(vm.vmid, "/config"))) as Record<string, unknown> | null) ?? {};
    const currentMb = diskSizeMb(String(config[DISK] ?? ""));
    if (currentMb === null) throw proxmoxError(PROXMOX_ERRORS.badResponse, "The VM has no readable scsi0 size");
    const targetMb = size.diskGb * 1024;
    if (targetMb < currentMb) throw new DriverError(DRIVER_ERRORS.diskShrink, "A disk can only grow", false);
    if (Number(config.cores) !== size.vcpu || Number(config.memory) !== size.memoryMb) {
      await this.client.call("PUT", this.path(vm.vmid, "/config"), { cores: size.vcpu, memory: size.memoryMb });
    }
    if (targetMb > currentMb) {
      await this.client.task("PUT", this.path(vm.vmid, "/resize"), { disk: DISK, size: `${size.diskGb}G` });
    }
  }

  private async snapshotNames(vmid: number): Promise<string[]> {
    const list = ((await this.client.get(this.path(vmid, "/snapshot"))) as Array<{ name?: string }> | null) ?? [];
    return list.map((s) => String(s.name ?? "")).filter((n) => n && n !== "current");
  }

  async snapshot(instanceId: string, snapshotName: string): Promise<void> {
    if (!snapshotNameOk(snapshotName)) {
      throw proxmoxError(PROXMOX_ERRORS.snapshotName, "Proxmox needs a snapshot name of 2 or more characters, not current");
    }
    const vm = await this.require(instanceId);
    if ((await this.snapshotNames(vm.vmid)).includes(snapshotName)) return;
    await this.client.task("POST", this.path(vm.vmid, "/snapshot"), {
      snapname: snapshotName,
      description: "SoftQraft Compute snapshot",
    });
  }

  async listSnapshots(instanceId: string): Promise<SnapshotInfo[]> {
    const vm = await this.require(instanceId);
    return (await this.snapshotNames(vm.vmid)).map((name) => ({ name }));
  }

  async deleteSnapshot(instanceId: string, snapshotName: string): Promise<void> {
    const vm = await this.find(instanceId);
    if (!vm) return;
    if (!snapshotNameOk(snapshotName)) return; // such a snapshot can never have been taken
    if (!(await this.snapshotNames(vm.vmid)).includes(snapshotName)) return;
    await this.client.task("DELETE", this.path(vm.vmid, `/snapshot/${snapshotName}`));
  }

  /** Not in C1: the browser console needs a relay for the outbound-only design. */
  async console(_instanceId: string): Promise<ConsoleTicket> {
    throw new DriverError(DRIVER_ERRORS.unsupported, "The Proxmox driver has no console in C1", false);
  }

  async status(instanceId: string): Promise<VmStatus> {
    const vm = await this.find(instanceId);
    if (!vm) return { instanceId, power: "absent", snapshots: [] };
    return { instanceId, power: await this.power(vm.vmid), snapshots: await this.snapshotNames(vm.vmid) };
  }

  async list(): Promise<VmSummary[]> {
    const out: VmSummary[] = [];
    for (const vm of await this.resources()) {
      if (vm.pool !== this.config.pool || !this.client.isInstanceVmid(vm.vmid) || vm.template === 1) continue;
      const tag = ProxmoxDriver.tags(vm).find((t) => t.startsWith(INSTANCE_TAG_PREFIX) && UUID_RE.test(t.slice(4)));
      if (!tag) continue;
      out.push({ instanceId: tag.slice(4), power: vm.status === "running" ? "running" : "stopped" });
    }
    return out;
  }

  /**
   * Read-only: which catalogue templates are not ready in the pool (a
   * template VM at the catalogue VMID, in PROXMOX_POOL, converted). Used when
   * the founder builds the templates by hand (COMPUTE_AGENT_ENSURE_IMAGES=false).
   */
  async missingTemplates(): Promise<Array<{ imageId: string; templateVmid: number }>> {
    const vms = await this.resources();
    return Object.values(IMAGE_CATALOGUE)
      .filter((image) => {
        const vm = vms.find((r) => r.vmid === image.templateVmid);
        return !vm || vm.pool !== this.config.pool || vm.template !== 1 || (vm.node !== undefined && vm.node !== this.config.node);
      })
      .map((image) => ({ imageId: image.imageId, templateVmid: image.templateVmid }));
  }

  /** Create any missing image templates (see images.ts). */
  async ensureImages(): Promise<EnsureImageResult[]> {
    return ensureImages({
      client: this.client,
      resources: () => this.resources(),
      storage: this.config.storage,
      importStorage: this.config.importStorage,
      bridge: this.config.bridge,
      pool: this.config.pool,
      fetchText: this.fetchText,
      log: this.log,
    });
  }
}
