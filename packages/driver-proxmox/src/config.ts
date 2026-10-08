/**
 * Proxmox driver configuration, read from env and validated with zod.
 *
 * The fences (VMID range, pool, storage, bridge) are configuration, and the
 * client checks every call against them before it is sent. Error messages
 * name variables, never values, so a token secret can never reach a log.
 */

import { z } from "zod";

/** Template VMIDs live here, apart from instance VMIDs. */
export const TEMPLATE_VMID_RANGE = Object.freeze({ min: 9000, max: 9099 });
export const DEFAULT_VMID_RANGE = "2000-2999";
export const DEFAULT_BRIDGE = "vmbr10";
export const DEFAULT_URL = "https://127.0.0.1:8006";

/**
 * Per-VM disk limits (founder decision F7), applied to every pilot VM's
 * disk for reads and writes separately. The upper bounds keep the setting a
 * real cap: sq-node-01's pilot pool shares one NVMe RAID 1 mirror with
 * production, and a single VM allowed more than about 1 GB/s or 50,000 IOPS
 * could take a large share of that mirror from VMs 101-103.
 */
export const DISK_LIMIT_BOUNDS = Object.freeze({
  mbps: { min: 1, max: 1000, fallback: 100 },
  iops: { min: 10, max: 50_000, fallback: 2000 },
});

/** Proxmox ids for pools, storages and nodes: letters, digits, `-`, `_`, `.`. */
const PVE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
/** `user@realm!tokenname`. */
const TOKEN_ID = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]*$/;
/** Proxmox prints token secrets as UUIDs. */
const TOKEN_SECRET = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FINGERPRINT = /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{64}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class ProxmoxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxmoxConfigError";
  }
}

export interface ProxmoxConfig {
  /** `https://<loopback>:<port>`, no path. */
  url: string;
  node: string;
  tokenId: string;
  tokenSecret: string;
  /** Upper-case, colon-separated SHA-256 fingerprint of the API certificate. */
  tlsFingerprint: string;
  pool: string;
  /** The only storage VM disks and cloud-init drives may use. */
  storage: string;
  /** File storage for vendor image downloads (`import` content), used only by ensureImages. */
  importStorage: string;
  bridge: string;
  vmidRange: { min: number; max: number };
  nameservers: string[];
  /** Cloud-init default user. */
  ciUser: string;
  /** How long a graceful shutdown may take before the VM is stopped. */
  shutdownTimeoutSeconds: number;
  /** How long to wait for a Proxmox task (clone, download, start, …). */
  taskTimeoutSeconds: number;
  /** Disk limits set on every VM's `scsi0`: MB/s and operations per second, each for reads and for writes. */
  diskLimits: { mbps: number; iops: number };
}

const limit = (name: string, bounds: { min: number; max: number; fallback: number }) =>
  z
    .string()
    .regex(/^[0-9]+$/, `${name} must be a whole number from ${bounds.min} to ${bounds.max}`)
    .default(String(bounds.fallback))
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(bounds.min, `${name} must be a whole number from ${bounds.min} to ${bounds.max}`)
        .max(bounds.max, `${name} must be a whole number from ${bounds.min} to ${bounds.max}`),
    );

const Env = z.object({
  PROXMOX_URL: z.string().default(DEFAULT_URL),
  PROXMOX_NODE: z.string().regex(PVE_ID, "PROXMOX_NODE must be a Proxmox node name"),
  PROXMOX_TOKEN_ID: z.string().regex(TOKEN_ID, "PROXMOX_TOKEN_ID must look like user@realm!name"),
  PROXMOX_TOKEN_SECRET: z.string().regex(TOKEN_SECRET, "PROXMOX_TOKEN_SECRET is not a Proxmox token secret"),
  PROXMOX_TLS_FINGERPRINT: z
    .string()
    .regex(FINGERPRINT, "PROXMOX_TLS_FINGERPRINT must be a SHA-256 fingerprint (64 hex digits, colons optional)"),
  PROXMOX_POOL: z.string().regex(PVE_ID, "PROXMOX_POOL must be a Proxmox pool id"),
  PROXMOX_STORAGE: z.string().regex(PVE_ID, "PROXMOX_STORAGE must be a Proxmox storage id"),
  PROXMOX_IMPORT_STORAGE: z.string().regex(PVE_ID, "PROXMOX_IMPORT_STORAGE must be a Proxmox storage id").default("local"),
  PROXMOX_BRIDGE: z.string().regex(/^vmbr[0-9]{1,4}$/, "PROXMOX_BRIDGE must be a vmbrN bridge").default(DEFAULT_BRIDGE),
  COMPUTE_VMID_RANGE: z.string().default(DEFAULT_VMID_RANGE),
  PROXMOX_NAMESERVERS: z.string().default("1.1.1.1 9.9.9.9"),
  PROXMOX_CI_USER: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, "PROXMOX_CI_USER must be a Linux user name").default("sq"),
  PROXMOX_SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  PROXMOX_TASK_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(7200).default(1800),
  COMPUTE_VM_DISK_MBPS: limit("COMPUTE_VM_DISK_MBPS", DISK_LIMIT_BOUNDS.mbps),
  COMPUTE_VM_DISK_IOPS: limit("COMPUTE_VM_DISK_IOPS", DISK_LIMIT_BOUNDS.iops),
});

/** Normalise a fingerprint to `AA:BB:…`, the form Node reports. */
export function normaliseFingerprint(value: string): string {
  const hex = value.replace(/:/g, "").toUpperCase();
  return hex.match(/.{2}/g)!.join(":");
}

export function parseVmidRange(value: string): { min: number; max: number } {
  const match = /^([0-9]{3,9})-([0-9]{3,9})$/.exec(value.trim());
  if (!match) throw new ProxmoxConfigError("COMPUTE_VMID_RANGE must look like 2000-2999");
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (min < 100 || max < min) throw new ProxmoxConfigError("COMPUTE_VMID_RANGE must be ascending and start at 100 or more");
  if (min <= TEMPLATE_VMID_RANGE.max && max >= TEMPLATE_VMID_RANGE.min) {
    throw new ProxmoxConfigError("COMPUTE_VMID_RANGE must not overlap the template range 9000-9099");
  }
  return { min, max };
}

function parseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProxmoxConfigError("PROXMOX_URL is not a URL");
  }
  if (url.protocol !== "https:") throw new ProxmoxConfigError("PROXMOX_URL must be https");
  if (!LOOPBACK.has(url.hostname)) {
    throw new ProxmoxConfigError("PROXMOX_URL must point at the local API (127.0.0.1)");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ProxmoxConfigError("PROXMOX_URL must be scheme, host and port only");
  }
  return `https://${url.host}`;
}

function parseNameservers(value: string): string[] {
  const list = value.split(/[\s,]+/).filter(Boolean);
  const ipv4 = z.string().ip({ version: "v4" });
  if (list.length === 0 || list.length > 3 || !list.every((ns) => ipv4.safeParse(ns).success)) {
    throw new ProxmoxConfigError("PROXMOX_NAMESERVERS must be one to three IPv4 addresses");
  }
  return list;
}

export function loadProxmoxConfig(env: Record<string, string | undefined>): ProxmoxConfig {
  // Blank values count as unset, so a copied env example with empty lines takes the defaults.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = Env.safeParse(set);
  if (!parsed.success) {
    // Name the variables only: never echo a value.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].sort();
    const messages = parsed.error.issues
      .filter((i) => i.code !== "invalid_type")
      .map((i) => i.message)
      .filter((m, idx, all) => all.indexOf(m) === idx);
    throw new ProxmoxConfigError(
      `Invalid Proxmox configuration: ${names.join(", ")}${messages.length ? ` (${messages.join("; ")})` : ""}`,
    );
  }
  const e = parsed.data;
  if (e.PROXMOX_STORAGE === e.PROXMOX_IMPORT_STORAGE) {
    throw new ProxmoxConfigError("PROXMOX_IMPORT_STORAGE must differ from PROXMOX_STORAGE");
  }
  return {
    url: parseUrl(e.PROXMOX_URL),
    node: e.PROXMOX_NODE,
    tokenId: e.PROXMOX_TOKEN_ID,
    tokenSecret: e.PROXMOX_TOKEN_SECRET,
    tlsFingerprint: normaliseFingerprint(e.PROXMOX_TLS_FINGERPRINT),
    pool: e.PROXMOX_POOL,
    storage: e.PROXMOX_STORAGE,
    importStorage: e.PROXMOX_IMPORT_STORAGE,
    bridge: e.PROXMOX_BRIDGE,
    vmidRange: parseVmidRange(e.COMPUTE_VMID_RANGE),
    nameservers: parseNameservers(e.PROXMOX_NAMESERVERS),
    ciUser: e.PROXMOX_CI_USER,
    shutdownTimeoutSeconds: e.PROXMOX_SHUTDOWN_TIMEOUT_SECONDS,
    taskTimeoutSeconds: e.PROXMOX_TASK_TIMEOUT_SECONDS,
    diskLimits: { mbps: e.COMPUTE_VM_DISK_MBPS, iops: e.COMPUTE_VM_DISK_IOPS },
  };
}
