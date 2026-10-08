/**
 * End-to-end harness: the real Compute API (its built `dist/index.js`, memory
 * store) in a child process, a fake Proxmox over pinned TLS, and the real
 * agent in this process. Cloud and staff calls go through the real
 * federation launch and session routes. Every key is generated at run time.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProxmoxDriver, IMAGE_CATALOGUE, loadProxmoxConfig } from "@softqraft/compute-driver-proxmox";
import { FakeProxmox } from "@softqraft/compute-proxmox-fake";
import { signRequest } from "@softqraft/federation";
import { Agent } from "../src/agent.js";
import { ComputeApi } from "../src/api.js";
import { loadAgentConfig, readEnvFile } from "../src/config.js";
import { createLogger } from "../src/log.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ENTRY = path.resolve(HERE, "../../api/dist/index.js");

export const PROJECT = "22222222-2222-4222-8222-222222222222";
export const ORG = "11111111-1111-4111-8111-111111111111";
export const SI = "si-e2e-1";
const CLOUD_KEY_ID = "e2e-cloud-1";

export const RUNBOOK_RULES = [
  "-P FORWARD ACCEPT",
  "-A FORWARD -s 10.30.0.0/24 -d 10.20.0.0/24 -j DROP",
  "-A FORWARD -s 10.30.0.0/24 -p tcp -m multiport --dports 25,465,587 -j DROP",
].join("\n");

const DEBIAN = IMAGE_CATALOGUE["debian-12"]!;
const UBUNTU = IMAGE_CATALOGUE["ubuntu-24.04"]!;
const debianHash = createHash("sha512").update("debian").digest("hex");
const ubuntuHash = createHash("sha256").update("ubuntu").digest("hex");
const vendorLists: Record<string, string> = {
  [DEBIAN.checksumsUrl]: `${debianHash}  ${DEBIAN.fileName}\n`,
  [UBUNTU.checksumsUrl]: `${ubuntuHash} *${UBUNTU.fileName}\n`,
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export interface Session {
  cookie: string;
}

export interface E2E {
  base: string;
  pve: FakeProxmox;
  agent: Agent;
  running: Promise<void> | null;
  logs: string[];
  envFile: string;
  stateDir: string;
  tokenSecret: string;
  start(): void;
  cloud(method: string, path: string, body?: unknown): Promise<Response>;
  browser(session: Session, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  console: Session;
  admin: Session;
  waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms?: number): Promise<T>;
  close(): Promise<void>;
}

export interface E2EOptions {
  dryRun?: boolean;
  guard?: boolean;
  hostName?: string;
  /** COMPUTE_AGENT_ENSURE_IMAGES (default true). */
  ensureImages?: boolean;
  /** Pin this fingerprint instead of the fake Proxmox's own. */
  tlsFingerprint?: string;
}

export async function startE2E(options: E2EOptions = {}): Promise<E2E> {
  const dir = mkdtempSync(path.join(tmpdir(), "sq-e2e-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cloudKeys = generateKeyPairSync("ed25519");
  const jobKeys = generateKeyPairSync("ed25519");
  const apiLogs: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [API_ENTRY], {
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      LOG_LEVEL: "warn",
      COMPUTE_STORE: "memory",
      COMPUTE_PUBLIC_URL: base,
      COMPUTE_ALLOWED_PROJECTS: PROJECT,
      COMPUTE_JOB_SIGNING_KEY_PEM: jobKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      COMPUTE_MAINTENANCE_INTERVAL_SECONDS: "1",
      // F3: the agent routes accept only this address (the agent runs here).
      COMPUTE_AGENT_ALLOWED_IPS: "127.0.0.1",
      CLOUD_FEDERATION_ENABLED: "true",
      CLOUD_OPERATOR_LAUNCH_ENABLED: "true",
      CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({
        [CLOUD_KEY_ID]: cloudKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => apiLogs.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => apiLogs.push(d.toString()));

  const waitFor = async <T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe().catch(() => null);
      if (value) return value as T;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await waitFor("the API", async () => (await fetch(`${base}/health`)).ok, 15_000).catch((err) => {
    child.kill();
    throw new Error(`${(err as Error).message}\n${apiLogs.join("")}`);
  });

  const cloud = async (method: string, p: string, body?: unknown) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = signRequest({ audience: "compute", keyId: CLOUD_KEY_ID, privateKey: cloudKeys.privateKey, method, path: p, body: payload });
    return fetch(`${base}${p}`, {
      method,
      headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}) },
      body: payload || undefined,
    });
  };
  const browser = async (session: Session, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { origin: base, cookie: session.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const redeem = async (launchPath: string, launchBody: unknown, redeemPath: string, cookieName: string): Promise<Session> => {
    const launch = await cloud("POST", launchPath, launchBody);
    if (launch.status !== 201) throw new Error(`launch failed ${launch.status}`);
    const grant = new URL(((await launch.json()) as { launchUrl: string }).launchUrl).hash.replace(/^#grant=/, "");
    const res = await fetch(`${base}${redeemPath}`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ grant }),
    });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${cookieName}=`));
    if (res.status !== 200 || !cookie) throw new Error(`redeem failed ${res.status}`);
    return { cookie: cookie.split(";")[0]! };
  };

  const provision = await cloud("PUT", `/cloud/v1/service-instances/${SI}`, {
    cloudOrganisationId: ORG,
    cloudProjectId: PROJECT,
    displayName: "E2E",
    regionId: "eu-central",
  });
  if (provision.status !== 201) throw new Error(`provision failed ${provision.status}`);
  const principal = (subject: string) => ({ subject, displayName: "E2E", email: "e2e@example.com" });
  const consoleSession = await redeem(
    `/cloud/v1/service-instances/${SI}/console-launches`,
    { principal: principal("user_dev"), role: "developer", returnPath: "/console/instances" },
    "/console/v1/auth/cloud-launch/redeem",
    "sq_console_session",
  );
  const adminSession = await redeem(
    "/cloud/v1/operator-launches",
    { principal: principal("user_staff"), role: "admin", returnPath: "/admin/fleet" },
    "/admin/v1/auth/cloud-launch/redeem",
    "sq_admin_session",
  );
  const hostName = options.hostName ?? "sq-node-01";
  const tokenRes = await browser(adminSession, "POST", "/admin/v1/fleet/enrolment-tokens", { hostName });
  if (tokenRes.status !== 201) throw new Error(`enrolment token failed ${tokenRes.status}`);
  const { token } = (await tokenRes.json()) as { token: string };

  const tokenSecret = randomUUID();
  const pve = new FakeProxmox({
    tokenId: "compute-agent@pve!agent",
    tokenSecret,
    node: "sq-node-01",
    pool: "compute-pilot",
    storage: "compute-pilot",
    importStorage: "local",
    vendorFiles: { [DEBIAN.url]: { sha512: debianHash }, [UBUNTU.url]: { sha256: ubuntuHash } },
  });
  await pve.start();

  const guardFile = path.join(dir, "forward.rules");
  if (options.guard !== false) writeFileSync(guardFile, RUNBOOK_RULES);
  const envFile = path.join(dir, "compute-agent.env");
  writeFileSync(
    envFile,
    [
      `COMPUTE_API_URL=${base}`,
      `COMPUTE_HOST_NAME=${hostName}`,
      `COMPUTE_ENROLMENT_TOKEN=${token}`,
      `COMPUTE_AGENT_STATE_DIR=${path.join(dir, "state")}`,
      `COMPUTE_AGENT_NETWORK_GUARD_FILE=${guardFile}`,
      `COMPUTE_AGENT_DRY_RUN=${options.dryRun ? "true" : "false"}`,
      `COMPUTE_AGENT_ENSURE_IMAGES=${options.ensureImages === false ? "false" : "true"}`,
      "COMPUTE_AGENT_POLL_SECONDS=0.05",
      "COMPUTE_AGENT_HEARTBEAT_SECONDS=0.5",
      "COMPUTE_AGENT_USAGE_SECONDS=0.3",
      "COMPUTE_AGENT_BACKOFF_MAX_SECONDS=0.2",
      `PROXMOX_URL=${pve.url}`,
      "PROXMOX_NODE=sq-node-01",
      "PROXMOX_TOKEN_ID=compute-agent@pve!agent",
      `PROXMOX_TOKEN_SECRET=${tokenSecret}`,
      `PROXMOX_TLS_FINGERPRINT=${options.tlsFingerprint ?? pve.certificate.fingerprint}`,
      "PROXMOX_POOL=compute-pilot",
      "PROXMOX_STORAGE=compute-pilot",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  // As main.ts does, with a vendor fetcher that never leaves the process.
  const env = readEnvFile(envFile);
  const config = loadAgentConfig(env);
  const logs: string[] = [];
  const log = createLogger("debug", (l) => logs.push(l));
  const driver = buildProxmoxDriver(loadProxmoxConfig(env), {
    dryRun: config.dryRun,
    onDryRunCall: (call) => log.info("proxmox_dry_run", { method: call.method, path: call.path, params: call.params }),
    log: (event, fields) => log.info(event, fields),
    pollMs: 5,
    fetchText: async (url) => {
      const text = vendorLists[url];
      if (text === undefined) throw new Error("404");
      return text;
    },
  });
  const agent = new Agent({ config, driver, api: new ComputeApi(config.apiUrl), log, envFile });

  const e2e: E2E = {
    base,
    pve,
    agent,
    running: null,
    logs,
    envFile,
    stateDir: path.join(dir, "state"),
    tokenSecret,
    start() {
      e2e.running = agent.run();
    },
    cloud,
    browser,
    console: consoleSession,
    admin: adminSession,
    waitFor,
    async close() {
      await agent.stop();
      await e2e.running?.catch(() => undefined);
      await pve.stop();
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return e2e;
}
