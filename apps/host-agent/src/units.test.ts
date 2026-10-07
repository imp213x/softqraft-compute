import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Backoff } from "./agent.js";
import { loadAgentConfig, parseEnvFile, wipeEnrolmentToken } from "./config.js";
import { checkNetworkGuard, checkNetworkGuardFile } from "./guard.js";
import { createLogger, redact } from "./log.js";
import { AgentState, StateError } from "./state.js";
import { RUNBOOK_RULES } from "./rules.test-helper.js";

const BASE = { COMPUTE_API_URL: "https://compute.softqraftlabs.com", COMPUTE_HOST_NAME: "sq-node-01" };



const GUARD = { pilotCidr: "10.30.0.0/24", productionCidr: "10.20.0.0/24", bridge: "vmbr10", productionBridge: "vmbr0" };

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "sq-agent-test-"));
}

describe("agent configuration", () => {
  it("applies defaults and converts seconds", () => {
    const c = loadAgentConfig(BASE);
    assert.equal(c.apiUrl, "https://compute.softqraftlabs.com");
    assert.equal(c.stateDir, "/var/lib/softqraft-compute-agent");
    assert.equal(c.dryRun, false);
    assert.equal(c.heartbeatMs, 30_000);
    assert.equal(c.usageMs, 60_000);
    assert.deepEqual(c.capacity, { vcpu: 4, memoryMb: 8192, diskGb: 120 });
    assert.equal(c.enrolmentToken, null);
    assert.equal(loadAgentConfig({ ...BASE, COMPUTE_AGENT_DRY_RUN: "true" }).dryRun, true);
  });

  it("refuses plain http to a remote API, a heartbeat outside the lease, and bad values, naming variables only", () => {
    for (const change of [
      { COMPUTE_API_URL: "http://compute.softqraftlabs.com" },
      { COMPUTE_API_URL: "https://compute.softqraftlabs.com/v1" },
      { COMPUTE_AGENT_HEARTBEAT_SECONDS: "61" },
      { COMPUTE_AGENT_DRY_RUN: "yes" },
      { COMPUTE_HOST_NAME: "SQ Node" },
      { COMPUTE_AGENT_STATE_DIR: "relative/dir" },
    ]) {
      assert.throws(() => loadAgentConfig({ ...BASE, ...change }), /COMPUTE_|configuration/, JSON.stringify(change));
    }
    assert.equal(loadAgentConfig({ ...BASE, COMPUTE_API_URL: "http://127.0.0.1:8080" }).apiUrl, "http://127.0.0.1:8080");
  });

  it("parses the env file and blanks the token in place, keeping the mode", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "compute-agent.env");
      writeFileSync(file, "# agent\nCOMPUTE_API_URL=https://x.test\nCOMPUTE_ENROLMENT_TOKEN=\"sqet_abc\"\nexport PROXMOX_POOL='compute-pilot'\n", { mode: 0o640 });
      assert.deepEqual(parseEnvFile(readFileSync(file, "utf8")), {
        COMPUTE_API_URL: "https://x.test",
        COMPUTE_ENROLMENT_TOKEN: "sqet_abc",
        PROXMOX_POOL: "compute-pilot",
      });
      assert.equal(wipeEnrolmentToken(file), true);
      const after = readFileSync(file, "utf8");
      assert.ok(!after.includes("sqet_abc"));
      assert.match(after, /^COMPUTE_ENROLMENT_TOKEN=$/m);
      assert.match(after, /COMPUTE_API_URL=https:\/\/x.test/);
      assert.equal(statSync(file).mode & 0o777, 0o640);
      if (process.getuid?.() !== 0) {
        chmodSync(file, 0o440);
        assert.equal(wipeEnrolmentToken(file), false, "read-only file: the operator is told instead");
      }
      assert.equal(wipeEnrolmentToken(path.join(dir, "missing.env")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("network guard", () => {
  it("accepts the runbook's rules", () => {
    assert.deepEqual(checkNetworkGuard(RUNBOOK_RULES, GUARD), { ok: true, missing: [] });
  });

  it("accepts bridge-based rules and separate SMTP rules", () => {
    const rules = [
      "-A FORWARD -i vmbr10 -o vmbr0 -j DROP",
      "-A FORWARD -i vmbr10 -p tcp -m tcp --dport 25 -j REJECT",
      "-A FORWARD -i vmbr10 -p tcp -m tcp --dport 465 -j DROP",
      "-A FORWARD -i vmbr10 -p tcp -m tcp --dport 587 -j DROP",
    ].join("\n");
    assert.deepEqual(checkNetworkGuard(rules, GUARD), { ok: true, missing: [] });
  });

  it("reports what is missing", () => {
    const noSmtp = RUNBOOK_RULES.replace(/.*multiport.*\n/, "");
    assert.deepEqual(checkNetworkGuard(noSmtp, GUARD).missing, ["smtp_25", "smtp_465", "smtp_587"]);
    const noProd = RUNBOOK_RULES.replace(/.*-d 10\.20\.0\.0\/24.*\n/, "");
    assert.deepEqual(checkNetworkGuard(noProd, GUARD).missing, ["production"]);
    const accept = RUNBOOK_RULES.replace(/-j DROP/g, "-j ACCEPT");
    assert.equal(checkNetworkGuard(accept, GUARD).ok, false);
    const otherNet = RUNBOOK_RULES.replace(/10\.30\.0\.0\/24/g, "10.99.0.0/24");
    assert.equal(checkNetworkGuard(otherNet, GUARD).ok, false);
    const negated = "-A FORWARD -s 10.30.0.0/24 ! -d 10.20.0.0/24 -j DROP\n-A FORWARD -s 10.30.0.0/24 -p tcp -m multiport --dports 25,465,587 -j DROP";
    assert.deepEqual(checkNetworkGuard(negated, GUARD).missing, ["production"]);
    assert.equal(checkNetworkGuard("", GUARD).ok, false);
  });

  it("treats a missing rules file as no guard", () => {
    const result = checkNetworkGuardFile("/nonexistent/iptables.rules", GUARD);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes("rules_file"));
  });
});

describe("logs", () => {
  it("never write tokens, keys, signatures or envelopes", () => {
    const lines: string[] = [];
    const log = createLogger("info", (l) => lines.push(l));
    log.info("test", {
      token: "sqet_secret",
      enrolmentToken: "sqet_x",
      jobSigningKeys: { a: "pem" },
      signature: "sig",
      envelope: { id: 1 },
      headers: { authorization: "PVEAPIToken=user@pve!agent=uuid" },
      note: "value PVEAPIToken=a@pve!b=c and sqet_AAAA end",
      instanceId: "keep-me",
    });
    log.debug("hidden", {});
    assert.equal(lines.length, 1);
    const text = lines[0]!;
    for (const secret of ["sqet_secret", "sqet_x", "pem", "sig\"", "PVEAPIToken", "sqet_AAAA"]) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.ok(text.includes("keep-me"));
    assert.deepEqual(redact({ a: ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"] }), { a: ["[redacted]"] });
  });
});

describe("state directory", () => {
  it("creates a 0600 host key once and refuses loose permissions", () => {
    const dir = path.join(tempDir(), "state");
    try {
      const state = new AgentState(dir);
      state.prepare();
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      const first = state.hostKey();
      assert.equal(statSync(path.join(dir, "host-key.pem")).mode & 0o777, 0o600);
      assert.equal(state.hostKey().publicKeyPem, first.publicKeyPem, "the key is kept");
      chmodSync(path.join(dir, "host-key.pem"), 0o644);
      assert.throws(() => state.hostKey(), StateError);
      chmodSync(dir, 0o755);
      assert.throws(() => state.prepare(), StateError);
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});

describe("backoff", () => {
  it("grows exponentially to the cap and resets", () => {
    const b = new Backoff(1000, 60_000, () => 1);
    assert.deepEqual([b.next(), b.next(), b.next(), b.next()], [1000, 2000, 4000, 8000]);
    for (let i = 0; i < 10; i += 1) b.next();
    assert.equal(b.next(), 60_000);
    b.reset();
    assert.equal(b.next(), 1000);
    assert.equal(new Backoff(1000, 60_000, () => 0).next(), 500, "jitter stays in the upper half");
  });
});
