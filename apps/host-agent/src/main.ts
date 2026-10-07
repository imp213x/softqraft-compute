/**
 * Entry point: `node dist/main.js` (systemd: softqraft-compute-agent).
 *
 * Reads `/etc/softqraft/compute-agent.env` (or COMPUTE_AGENT_ENV_FILE). When
 * the agent may not read the file itself (root-only, as the runbook sets
 * it), systemd passes the same values through `EnvironmentFile=`, and they
 * come from the process environment instead. It validates them, builds the Proxmox driver (dry-run when
 * COMPUTE_AGENT_DRY_RUN=true) and runs the agent until SIGTERM or SIGINT.
 */

import { buildProxmoxDriver, loadProxmoxConfig, ProxmoxConfigError } from "@softqraft/compute-driver-proxmox";
import { Agent } from "./agent.js";
import { ComputeApi } from "./api.js";
import { AgentConfigError, DEFAULT_ENV_FILE, loadAgentConfig, readEnvFile } from "./config.js";
import { createLogger } from "./log.js";

async function main(): Promise<void> {
  const envFile = process.env.COMPUTE_AGENT_ENV_FILE || DEFAULT_ENV_FILE;
  let agent: Agent;
  let log = createLogger("info");
  try {
    let env: Record<string, string | undefined>;
    try {
      env = { ...process.env, ...readEnvFile(envFile) };
    } catch {
      env = { ...process.env };
    }
    const config = loadAgentConfig(env);
    log = createLogger(config.logLevel);
    const proxmox = loadProxmoxConfig(env);
    const driver = buildProxmoxDriver(proxmox, {
      dryRun: config.dryRun,
      onDryRunCall: (call) => log.info("proxmox_dry_run", { method: call.method, path: call.path, params: call.params }),
      log: (event, fields) => log.info(event, fields),
    });
    agent = new Agent({ config, driver, api: new ComputeApi(config.apiUrl), log, envFile });
  } catch (err) {
    if (err instanceof AgentConfigError || err instanceof ProxmoxConfigError) {
      log.error("configuration_error", { message: err.message });
      process.exit(78); // EX_CONFIG: systemd does not restart-loop on it (RestartPreventExitStatus).
    }
    throw err;
  }

  let signals = 0;
  const onSignal = (signal: string) => {
    signals += 1;
    log.info("shutting_down", { signal });
    if (signals > 1) process.exit(1);
    void agent.stop();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  try {
    await agent.run();
    process.exit(0);
  } catch (err) {
    log.error("agent_failed", { message: err instanceof Error ? err.message : "error" });
    process.exit(1);
  }
}

void main();
