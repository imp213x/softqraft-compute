/**
 * Shared setup for the driver tests: a fake Proxmox with the pilot's pool,
 * storage and bridge, and a driver pointed at it over pinned TLS.
 * Every key and certificate is generated at run time.
 */

import { randomUUID } from "node:crypto";
import { FakeProxmox, type TestCertificate } from "@softqraft/compute-proxmox-fake";
import { loadProxmoxConfig, type ProxmoxConfig } from "./config.js";
import { buildProxmoxDriver, type BuildProxmoxDriverOptions } from "./index.js";
import type { ProxmoxDriver } from "./driver.js";

export const NODE = "sq-node-01";
export const POOL = "compute-pilot";
export const STORAGE = "compute-pilot";
export const IMPORT_STORAGE = "local";
export const TOKEN_ID = "compute-agent@pve!agent";

export interface Setup {
  pve: FakeProxmox;
  config: ProxmoxConfig;
  driver: ProxmoxDriver;
  env: Record<string, string>;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function setup(
  options: BuildProxmoxDriverOptions & {
    certificate?: TestCertificate;
    env?: Record<string, string>;
    vendorFiles?: Record<string, Record<string, string>>;
    /** False models a token whose role lacks Pool.Audit. Default true. */
    poolAudit?: boolean;
  } = {},
): Promise<Setup> {
  const secret = randomUUID();
  const pve = new FakeProxmox({
    tokenId: TOKEN_ID,
    tokenSecret: secret,
    node: NODE,
    pool: POOL,
    storage: STORAGE,
    importStorage: IMPORT_STORAGE,
    vendorFiles: options.vendorFiles,
    certificate: options.certificate,
    poolAudit: options.poolAudit,
  });
  await pve.start();
  const env: Record<string, string> = {
    PROXMOX_URL: pve.url,
    PROXMOX_NODE: NODE,
    PROXMOX_TOKEN_ID: TOKEN_ID,
    PROXMOX_TOKEN_SECRET: secret,
    PROXMOX_TLS_FINGERPRINT: pve.certificate.fingerprint,
    PROXMOX_POOL: POOL,
    PROXMOX_STORAGE: STORAGE,
    PROXMOX_IMPORT_STORAGE: IMPORT_STORAGE,
    ...options.env,
  };
  const config = loadProxmoxConfig(env);
  const logs: Setup["logs"] = [];
  const driver = buildProxmoxDriver(config, {
    pollMs: 1,
    // Tests never reach a vendor: a test that needs checksum lists passes its own.
    fetchText: async () => {
      throw new Error("no network in tests");
    },
    log: (event, fields) => logs.push({ event, fields }),
    ...options,
  });
  return { pve, config, driver, env, logs, close: () => pve.stop() };
}

export const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4Kp0Tj9nJ7mTq8z3mQxPzv8yq9V2Jm9b0Zb8t7L3Hx pilot@test";

export function createInput(instanceId: string, overrides: Partial<{ diskGb: number; imageId: string; privateIp: string }> = {}) {
  return {
    instanceId,
    spec: {
      name: "web-1",
      imageId: overrides.imageId ?? "debian-12",
      vcpu: 2,
      memoryMb: 2048,
      diskGb: overrides.diskGb ?? 16,
      sshPublicKeys: [SSH_KEY],
    },
    privateIp: overrides.privateIp ?? "10.30.0.10",
    network: { cidr: "10.30.0.0/24", gateway: "10.30.0.1" },
  };
}
