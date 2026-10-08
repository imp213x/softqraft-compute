/**
 * Agent configuration from `/etc/softqraft/compute-agent.env`, validated
 * with zod. The Proxmox part is validated by the driver package from the
 * same values. Error messages name variables, never values.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { HostName } from "@softqraft/compute-contracts";

export const DEFAULT_ENV_FILE = "/etc/softqraft/compute-agent.env";
export const DEFAULT_STATE_DIR = "/var/lib/softqraft-compute-agent";
export const DEFAULT_GUARD_FILE = "/run/softqraft-compute-agent/iptables-forward.rules";
/** The API's job lease. Heartbeats must come well inside it. */
export const JOB_LEASE_SECONDS = 120;
export const ENROLMENT_TOKEN_KEY = "COMPUTE_ENROLMENT_TOKEN";

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

const bool = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"], { message: "must be true or false" })
    .default(fallback)
    .transform((v) => v === "true");

const seconds = (fallback: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(fallback);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const Env = z.object({
  COMPUTE_API_URL: z.string().min(1),
  COMPUTE_HOST_NAME: HostName,
  COMPUTE_ENROLMENT_TOKEN: z.string().optional(),
  COMPUTE_HOST_CAPACITY_VCPU: z.coerce.number().int().min(1).max(1024).default(4),
  COMPUTE_HOST_CAPACITY_MEMORY_MB: z.coerce.number().int().min(512).max(16 * 1024 * 1024).default(8192),
  COMPUTE_HOST_CAPACITY_DISK_GB: z.coerce.number().int().min(1).max(1024 * 1024).default(120),
  COMPUTE_AGENT_STATE_DIR: z.string().startsWith("/").default(DEFAULT_STATE_DIR),
  COMPUTE_AGENT_DRY_RUN: bool("false"),
  COMPUTE_AGENT_ENSURE_IMAGES: bool("true"),
  COMPUTE_AGENT_NETWORK_GUARD_FILE: z.string().startsWith("/").default(DEFAULT_GUARD_FILE),
  COMPUTE_PILOT_CIDR: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/).default("10.30.0.0/24"),
  COMPUTE_PRODUCTION_CIDR: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/).default("10.20.0.0/24"),
  PROXMOX_BRIDGE: z.string().default("vmbr10"),
  COMPUTE_PRODUCTION_BRIDGE: z.string().regex(/^vmbr[0-9]{1,4}$/).default("vmbr0"),
  COMPUTE_AGENT_POLL_SECONDS: seconds(5, 0.01, 300),
  COMPUTE_AGENT_HEARTBEAT_SECONDS: seconds(30, 0.01, JOB_LEASE_SECONDS / 2),
  COMPUTE_AGENT_USAGE_SECONDS: seconds(60, 0.01, 3600),
  COMPUTE_AGENT_BACKOFF_MAX_SECONDS: seconds(60, 0.01, 600),
  COMPUTE_AGENT_SHUTDOWN_GRACE_SECONDS: seconds(90, 0, 600),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export interface AgentConfig {
  apiUrl: string;
  hostName: string;
  enrolmentToken: string | null;
  capacity: { vcpu: number; memoryMb: number; diskGb: number };
  stateDir: string;
  dryRun: boolean;
  ensureImages: boolean;
  guardFile: string;
  pilotCidr: string;
  productionCidr: string;
  bridge: string;
  productionBridge: string;
  pollMs: number;
  heartbeatMs: number;
  usageMs: number;
  backoffMaxMs: number;
  shutdownGraceMs: number;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

function parseApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentConfigError("COMPUTE_API_URL is not a URL");
  }
  // Plain http only to a local API (tests and local runs).
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new AgentConfigError("COMPUTE_API_URL must be https");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new AgentConfigError("COMPUTE_API_URL must be scheme, host and port only");
  }
  return `${url.protocol}//${url.host}`;
}

/** Blank values count as unset, so a copied env example with empty lines takes the defaults. */
export function withoutBlank(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== ""),
  );
}

export function loadAgentConfig(env: Record<string, string | undefined>): AgentConfig {
  const parsed = Env.safeParse(withoutBlank(env));
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].sort();
    throw new AgentConfigError(`Invalid agent configuration: ${names.join(", ")}`);
  }
  const e = parsed.data;
  const token = e.COMPUTE_ENROLMENT_TOKEN?.trim() || null;
  return {
    apiUrl: parseApiUrl(e.COMPUTE_API_URL),
    hostName: e.COMPUTE_HOST_NAME,
    enrolmentToken: token,
    capacity: {
      vcpu: e.COMPUTE_HOST_CAPACITY_VCPU,
      memoryMb: e.COMPUTE_HOST_CAPACITY_MEMORY_MB,
      diskGb: e.COMPUTE_HOST_CAPACITY_DISK_GB,
    },
    stateDir: e.COMPUTE_AGENT_STATE_DIR,
    dryRun: e.COMPUTE_AGENT_DRY_RUN,
    ensureImages: e.COMPUTE_AGENT_ENSURE_IMAGES,
    guardFile: e.COMPUTE_AGENT_NETWORK_GUARD_FILE,
    pilotCidr: e.COMPUTE_PILOT_CIDR,
    productionCidr: e.COMPUTE_PRODUCTION_CIDR,
    bridge: e.PROXMOX_BRIDGE,
    productionBridge: e.COMPUTE_PRODUCTION_BRIDGE,
    pollMs: e.COMPUTE_AGENT_POLL_SECONDS * 1000,
    heartbeatMs: e.COMPUTE_AGENT_HEARTBEAT_SECONDS * 1000,
    usageMs: e.COMPUTE_AGENT_USAGE_SECONDS * 1000,
    backoffMaxMs: e.COMPUTE_AGENT_BACKOFF_MAX_SECONDS * 1000,
    shutdownGraceMs: e.COMPUTE_AGENT_SHUTDOWN_GRACE_SECONDS * 1000,
    logLevel: e.LOG_LEVEL,
  };
}

/** Parse `KEY=value` lines. `#` comments and blank lines are skipped; one level of quotes is removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new AgentConfigError(`Cannot read the agent env file ${path}`);
  }
  return parseEnvFile(text);
}

/**
 * Blank the one-time enrolment token in the env file, in place (the file
 * keeps its owner and mode). Returns true when the file no longer holds a
 * token, including when it was already blank. Returns false when the token is
 * still there because the file cannot be read or written, so the caller tells
 * the operator to remove it.
 */
export function wipeEnrolmentToken(path: string): boolean {
  try {
    const text = readFileSync(path, "utf8");
    const next = text
      .split(/(\r?\n)/)
      .map((part) => (/^\s*(?:export\s+)?COMPUTE_ENROLMENT_TOKEN\s*=/.test(part) ? `${ENROLMENT_TOKEN_KEY}=` : part))
      .join("");
    if (next !== text) writeFileSync(path, next);
    return true;
  } catch {
    return false;
  }
}
