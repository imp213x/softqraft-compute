/**
 * Configuration from the environment, parsed with zod. Bad configuration
 * fails at startup with a message that names the variable and never echoes
 * a secret value.
 */

import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { parsePublicKeys } from "@softqraft/federation";
import { DEFAULT_DISK_GB, INSTANCE_LIMITS } from "@softqraft/compute-contracts";
import { loadSigningKey } from "@softqraft/compute-jobs";
import { assertPilotCidr, type Ipv4Cidr } from "./modules/ipam/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const bool = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"], { message: "must be true or false" })
    .default(fallback)
    .transform((v) => v === "true");

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .default(String(fallback))
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8080, 1, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  COMPUTE_PUBLIC_URL: z.string().optional(),
  COMPUTE_COOKIE_SECURE: z.enum(["true", "false"], { message: "must be true or false" }).optional(),
  COMPUTE_TRUSTED_PROXY_CIDRS: z.string().default(""),

  COMPUTE_STORE: z.enum(["postgres", "memory"]).default("postgres"),
  DATABASE_URL: z.string().optional(),

  COMPUTE_POOL_MAX_VCPU: int(4, 1, 1024),
  COMPUTE_POOL_MAX_MEMORY_MB: int(8192, 512, 16 * 1024 * 1024),
  COMPUTE_POOL_MAX_INSTANCES: int(3, 1, 10000),
  COMPUTE_POOL_MAX_DISK_GB: int(120, 10, 1024 * 1024),
  COMPUTE_ALLOWED_PROJECTS: z.string().default(""),
  COMPUTE_PILOT_CIDR: z.string().default("10.30.0.0/24"),
  COMPUTE_DEFAULT_DISK_GB: int(DEFAULT_DISK_GB, INSTANCE_LIMITS.diskGb.min, INSTANCE_LIMITS.diskGb.max),
  COMPUTE_REGION_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a lowercase region id such as eu-central")
    .default("eu-central"),
  COMPUTE_CONSOLE_WAIT_SECONDS: int(15, 1, 60),

  COMPUTE_JOB_SIGNING_KEY_PEM: z.string().optional(),
  COMPUTE_JOB_SIGNING_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, "must be 1-64 characters of A-Z a-z 0-9 . _ -")
    .default("job-1"),
  COMPUTE_JOB_MAX_ATTEMPTS: int(3, 1, 10),
  COMPUTE_JOB_LEASE_SECONDS: int(120, 10, 3600),
  COMPUTE_JOB_ENVELOPE_TTL_SECONDS: int(300, 30, 3600),
  COMPUTE_MAINTENANCE_INTERVAL_SECONDS: int(15, 1, 3600),

  CLOUD_FEDERATION_ENABLED: bool("false"),
  CLOUD_FEDERATION_PUBLIC_KEYS: z.string().optional(),
  CLOUD_OPERATOR_LAUNCH_ENABLED: bool("false"),
});

export interface PoolCaps {
  maxVcpu: number;
  maxMemoryMb: number;
  maxInstances: number;
  maxDiskGb: number;
}

export interface ComputeConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  /** This service's public origin, e.g. `https://compute.softqraftlabs.com`; null for local runs. */
  publicUrl: string | null;
  /** Session cookies carry `Secure`. Defaults to true when publicUrl is https. */
  cookieSecure: boolean;
  /** Proxies whose X-Forwarded-For is trusted (Fastify trustProxy); empty trusts none. */
  trustedProxies: string[];
  store: "postgres" | "memory";
  databaseUrl: string | undefined;
  pool: PoolCaps;
  allowedProjects: ReadonlySet<string>;
  pilotCidr: Ipv4Cidr;
  /** Used when a create request leaves `diskGb` out. */
  defaultDiskGb: number;
  /** The one region this Compute deployment serves (§3.1 `regionId`). */
  regionId: string;
  /** How long `POST …/console` waits for the host agent's ticket. */
  consoleWaitSeconds: number;
  jobSigning: { keyId: string; privateKey: KeyObject };
  jobMaxAttempts: number;
  jobLeaseSeconds: number;
  jobEnvelopeTtlSeconds: number;
  maintenanceIntervalSeconds: number;
  federation:
    | { enabled: false; operatorLaunch: false }
    | { enabled: true; publicKeys: Map<string, KeyObject>; operatorLaunch: boolean };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseAllowedProjects(raw: string): Set<string> {
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new ConfigError("COMPUTE_ALLOWED_PROJECTS must be a comma-separated list of project UUIDs");
    }
  }
  return new Set(ids);
}

function parsePublicUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("COMPUTE_PUBLIC_URL must be an http or https origin such as https://compute.example.com");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new ConfigError("COMPUTE_PUBLIC_URL must be an http or https origin such as https://compute.example.com");
  }
  return url.origin;
}

/** No public URL (the local listener), or plain http on localhost or 127.0.0.1. */
function isLocalDevelopmentUrl(publicUrl: string | null): boolean {
  if (publicUrl === null) return true;
  const url = new URL(publicUrl);
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

const PROXY_RE = /^[0-9A-Fa-f:.]+(?:\/\d{1,3})?$/;

function parseTrustedProxies(raw: string): string[] {
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of list) {
    if (!PROXY_RE.test(entry)) throw new ConfigError("COMPUTE_TRUSTED_PROXY_CIDRS must be a comma-separated list of IP addresses or CIDRs");
  }
  return list;
}

/** Parse and validate the environment. Throws ConfigError on the first problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ComputeConfig {
  // Treat empty strings as unset, as .env files often leave them blank.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ConfigError(`${issue.path.join(".")} ${issue.message}`);
  }
  const e = parsed.data;

  if (e.COMPUTE_STORE === "postgres" && !e.DATABASE_URL) {
    throw new ConfigError("DATABASE_URL is required when COMPUTE_STORE=postgres");
  }
  if (e.COMPUTE_STORE === "memory" && e.NODE_ENV === "production") {
    throw new ConfigError("COMPUTE_STORE=memory is not allowed when NODE_ENV=production");
  }

  let pilotCidr: Ipv4Cidr;
  try {
    pilotCidr = assertPilotCidr(e.COMPUTE_PILOT_CIDR);
  } catch (err) {
    throw new ConfigError(
      err instanceof Error && err.message.startsWith("COMPUTE_PILOT_CIDR")
        ? err.message
        : `COMPUTE_PILOT_CIDR ${(err as Error).message}`,
    );
  }

  if (!e.COMPUTE_JOB_SIGNING_KEY_PEM) {
    throw new ConfigError("COMPUTE_JOB_SIGNING_KEY_PEM is required (an Ed25519 PKCS#8 PEM)");
  }
  let privateKey: KeyObject;
  try {
    privateKey = loadSigningKey(e.COMPUTE_JOB_SIGNING_KEY_PEM);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }

  let federation: ComputeConfig["federation"] = { enabled: false, operatorLaunch: false };
  if (e.CLOUD_FEDERATION_ENABLED) {
    if (!e.CLOUD_FEDERATION_PUBLIC_KEYS) {
      throw new ConfigError("CLOUD_FEDERATION_PUBLIC_KEYS is required when CLOUD_FEDERATION_ENABLED=true");
    }
    try {
      federation = {
        enabled: true,
        publicKeys: parsePublicKeys(e.CLOUD_FEDERATION_PUBLIC_KEYS),
        // Operator launch (§8) exists only on top of federation, as in Media.
        operatorLaunch: e.CLOUD_OPERATOR_LAUNCH_ENABLED,
      };
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  }

  const publicUrl = parsePublicUrl(e.COMPUTE_PUBLIC_URL);
  if (e.NODE_ENV === "production" && federation.enabled && (!publicUrl || !publicUrl.startsWith("https://"))) {
    throw new ConfigError("COMPUTE_PUBLIC_URL must be an https origin when NODE_ENV=production and federation is on");
  }
  const cookieSecure =
    e.COMPUTE_COOKIE_SECURE !== undefined ? e.COMPUTE_COOKIE_SECURE === "true" : Boolean(publicUrl?.startsWith("https://"));
  // Session cookies may lose `Secure` only for local development: no public
  // URL (the local listener) or plain http on localhost or 127.0.0.1.
  if (e.COMPUTE_COOKIE_SECURE === "false" && !isLocalDevelopmentUrl(publicUrl)) {
    throw new ConfigError(
      "COMPUTE_COOKIE_SECURE=false is allowed only with a local development COMPUTE_PUBLIC_URL (http://localhost or http://127.0.0.1)",
    );
  }

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    publicUrl,
    cookieSecure,
    trustedProxies: parseTrustedProxies(e.COMPUTE_TRUSTED_PROXY_CIDRS),
    store: e.COMPUTE_STORE,
    databaseUrl: e.DATABASE_URL,
    pool: {
      maxVcpu: e.COMPUTE_POOL_MAX_VCPU,
      maxMemoryMb: e.COMPUTE_POOL_MAX_MEMORY_MB,
      maxInstances: e.COMPUTE_POOL_MAX_INSTANCES,
      maxDiskGb: e.COMPUTE_POOL_MAX_DISK_GB,
    },
    allowedProjects: parseAllowedProjects(e.COMPUTE_ALLOWED_PROJECTS),
    pilotCidr,
    defaultDiskGb: e.COMPUTE_DEFAULT_DISK_GB,
    regionId: e.COMPUTE_REGION_ID,
    consoleWaitSeconds: e.COMPUTE_CONSOLE_WAIT_SECONDS,
    jobSigning: { keyId: e.COMPUTE_JOB_SIGNING_KEY_ID, privateKey },
    jobMaxAttempts: e.COMPUTE_JOB_MAX_ATTEMPTS,
    jobLeaseSeconds: e.COMPUTE_JOB_LEASE_SECONDS,
    jobEnvelopeTtlSeconds: e.COMPUTE_JOB_ENVELOPE_TTL_SECONDS,
    maintenanceIntervalSeconds: e.COMPUTE_MAINTENANCE_INTERVAL_SECONDS,
    federation,
  };
}
