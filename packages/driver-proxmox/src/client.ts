/**
 * The Proxmox API client with its fences.
 *
 * Every call is checked before it reaches the transport, so a call outside
 * the fences is never sent:
 *
 * - the endpoint is one of a fixed list, on the configured node only;
 * - an instance VMID is inside COMPUTE_VMID_RANGE and a template VMID inside
 *   9000-9099, and only template-safe endpoints take a template VMID;
 * - a VM is touched only once a read showed it in PROXMOX_POOL (or this
 *   client created it there);
 * - `pool` is PROXMOX_POOL, `storage` and every disk are on PROXMOX_STORAGE
 *   (vendor downloads alone go to PROXMOX_IMPORT_STORAGE), and every NIC is
 *   on PROXMOX_BRIDGE;
 * - write parameters come from a fixed list per endpoint.
 */

import type { ProxmoxConfig } from "./config.js";
import { TEMPLATE_VMID_RANGE } from "./config.js";
import { PROXMOX_ERRORS, fenceRefused, proxmoxError } from "./errors.js";
import type { HttpMethod, Params, ProxmoxCall, ProxmoxTransport } from "./transport.js";

export type FenceConfig = Pick<ProxmoxConfig, "node" | "pool" | "storage" | "importStorage" | "bridge" | "vmidRange">;

type VmidKind = "instance" | "template" | "any";

interface Route {
  name: string;
  methods: readonly HttpMethod[];
  /** Matches the path after `/nodes/<node>` (or the whole path for cluster routes). */
  pattern: RegExp;
  /** Which VMID the path's first capture is, if any. */
  vmid?: VmidKind;
  /** Parameter names a write may carry. */
  writeParams?: readonly string[];
  /** Parameter names a read may carry. */
  readParams?: readonly string[];
}

const CONFIG_PARAMS = [
  "name", "tags", "description", "cores", "sockets", "memory", "balloon", "net0", "ciuser", "sshkeys",
  "ipconfig0", "nameserver", "searchdomain", "onboot", "agent",
] as const;

const CREATE_PARAMS = [
  "vmid", "name", "pool", "ostype", "cores", "memory", "scsihw", "scsi0", "ide2", "boot", "serial0", "vga",
  "agent", "net0", "tags", "description",
] as const;

const CLUSTER_ROUTES: readonly Route[] = [
  { name: "cluster.resources", methods: ["GET"], pattern: /^\/cluster\/resources$/, readParams: ["type"] },
  { name: "cluster.nextid", methods: ["GET"], pattern: /^\/cluster\/nextid$/, readParams: ["vmid"] },
];

const NODE_ROUTES: readonly Route[] = [
  { name: "task.status", methods: ["GET"], pattern: /^\/tasks\/(UPID:[^/]+)\/status$/ },
  { name: "vm.create", methods: ["POST"], pattern: /^\/qemu$/, writeParams: CREATE_PARAMS },
  { name: "vm.config", methods: ["GET", "PUT"], pattern: /^\/qemu\/([0-9]+)\/config$/, vmid: "any", writeParams: CONFIG_PARAMS },
  { name: "vm.status", methods: ["GET"], pattern: /^\/qemu\/([0-9]+)\/status\/current$/, vmid: "instance" },
  { name: "vm.power", methods: ["POST"], pattern: /^\/qemu\/([0-9]+)\/status\/(?:start|stop|shutdown)$/, vmid: "instance", writeParams: ["timeout", "forceStop"] },
  { name: "vm.clone", methods: ["POST"], pattern: /^\/qemu\/([0-9]+)\/clone$/, vmid: "template", writeParams: ["newid", "name", "pool", "storage", "full", "description"] },
  { name: "vm.template", methods: ["POST"], pattern: /^\/qemu\/([0-9]+)\/template$/, vmid: "template", writeParams: [] },
  { name: "vm.delete", methods: ["DELETE"], pattern: /^\/qemu\/([0-9]+)$/, vmid: "instance", writeParams: ["purge", "destroy-unreferenced-disks"] },
  { name: "vm.resize", methods: ["PUT"], pattern: /^\/qemu\/([0-9]+)\/resize$/, vmid: "instance", writeParams: ["disk", "size"] },
  { name: "vm.snapshots", methods: ["GET", "POST"], pattern: /^\/qemu\/([0-9]+)\/snapshot$/, vmid: "instance", writeParams: ["snapname", "description"] },
  { name: "vm.snapshot.delete", methods: ["DELETE"], pattern: /^\/qemu\/([0-9]+)\/snapshot\/[A-Za-z][A-Za-z0-9_-]{1,39}$/, vmid: "instance", writeParams: [] },
  { name: "vm.firewall.options", methods: ["GET", "PUT"], pattern: /^\/qemu\/([0-9]+)\/firewall\/options$/, vmid: "instance", writeParams: ["enable", "ipfilter", "macfilter", "dhcp", "ndp", "radv", "policy_in", "policy_out"] },
  { name: "vm.ipsets", methods: ["GET", "POST"], pattern: /^\/qemu\/([0-9]+)\/firewall\/ipset$/, vmid: "instance", writeParams: ["name", "comment"] },
  { name: "vm.ipset", methods: ["GET", "POST"], pattern: /^\/qemu\/([0-9]+)\/firewall\/ipset\/ipfilter-net0$/, vmid: "instance", writeParams: ["cidr", "comment"] },
  { name: "vm.ipset.entry", methods: ["DELETE"], pattern: /^\/qemu\/([0-9]+)\/firewall\/ipset\/ipfilter-net0\/[0-9a-fA-F.:%/]+$/, vmid: "instance", writeParams: [] },
  { name: "storage.content", methods: ["GET"], pattern: /^\/storage\/([^/]+)\/content$/, readParams: ["content"] },
  { name: "storage.download", methods: ["POST"], pattern: /^\/storage\/([^/]+)\/download-url$/, writeParams: ["content", "filename", "url", "checksum", "checksum-algorithm", "verify-certificates"] },
];

const DISK_KEY = /^(?:scsi|virtio|sata|ide|efidisk|tpmstate|unused)[0-9]+$/;
const NET_KEY = /^net[0-9]+$/;

export interface TaskStatus {
  status: string;
  exitstatus?: string;
}

export interface ProxmoxClientOptions {
  /** Pause between task polls. Default 1 s. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Default task timeout. */
  taskTimeoutSeconds?: number;
}

export class ProxmoxClient {
  /** VMIDs a read showed in our pool, or that this client created there. */
  private readonly inPool = new Set<number>();
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly taskTimeoutSeconds: number;

  constructor(
    readonly fence: FenceConfig,
    private readonly transport: ProxmoxTransport,
    options: ProxmoxClientOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.taskTimeoutSeconds = options.taskTimeoutSeconds ?? 1800;
  }

  isInstanceVmid(vmid: number): boolean {
    return Number.isInteger(vmid) && vmid >= this.fence.vmidRange.min && vmid <= this.fence.vmidRange.max;
  }

  static isTemplateVmid(vmid: number): boolean {
    return Number.isInteger(vmid) && vmid >= TEMPLATE_VMID_RANGE.min && vmid <= TEMPLATE_VMID_RANGE.max;
  }

  /** Record that a read showed this VM in our pool. Only pool members are ever touched. */
  notePoolMember(vmid: number): void {
    if (this.isInstanceVmid(vmid) || ProxmoxClient.isTemplateVmid(vmid)) this.inPool.add(vmid);
  }

  forgetPoolMember(vmid: number): void {
    this.inPool.delete(vmid);
  }

  /** Throws a fence error, and sends nothing, when the call is outside the fences. */
  check(call: ProxmoxCall): void {
    const { method, path, params } = call;
    let route: Route | undefined;
    let match: RegExpExecArray | null = null;
    const nodePrefix = `/nodes/${this.fence.node}`;
    if (path.startsWith("/cluster/")) {
      for (const r of CLUSTER_ROUTES) {
        match = r.pattern.exec(path);
        if (match) {
          route = r;
          break;
        }
      }
    } else if (path.startsWith(`${nodePrefix}/`)) {
      const rest = path.slice(nodePrefix.length);
      for (const r of NODE_ROUTES) {
        match = r.pattern.exec(rest);
        if (match) {
          route = r;
          break;
        }
      }
    } else if (path.startsWith("/nodes/")) {
      throw fenceRefused("a node other than PROXMOX_NODE");
    }
    if (!route || !match) throw fenceRefused("an endpoint the driver does not use");
    if (!route.methods.includes(method)) throw fenceRefused(`${method} on ${route.name}`);

    const allowed = method === "GET" ? (route.readParams ?? []) : (route.writeParams ?? []);
    for (const key of Object.keys(params)) {
      if (!allowed.includes(key)) throw fenceRefused(`parameter ${key} on ${route.name}`);
    }

    if (route.name === "task.status") {
      const node = match[1]!.split(":")[1];
      if (node !== this.fence.node) throw fenceRefused("a task on another node");
    }
    if (route.name === "cluster.resources" && params.type !== "vm") throw fenceRefused("cluster resources other than VMs");
    if (route.name === "cluster.nextid" && !this.isInstanceVmid(Number(params.vmid))) {
      throw fenceRefused("a VMID outside COMPUTE_VMID_RANGE");
    }
    if (route.name === "storage.content") {
      if (match[1] !== this.fence.importStorage) throw fenceRefused("a storage other than PROXMOX_IMPORT_STORAGE");
      if (params.content !== "import") throw fenceRefused("storage content other than import");
    }
    if (route.name === "storage.download") {
      if (match[1] !== this.fence.importStorage) throw fenceRefused("a download to a storage other than PROXMOX_IMPORT_STORAGE");
      if (params.content !== "import") throw fenceRefused("a download that is not an import image");
      if (!/^https:\/\//.test(String(params.url ?? ""))) throw fenceRefused("a download that is not https");
      if (!params.checksum || !params["checksum-algorithm"]) throw fenceRefused("a download without a checksum");
    }

    if (route.vmid) {
      const vmid = Number(match[1]);
      const isInstance = this.isInstanceVmid(vmid);
      const isTemplate = ProxmoxClient.isTemplateVmid(vmid);
      if (route.vmid === "instance" && !isInstance) throw fenceRefused("a VMID outside COMPUTE_VMID_RANGE");
      if (route.vmid === "template" && !isTemplate) throw fenceRefused("a template VMID outside 9000-9099");
      if (route.vmid === "any" && !isInstance && !isTemplate) throw fenceRefused("a VMID outside the Compute ranges");
      if (route.name === "vm.config" && method !== "GET" && !isInstance) throw fenceRefused("changing a template's config");
      if (!this.inPool.has(vmid)) throw fenceRefused("a VM that is not in PROXMOX_POOL");
    }
    if (route.name === "vm.clone") {
      const newid = Number(params.newid);
      if (!this.isInstanceVmid(newid)) throw fenceRefused("a clone outside COMPUTE_VMID_RANGE");
      if (String(params.full) !== "1") throw fenceRefused("a linked clone");
      if (params.pool === undefined || params.storage === undefined) throw fenceRefused("a clone without pool and storage");
    }
    if (route.name === "vm.create") {
      if (!ProxmoxClient.isTemplateVmid(Number(params.vmid))) throw fenceRefused("creating a VM outside 9000-9099");
      if (params.pool === undefined) throw fenceRefused("creating a VM outside PROXMOX_POOL");
    }
    if (route.name === "vm.resize" && params.disk !== "scsi0") throw fenceRefused("resizing a disk other than scsi0");

    if (method !== "GET") this.checkWriteValues(params);
  }

  private checkWriteValues(params: Params): void {
    const { pool, storage, importStorage, bridge } = this.fence;
    for (const [key, raw] of Object.entries(params)) {
      const value = String(raw);
      if (key === "pool" && value !== pool) throw fenceRefused("a pool other than PROXMOX_POOL");
      if (key === "storage" && value !== storage) throw fenceRefused("a storage other than PROXMOX_STORAGE");
      if (NET_KEY.test(key)) {
        const bridges = [...value.matchAll(/(?:^|,)bridge=([^,]+)/g)].map((m) => m[1]);
        if (bridges.length !== 1 || bridges[0] !== bridge) throw fenceRefused("a bridge other than PROXMOX_BRIDGE");
      }
      if (DISK_KEY.test(key)) {
        if (!value.startsWith(`${storage}:`)) throw fenceRefused("a disk outside PROXMOX_STORAGE");
        const source = /(?:^|,)import-from=([^,]+)/.exec(value)?.[1];
        if (source !== undefined && !new RegExp(`^${escape(importStorage)}:import/[A-Za-z0-9._-]+$`).test(source)) {
          throw fenceRefused("an import from outside PROXMOX_IMPORT_STORAGE");
        }
      }
    }
  }

  async call(method: HttpMethod, path: string, params: Params = {}): Promise<unknown> {
    const call: ProxmoxCall = { method, path, params };
    this.check(call);
    return this.transport.send(call);
  }

  get(path: string, params: Params = {}): Promise<unknown> {
    return this.call("GET", path, params);
  }

  node(path: string): string {
    return `/nodes/${this.fence.node}${path}`;
  }

  /**
   * Wait for a task the API started. A null result (a dry run, or an
   * endpoint that finished synchronously) has nothing to wait for.
   */
  async waitTask(upid: unknown, timeoutSeconds = this.taskTimeoutSeconds): Promise<void> {
    if (upid === null || upid === undefined || upid === "") return;
    if (typeof upid !== "string" || !upid.startsWith("UPID:")) {
      throw proxmoxError(PROXMOX_ERRORS.badResponse, "Proxmox returned an unexpected task id");
    }
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const status = (await this.get(this.node(`/tasks/${encodeURIComponent(upid).replace(/%3A/g, ":")}/status`))) as TaskStatus | null;
      if (status && status.status === "stopped") {
        if (status.exitstatus === "OK") return;
        // exitstatus can echo parameters: report a fixed message only.
        throw proxmoxError(PROXMOX_ERRORS.taskFailed, "A Proxmox task failed");
      }
      if (Date.now() >= deadline) throw proxmoxError(PROXMOX_ERRORS.taskTimeout, "A Proxmox task did not finish in time", true);
      await this.sleep(this.pollMs);
    }
  }

  /** Run a write that may start a task, and wait for the task. */
  async task(method: HttpMethod, path: string, params: Params = {}, timeoutSeconds?: number): Promise<void> {
    await this.waitTask(await this.call(method, path, params), timeoutSeconds);
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
