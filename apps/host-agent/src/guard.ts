/**
 * The network guard: the host's iptables rules that keep tenants from
 * sending mail and from reaching production (runbook section 3). The rules
 * belong to the host; the agent only checks they are there, and runs no job
 * while they are missing (`network_guard_missing`).
 *
 * The agent runs unprivileged and cannot read iptables itself. The systemd
 * unit's privileged `ExecStartPre` writes `iptables -S FORWARD` to a file at
 * every start, and the agent checks that file.
 */

import { readFileSync } from "node:fs";

export interface GuardOptions {
  pilotCidr: string;
  productionCidr: string;
  bridge: string;
  productionBridge: string;
}

export interface GuardResult {
  ok: boolean;
  /** Which protections are missing: `smtp_25`, `smtp_465`, `smtp_587`, `production`. */
  missing: string[];
}

const SMTP_PORTS = ["25", "465", "587"] as const;

/** Split one `iptables -S` line into options and values. */
function options(line: string): Map<string, string> {
  const tokens = line.trim().split(/\s+/);
  const out = new Map<string, string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) continue;
    const next = tokens[i + 1];
    // A negated match (`! -d x`) is not a protection.
    if (tokens[i - 1] === "!") continue;
    out.set(token, next && !next.startsWith("-") ? next : "");
  }
  return out;
}

function drops(opts: Map<string, string>): boolean {
  return opts.get("-j") === "DROP" || opts.get("-j") === "REJECT";
}

function fromTenants(opts: Map<string, string>, o: GuardOptions): boolean {
  return opts.get("-s") === o.pilotCidr || opts.get("-i") === o.bridge;
}

export function checkNetworkGuard(rules: string, o: GuardOptions): GuardResult {
  const lines = rules
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-A FORWARD "))
    .map(options);
  const blockedPorts = new Set<string>();
  let production = false;
  for (const opts of lines) {
    if (!drops(opts) || !fromTenants(opts, o)) continue;
    // Rules that also match on state, rate or anything else do not block every connection.
    if (opts.has("-m") && !["multiport", "tcp"].includes(opts.get("-m")!)) continue;
    if (opts.get("-p") === "tcp") {
      const ports = (opts.get("--dports") ?? opts.get("--dport") ?? "").split(",");
      for (const p of ports) if ((SMTP_PORTS as readonly string[]).includes(p)) blockedPorts.add(p);
    }
    if (!opts.has("-p") && !opts.has("--dport") && !opts.has("--dports")) {
      if (opts.get("-d") === o.productionCidr || opts.get("-o") === o.productionBridge) production = true;
    }
  }
  const missing = SMTP_PORTS.filter((p) => !blockedPorts.has(p)).map((p) => `smtp_${p}`);
  if (!production) missing.push("production");
  return { ok: missing.length === 0, missing };
}

/** Read the snapshot file and check it. A missing or unreadable file means every protection is missing. */
export function checkNetworkGuardFile(path: string, o: GuardOptions): GuardResult {
  let rules: string;
  try {
    rules = readFileSync(path, "utf8");
  } catch {
    return { ok: false, missing: ["rules_file", ...SMTP_PORTS.map((p) => `smtp_${p}`), "production"] };
  }
  return checkNetworkGuard(rules, o);
}
