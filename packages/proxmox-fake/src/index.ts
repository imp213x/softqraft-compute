/**
 * A fake Proxmox VE 8 API for tests. It serves HTTPS with a self-signed
 * certificate generated at run time, checks the API token on every request,
 * records every call (method, path, parameters) and keeps just enough VM
 * state to answer the endpoints the Compute driver uses, with Proxmox's
 * refusals (shrinking a disk, deleting a running VM, a VMID in use, an
 * existing ipset or snapshot, a checksum mismatch on download).
 *
 * Test-only: never shipped to a host, never talks to a real Proxmox.
 */

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TestCertificate {
  key: string;
  cert: string;
  /** `AA:BB:…` SHA-256 fingerprint, as Node and `pvenode cert info` print it. */
  fingerprint: string;
}

/** A throwaway self-signed certificate for 127.0.0.1, made with openssl at run time. */
export function generateTestCertificate(): TestCertificate {
  const dir = mkdtempSync(path.join(tmpdir(), "sq-fake-pve-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
        "-days", "1", "-subj", "/CN=pve.test", "-addext", "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const key = readFileSync(path.join(dir, "key.pem"), "utf8");
    const cert = readFileSync(path.join(dir, "cert.pem"), "utf8");
    return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FakeVm {
  vmid: number;
  node: string;
  pool?: string;
  name: string;
  tags: string;
  status: "running" | "stopped";
  template: 0 | 1;
  config: Record<string, string>;
  snapshots: string[];
  firewall: Record<string, string>;
  ipsets: Map<string, string[]>;
  rules: Array<Record<string, string>>;
  /** Not listed in /cluster/resources (a VM the token cannot see). */
  hidden?: boolean;
  /** The guest ignores ACPI shutdown. */
  ignoresShutdown?: boolean;
}

export interface RecordedCall {
  method: string;
  /** Path under /api2/json, without the query string. */
  path: string;
  params: Record<string, string>;
  /** True when the token matched. */
  authorized: boolean;
}

export interface FakeProxmoxOptions {
  tokenId: string;
  tokenSecret: string;
  node: string;
  pool: string;
  storage: string;
  importStorage: string;
  /** Vendor files Proxmox can "download": URL → { algorithm: hash }. */
  vendorFiles?: Record<string, Record<string, string>>;
  certificate?: TestCertificate;
}

interface Task {
  exitstatus: string;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const WRITE = new Set(["POST", "PUT", "DELETE"]);

export class FakeProxmox {
  readonly calls: RecordedCall[] = [];
  readonly vms = new Map<number, FakeVm>();
  readonly storageContent = new Set<string>();
  readonly certificate: TestCertificate;
  /** TCP connections accepted, whether or not a request followed. */
  connections = 0;
  /** Make the next N requests answer 500. */
  failNext = 0;
  private readonly tasks = new Map<string, Task>();
  private taskCounter = 0;
  private server: https.Server | null = null;
  private port = 0;

  constructor(readonly options: FakeProxmoxOptions) {
    this.certificate = options.certificate ?? generateTestCertificate();
  }

  get url(): string {
    return `https://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = https.createServer({ key: this.certificate.key, cert: this.certificate.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.handle(req.method ?? "GET", req.url ?? "/", req.headers.authorization, Buffer.concat(chunks).toString("utf8"), res));
    });
    server.on("connection", () => {
      this.connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Calls that change something (POST, PUT, DELETE). */
  writes(): RecordedCall[] {
    return this.calls.filter((c) => WRITE.has(c.method));
  }

  /** `METHOD path` for each call, for compact assertions. Task ids read as `<upid>`. */
  summary(calls: RecordedCall[] = this.calls): string[] {
    return calls.map((c) => `${c.method} ${c.path.replace(/\/tasks\/UPID:[^/]+\/status$/, "/tasks/<upid>/status")}`);
  }

  reset(): void {
    this.calls.length = 0;
  }

  addVm(vm: Partial<FakeVm> & { vmid: number }): FakeVm {
    const full: FakeVm = {
      node: this.options.node,
      name: `vm${vm.vmid}`,
      tags: "",
      status: "stopped",
      template: 0,
      config: {},
      snapshots: [],
      firewall: {},
      ipsets: new Map(),
      rules: [],
      ...vm,
    };
    this.vms.set(full.vmid, full);
    return full;
  }

  /** A ready template in the pool, as ensureImages leaves it. */
  addTemplate(vmid: number, sizeG = 3): FakeVm {
    return this.addVm({
      vmid,
      pool: this.options.pool,
      name: `sqc-tpl-${vmid}`,
      tags: "sqc-template",
      template: 1,
      config: {
        scsi0: `${this.options.storage}:base-${vmid}-disk-0,size=${sizeG}G`,
        ide2: `${this.options.storage}:vm-${vmid}-cloudinit,media=cdrom`,
        net0: "virtio=BC:24:11:00:00:01,bridge=vmbr10,firewall=1",
        cores: "1",
        memory: "1024",
      },
    });
  }

  findByTag(tag: string): FakeVm | undefined {
    return [...this.vms.values()].find((vm) => vm.tags.split(";").includes(tag) || vm.name === tag);
  }

  private task(type: string, id: string | number, exitstatus = "OK"): string {
    this.taskCounter += 1;
    const upid = `UPID:${this.options.node}:${this.taskCounter.toString(16).padStart(8, "0")}:00000000:6703F000:${type}:${id}:${this.options.tokenId}:`;
    this.tasks.set(upid, { exitstatus });
    return upid;
  }

  private vm(vmid: string | number): FakeVm {
    const vm = this.vms.get(Number(vmid));
    if (!vm) throw new HttpFailure(500, `Configuration file 'nodes/${this.options.node}/qemu-server/${vmid}.conf' does not exist`);
    return vm;
  }

  private handle(
    method: string,
    rawUrl: string,
    authorization: string | undefined,
    body: string,
    res: import("node:http").ServerResponse,
  ): void {
    const url = new URL(rawUrl, "https://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname.replace(/^\/api2\/json/, ""));
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams) params[k] = v;
    if (body) for (const [k, v] of new URLSearchParams(body)) params[k] = v;
    const authorized = authorization === `PVEAPIToken=${this.options.tokenId}=${this.options.tokenSecret}`;
    this.calls.push({ method, path: pathname, params, authorized });
    const send = (status: number, payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json;charset=UTF-8", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (!authorized) return send(401, { data: null, message: "authentication failure" });
    if (this.failNext > 0) {
      this.failNext -= 1;
      return send(500, { data: null, message: "fake failure" });
    }
    try {
      send(200, { data: this.route(method, pathname, params) });
    } catch (err) {
      if (err instanceof HttpFailure) return send(err.status, { data: null, message: err.message });
      send(500, { data: null, message: "fake error" });
    }
  }

  private route(method: string, p: string, params: Record<string, string>): unknown {
    const { node, storage, importStorage } = this.options;
    let m: RegExpExecArray | null;
    if (method === "GET" && p === "/cluster/resources") {
      return [...this.vms.values()]
        .filter((vm) => !vm.hidden)
        .map((vm) => ({
          id: `qemu/${vm.vmid}`,
          type: "qemu",
          vmid: vm.vmid,
          node: vm.node,
          name: vm.name,
          status: vm.status,
          template: vm.template,
          ...(vm.pool ? { pool: vm.pool } : {}),
          ...(vm.tags ? { tags: vm.tags } : {}),
        }));
    }
    if (method === "GET" && p === "/cluster/nextid") {
      const vmid = Number(params.vmid);
      if (this.vms.has(vmid)) throw new HttpFailure(400, `VM ${vmid} already exists`);
      return String(vmid);
    }
    if (!p.startsWith(`/nodes/${node}/`)) throw new HttpFailure(501, "no such node in the fake");
    const rest = p.slice(`/nodes/${node}`.length);

    if (method === "GET" && (m = /^\/tasks\/(UPID:[^/]+)\/status$/.exec(rest))) {
      const task = this.tasks.get(m[1]!);
      if (!task) throw new HttpFailure(500, "no such task");
      return { status: "stopped", exitstatus: task.exitstatus, upid: m[1] };
    }
    if (method === "POST" && rest === "/qemu") {
      const vmid = Number(params.vmid);
      if (this.vms.has(vmid)) throw new HttpFailure(500, `VM ${vmid} already exists`);
      const source = /import-from=([^,]+)/.exec(params.scsi0 ?? "")?.[1];
      if (source && !this.storageContent.has(source)) return this.task("qmcreate", vmid, "import source missing");
      const { vmid: _v, pool, name, tags, ...config } = params;
      config.scsi0 = `${storage}:vm-${vmid}-disk-0,size=2G`;
      this.addVm({ vmid, pool, name: name ?? `vm${vmid}`, tags: tags ?? "", config });
      return this.task("qmcreate", vmid);
    }
    if ((m = /^\/qemu\/([0-9]+)\/template$/.exec(rest)) && method === "POST") {
      const vm = this.vm(m[1]!);
      vm.template = 1;
      return this.task("qmtemplate", vm.vmid);
    }
    if ((m = /^\/qemu\/([0-9]+)\/clone$/.exec(rest)) && method === "POST") {
      const source = this.vm(m[1]!);
      const newid = Number(params.newid);
      if (this.vms.has(newid)) throw new HttpFailure(500, `VM ${newid} already exists`);
      const size = /size=([^,]+)/.exec(source.config.scsi0 ?? "")?.[1] ?? "3G";
      this.addVm({
        vmid: newid,
        pool: params.pool,
        name: params.name ?? `vm${newid}`,
        config: {
          ...source.config,
          scsi0: `${params.storage}:vm-${newid}-disk-0,size=${size}`,
          ...(params.description ? { description: params.description } : {}),
        },
      });
      return this.task("qmclone", source.vmid);
    }
    if ((m = /^\/qemu\/([0-9]+)\/config$/.exec(rest))) {
      const vm = this.vm(m[1]!);
      if (method === "GET") return { ...vm.config, name: vm.name, ...(vm.tags ? { tags: vm.tags } : {}) };
      if (method === "PUT") {
        if (params.scsi0 !== undefined) {
          // Only the disk's options may change here: the volume must be the one attached.
          const volume = (spec: string | undefined) => (spec ?? "").split(",")[0];
          if (volume(params.scsi0) !== volume(vm.config.scsi0)) throw new HttpFailure(500, "scsi0: volume does not match");
          for (const option of params.scsi0.split(",").slice(1)) {
            const [key, value] = option.split("=");
            if (/^(?:mbps|iops)_(?:rd|wr)$/.test(key ?? "") && !/^[0-9]+$/.test(value ?? "")) {
              throw new HttpFailure(400, `scsi0: invalid ${key}`);
            }
          }
        }
        if (params.onboot !== undefined && params.onboot !== "0" && params.onboot !== "1") {
          throw new HttpFailure(400, "onboot: invalid boolean");
        }
        for (const [k, v] of Object.entries(params)) {
          if (k === "name") vm.name = v;
          else if (k === "tags") vm.tags = v;
          else vm.config[k] = v;
        }
        return null;
      }
    }
    if ((m = /^\/qemu\/([0-9]+)\/status\/current$/.exec(rest)) && method === "GET") {
      const vm = this.vm(m[1]!);
      return { vmid: vm.vmid, status: vm.status, name: vm.name };
    }
    if ((m = /^\/qemu\/([0-9]+)\/status\/(start|stop|shutdown)$/.exec(rest)) && method === "POST") {
      const vm = this.vm(m[1]!);
      if (vm.template) throw new HttpFailure(500, "you can't start a vm if it's a template");
      if (m[2] === "start") vm.status = "running";
      else if (m[2] === "stop") vm.status = "stopped";
      else if (vm.ignoresShutdown) return this.task("qmshutdown", vm.vmid, "VM quit/powerdown failed");
      else vm.status = "stopped";
      return this.task(`qm${m[2]}`, vm.vmid);
    }
    if ((m = /^\/qemu\/([0-9]+)$/.exec(rest)) && method === "DELETE") {
      const vm = this.vm(m[1]!);
      if (vm.status === "running") return this.task("qmdestroy", vm.vmid, "VM is running - destroy failed");
      this.vms.delete(vm.vmid);
      return this.task("qmdestroy", vm.vmid);
    }
    if ((m = /^\/qemu\/([0-9]+)\/resize$/.exec(rest)) && method === "PUT") {
      const vm = this.vm(m[1]!);
      const disk = params.disk ?? "";
      const current = vm.config[disk];
      if (!current) throw new HttpFailure(500, "disk does not exist");
      const now = Number(/size=([0-9]+)G/.exec(current)?.[1] ?? 0);
      const want = Number(/^([0-9]+)G$/.exec(params.size ?? "")?.[1] ?? Number.NaN);
      if (!Number.isFinite(want)) throw new HttpFailure(400, "invalid size");
      if (want < now) throw new HttpFailure(500, "shrinking disks is not supported");
      vm.config[disk] = current.replace(/size=[^,]+/, `size=${want}G`);
      return this.task("resize", vm.vmid);
    }
    if ((m = /^\/qemu\/([0-9]+)\/snapshot$/.exec(rest))) {
      const vm = this.vm(m[1]!);
      if (method === "GET") {
        return [...vm.snapshots.map((name) => ({ name, description: "" })), { name: "current", description: "You are here!" }];
      }
      if (method === "POST") {
        const name = params.snapname ?? "";
        if (vm.snapshots.includes(name)) return this.task("qmsnapshot", vm.vmid, `snapshot name '${name}' already used`);
        vm.snapshots.push(name);
        return this.task("qmsnapshot", vm.vmid);
      }
    }
    if ((m = /^\/qemu\/([0-9]+)\/snapshot\/([^/]+)$/.exec(rest)) && method === "DELETE") {
      const vm = this.vm(m[1]!);
      if (!vm.snapshots.includes(m[2]!)) return this.task("qmdelsnapshot", vm.vmid, "snapshot does not exist");
      vm.snapshots = vm.snapshots.filter((s) => s !== m![2]);
      return this.task("qmdelsnapshot", vm.vmid);
    }
    if ((m = /^\/qemu\/([0-9]+)\/firewall\/options$/.exec(rest))) {
      const vm = this.vm(m[1]!);
      if (method === "GET") return { ...vm.firewall };
      if (method === "PUT") {
        Object.assign(vm.firewall, params);
        return null;
      }
    }
    if ((m = /^\/qemu\/([0-9]+)\/firewall\/rules$/.exec(rest))) {
      const vm = this.vm(m[1]!);
      if (method === "GET") return vm.rules.map((r, pos) => ({ pos, ...r }));
      if (method === "POST") {
        vm.rules.unshift({ ...params });
        return null;
      }
    }
    if ((m = /^\/qemu\/([0-9]+)\/firewall\/ipset$/.exec(rest))) {
      const vm = this.vm(m[1]!);
      if (method === "GET") return [...vm.ipsets.keys()].map((name) => ({ name }));
      if (method === "POST") {
        if (vm.ipsets.has(params.name ?? "")) throw new HttpFailure(500, "create ipset failed: ipset already exists");
        vm.ipsets.set(params.name ?? "", []);
        return null;
      }
    }
    if ((m = /^\/qemu\/([0-9]+)\/firewall\/ipset\/([^/]+)$/.exec(rest))) {
      const vm = this.vm(m[1]!);
      const set = vm.ipsets.get(m[2]!);
      if (!set) throw new HttpFailure(500, "no such IPSet");
      if (method === "GET") return set.map((cidr) => ({ cidr }));
      if (method === "POST") {
        if (set.includes(params.cidr ?? "")) throw new HttpFailure(500, "entry already exists");
        set.push(params.cidr ?? "");
        return null;
      }
    }
    if ((m = /^\/qemu\/([0-9]+)\/firewall\/ipset\/([^/]+)\/(.+)$/.exec(rest)) && method === "DELETE") {
      const vm = this.vm(m[1]!);
      const set = vm.ipsets.get(m[2]!);
      if (!set || !set.includes(m[3]!)) throw new HttpFailure(500, "no such entry");
      vm.ipsets.set(m[2]!, set.filter((c) => c !== m![3]));
      return null;
    }
    if ((m = /^\/storage\/([^/]+)\/content$/.exec(rest)) && method === "GET") {
      if (m[1] !== importStorage) throw new HttpFailure(500, "storage does not exist in the fake");
      return [...this.storageContent].filter((v) => v.startsWith(`${m![1]}:`)).map((volid) => ({ volid, content: "import" }));
    }
    if ((m = /^\/storage\/([^/]+)\/download-url$/.exec(rest)) && method === "POST") {
      const known = this.options.vendorFiles?.[params.url ?? ""];
      const expected = known?.[params["checksum-algorithm"] ?? ""];
      if (!known || expected !== params.checksum) return this.task("download", m[1]!, "checksum mismatch");
      this.storageContent.add(`${m[1]}:import/${params.filename}`);
      return this.task("download", m[1]!);
    }
    throw new HttpFailure(501, `Method '${method} ${p}' not implemented`);
  }
}
