/**
 * @softqraft/compute-driver-proxmox: the Proxmox VE 8 HTTP API client (TLS
 * pinned, fenced) and the ProxmoxDriver the host agent runs jobs with.
 */

import type { ProxmoxConfig } from "./config.js";
import { ProxmoxDriver, type ProxmoxDriverOptions } from "./driver.js";
import { DryRunTransport, PinnedHttpsTransport, type ProxmoxCall, type ProxmoxTransport } from "./transport.js";

export * from "./config.js";
export * from "./errors.js";
export * from "./transport.js";
export * from "./client.js";
export * from "./images.js";
export * from "./driver.js";

export interface BuildProxmoxDriverOptions extends ProxmoxDriverOptions {
  /** Log every write instead of sending it; reads still go to Proxmox. */
  dryRun?: boolean;
  /** Called with each write a dry run skipped (already redacted). */
  onDryRunCall?: (call: ProxmoxCall) => void;
  /** Replace the pinned HTTPS transport (tests). */
  transport?: ProxmoxTransport;
}

/** The driver the agent runs: pinned HTTPS, optionally wrapped for a dry run. */
export function buildProxmoxDriver(config: ProxmoxConfig, options: BuildProxmoxDriverOptions = {}): ProxmoxDriver {
  const base = options.transport ?? new PinnedHttpsTransport(config);
  const transport = options.dryRun ? new DryRunTransport(base, (call) => options.onDryRunCall?.(call)) : base;
  return new ProxmoxDriver(config, transport, options);
}
