/**
 * A local preview of the Console and Admin pages: the real app on the
 * memory store, with seeded fake data and a fake host agent. For looking at
 * the pages and for the C1d visual check. Never for deployment.
 *
 *   pnpm --filter @softqraft/compute-api preview      # http://127.0.0.1:8099
 *
 * Every key is generated at start and never leaves the process. Preview-only
 * helpers live under /__preview/ (local listener only):
 *   GET /__preview/launch?as=console|viewer|empty|operator|operator-viewer → 302 to a fresh launch URL
 *   POST /__preview/agent-step    run every queued job on the fake hosts
 *   POST /__preview/advance?seconds=N   move the app clock forward (the 15-minute rule)
 */

import { generateKeyPairSync } from "node:crypto";
import { signRequest } from "@softqraft/federation";
import { DriverError, defaultDriverRegistry } from "@softqraft/compute-driver";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryComputeStore } from "../src/store/index.js";
import { FakeAgent, TestClock, grantFrom, pem } from "./helpers.js";

const PORT = Number(process.env.PREVIEW_PORT ?? 8099);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLOUD_ORIGIN = process.env.PREVIEW_CLOUD_ORIGIN ?? "https://cloud.example.test";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "preview-cloud";

let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
/** The fake agent reads the same clock. */
class LiveClock extends TestClock {
  override now = (): Date => clock();
}

const cloudKeys = generateKeyPairSync("ed25519");
const jobKeys = generateKeyPairSync("ed25519");
const config = loadConfig({
  NODE_ENV: "development",
  LOG_LEVEL: "warn",
  HOST: "127.0.0.1",
  PORT: String(PORT),
  COMPUTE_STORE: "memory",
  COMPUTE_PUBLIC_URL: ORIGIN,
  COMPUTE_ALLOWED_PROJECTS: PROJECT,
  COMPUTE_JOB_SIGNING_KEY_PEM: pem(jobKeys.privateKey, "pkcs8"),
  COMPUTE_POOL_MAX_INSTANCES: "10",
  COMPUTE_POOL_MAX_VCPU: "16",
  COMPUTE_POOL_MAX_MEMORY_MB: "16384",
  COMPUTE_POOL_MAX_DISK_GB: "400",
  CLOUD_FEDERATION_ENABLED: "true",
  CLOUD_OPERATOR_LAUNCH_ENABLED: "true",
  CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({ [KEY_ID]: pem(cloudKeys.publicKey, "spki") }),
  CLOUD_ORIGIN,
});
const store = new MemoryComputeStore();
const { app, services } = await buildApp({ config, store, drivers: defaultDriverRegistry(), clock });

// Preview helpers: registered first, because the seeding below readies the app.
app.get("/__preview/launch", async (req, reply) => {
  const as = String((req.query as Record<string, unknown>).as ?? "console");
  const make = LAUNCHES[as];
  if (!make) return reply.status(404).send({ error: "unknown" });
  return reply.redirect(await make());
});
app.post("/__preview/agent-step", async () => {
  let ran = 0;
  for (const a of agents) ran += await a.drain(50);
  return { ran };
});
app.post("/__preview/advance", async (req) => {
  offsetMs += Number((req.query as Record<string, unknown>).seconds ?? 0) * 1000;
  return { now: clock().toISOString() };
});


async function cloud(method: string, path: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = signRequest({ audience: "compute", keyId: KEY_ID, privateKey: cloudKeys.privateKey, method, path, body: payload, now: clock() });
  const res = await app.inject({
    method: method as "POST",
    url: path,
    payload: payload || undefined,
    headers: { ...(payload ? { "content-type": "application/json" } : {}), ...headers },
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${path}: ${res.statusCode}`);
  return res.json();
}

async function provision(id: string, displayName: string) {
  await cloud("PUT", `/cloud/v1/service-instances/${id}`, { cloudOrganisationId: ORG, cloudProjectId: PROJECT, displayName, regionId: "eu-central" });
}

async function enrol(name: string, capacity: { vcpu: number; memoryMb: number; diskGb: number }) {
  const { token } = await services.hosts.createEnrolmentToken({ hostName: name, now: clock() });
  const keys = generateKeyPairSync("ed25519");
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/enrol",
    payload: { token, name, driver: "fake", publicKey: pem(keys.publicKey, "spki"), capacity },
  });
  const body = res.json() as { hostId: string; jobSigningKeys: Record<string, string> };
  const { loadPublicKey } = await import("@softqraft/compute-jobs");
  const ring = new Map(Object.entries(body.jobSigningKeys).map(([id, p]) => [id, loadPublicKey(p)] as const));
  return new FakeAgent(app, new LiveClock(), body.hostId, keys.privateKey, ring);
}

/** A developer session on a service instance, opened through the real launch, for seeding. */
async function seedSession(si: string): Promise<string> {
  const launch = await cloud("POST", `/cloud/v1/service-instances/${si}/console-launches`, {
    principal: { subject: "user_seed", displayName: "Seed", email: "seed@example.test" },
    role: "developer",
    returnPath: "/console/",
  });
  const res = await app.inject({
    method: "POST",
    url: "/console/v1/auth/cloud-launch/redeem",
    payload: { grant: grantFrom(launch.launchUrl) },
    headers: { origin: ORIGIN, "content-type": "application/json" },
  });
  const raw = res.headers["set-cookie"];
  const line = (Array.isArray(raw) ? raw : [String(raw)]).find((l) => l.startsWith("sq_console_session="))!;
  return line.split(";")[0]!;
}

async function seedCall(cookie: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as "POST",
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { origin: ORIGIN, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
}

const SSH_KEY_LINE = (() => {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const s = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  return `ssh-ed25519 ${Buffer.concat([s(Buffer.from("ssh-ed25519")), s(Buffer.from(jwk.x!, "base64url"))]).toString("base64")} ada@laptop`;
})();

await provision("si-preview", "Acme production");
await provision("si-empty", "Acme staging");

const node1 = await enrol("sq-node-01", { vcpu: 8, memoryMb: 16384, diskGb: 240 });
const node2 = await enrol("sq-node-02", { vcpu: 8, memoryMb: 16384, diskGb: 240 });
await enrol("sq-node-03", { vcpu: 4, memoryMb: 8192, diskGb: 120 });
const agents = [node1, node2];
await node1.claim();
await node2.claim();
const drainAll = async () => {
  for (const a of agents) await a.drain(50);
};

const seed = await seedSession("si-preview");
const saved = await seedCall(seed, "POST", "/console/v1/ssh-keys", { publicKey: SSH_KEY_LINE });
const key = saved.sshKey.publicKey as string;
let n = 0;
const create = async (name: string, imageId: string, vcpu: number, memoryMb: number) => {
  n += 1;
  return (await seedCall(seed, "POST", "/console/v1/instances", { name, imageId, vcpu, memoryMb, diskGb: 16, sshPublicKeys: [key] }, { "idempotency-key": `preview-seed-${n}` })).instance as { id: string };
};
const running = await create("swift-otter-12", "ubuntu-24.04", 1, 1024);
const stopped = await create("calm-heron-41", "debian-12", 2, 2048);
const broken = await create("bright-lynx-77", "ubuntu-24.04", 2, 4096);
await drainAll();
await seedCall(seed, "POST", `/console/v1/instances/${running.id}/snapshots`, { name: "before-upgrade" });
await seedCall(seed, "POST", `/console/v1/instances/${stopped.id}/actions`, { action: "stop" });
await drainAll();
// One VM that needs attention: its start fails on the host.
await seedCall(seed, "POST", `/console/v1/instances/${broken.id}/actions`, { action: "stop" });
await drainAll();
await seedCall(seed, "POST", `/console/v1/instances/${broken.id}/actions`, { action: "start" });
const brokenHost = (await seedCall(seed, "GET", `/console/v1/instances/${broken.id}`)).instance.hostId as string;
agents.find((a) => a.hostId === brokenHost)?.driver.failNext("start", new DriverError("host_full", "preview failure", false), 3);
await drainAll();
// Usage for the running VM: the last six hours.
const now = clock();
const samples = Array.from({ length: 12 }, (_, i) => ({
  instanceId: running.id,
  sampledAt: new Date(now.getTime() - i * 1800_000).toISOString(),
  intervalSeconds: 1800,
  powerState: "running",
}));
for (const a of agents) {
  const res = await a.request("POST", "/v1/agent/usage", { samples });
  if (res.statusCode === 202) break;
}
// sq-node-02 is disabled (the kill switch); sq-node-03 never connected.
await services.hosts.disable(node2.hostId, clock());

const LAUNCHES: Record<string, () => Promise<string>> = {
  console: async () =>
    (await cloud("POST", "/cloud/v1/service-instances/si-preview/console-launches", {
      principal: { subject: "user_ada", displayName: "Ada Lovelace", email: "ada@example.test" },
      role: "developer",
      returnPath: "/console/",
    })).launchUrl,
  viewer: async () =>
    (await cloud("POST", "/cloud/v1/service-instances/si-preview/console-launches", {
      principal: { subject: "user_vic", displayName: "Vic Viewer", email: "vic@example.test" },
      role: "viewer",
      returnPath: "/console/",
    })).launchUrl,
  empty: async () =>
    (await cloud("POST", "/cloud/v1/service-instances/si-empty/console-launches", {
      principal: { subject: "user_ada", displayName: "Ada Lovelace", email: "ada@example.test" },
      role: "admin",
      returnPath: "/console/",
    })).launchUrl,
  operator: async () =>
    (await cloud("POST", "/cloud/v1/operator-launches", {
      principal: { subject: "user_ops", displayName: "Olu Operator", email: "olu@example.test" },
      role: "admin",
      returnPath: "/admin/",
    })).launchUrl,
  "operator-viewer": async () =>
    (await cloud("POST", "/cloud/v1/operator-launches", {
      principal: { subject: "user_sup", displayName: "Sam Support", email: "sam@example.test" },
      role: "viewer",
      returnPath: "/admin/",
    })).launchUrl,
};

await app.listen({ host: "127.0.0.1", port: PORT });
process.stdout.write(`Compute preview on ${ORIGIN}\n  Console: ${ORIGIN}/__preview/launch?as=console\n  Admin:   ${ORIGIN}/__preview/launch?as=operator\n`);
