import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const job = generateKeyPairSync("ed25519");
const cloud = generateKeyPairSync("ed25519");
const JOB_PEM = job.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CLOUD_PUB = cloud.publicKey.export({ type: "spki", format: "pem" }).toString();

const base = { COMPUTE_STORE: "memory", COMPUTE_JOB_SIGNING_KEY_PEM: JOB_PEM };

function fails(env: Record<string, string>, pattern: RegExp) {
  assert.throws(() => loadConfig({ ...base, ...env }), (err: unknown) => {
    assert.ok(err instanceof ConfigError, String(err));
    assert.match(err.message, pattern);
    assert.ok(!err.message.includes("BEGIN"), "message must not echo key material");
    return true;
  });
}

describe("loadConfig", () => {
  it("applies the pilot defaults", () => {
    const c = loadConfig(base);
    assert.deepEqual(c.pool, { maxVcpu: 4, maxMemoryMb: 8192, maxInstances: 3, maxDiskGb: 120 });
    assert.equal(c.pilotCidr.text, "10.30.0.0/24");
    assert.equal(c.allowedProjects.size, 0, "no project may create by default");
    assert.equal(c.jobMaxAttempts, 3);
    assert.equal(c.federation.enabled, false);
    assert.equal(c.jobSigning.keyId, "job-1");
  });

  it("reads pool caps and the allow-list", () => {
    const c = loadConfig({
      ...base,
      COMPUTE_POOL_MAX_VCPU: "2",
      COMPUTE_ALLOWED_PROJECTS: " 22222222-2222-4222-8222-222222222222 ,33333333-3333-4333-8333-33333333333A",
    });
    assert.equal(c.pool.maxVcpu, 2);
    assert.deepEqual([...c.allowedProjects], [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-33333333333a",
    ]);
  });

  for (const cidr of ["10.20.0.0/24", "10.20.0.0/16", "10.20.0.0/23", "10.20.0.128/25", "10.20.0.64/26"]) {
    it(`refuses ${cidr}, which overlaps production`, () => {
      fails({ COMPUTE_PILOT_CIDR: cidr }, /overlap the production network 10.20.0.0\/24/);
    });
  }

  it("refuses public, malformed and badly sized ranges", () => {
    fails({ COMPUTE_PILOT_CIDR: "8.8.8.0/24" }, /private/);
    fails({ COMPUTE_PILOT_CIDR: "10.30.0.1/24" }, /network address/);
    fails({ COMPUTE_PILOT_CIDR: "10.30.0.0" }, /CIDR/);
    fails({ COMPUTE_PILOT_CIDR: "10.0.0.0/8" }, /between/);
    fails({ COMPUTE_PILOT_CIDR: "10.30.0.0/30" }, /between/);
  });

  it("accepts other private ranges", () => {
    assert.equal(loadConfig({ ...base, COMPUTE_PILOT_CIDR: "10.21.0.0/24" }).pilotCidr.text, "10.21.0.0/24");
    assert.equal(loadConfig({ ...base, COMPUTE_PILOT_CIDR: "192.168.50.0/24" }).pilotCidr.prefix, 24);
  });

  it("requires the job signing key and checks it is Ed25519", () => {
    assert.throws(() => loadConfig({ COMPUTE_STORE: "memory" }), /COMPUTE_JOB_SIGNING_KEY_PEM is required/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fails({ COMPUTE_JOB_SIGNING_KEY_PEM: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, /Ed25519/);
    fails({ COMPUTE_JOB_SIGNING_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, /not a valid/);
  });

  it("requires DATABASE_URL for the postgres store and refuses memory in production", () => {
    fails({ COMPUTE_STORE: "postgres" }, /DATABASE_URL/);
    fails({ NODE_ENV: "production" }, /not allowed/);
  });

  it("requires public keys when federation is on", () => {
    fails({ CLOUD_FEDERATION_ENABLED: "true" }, /CLOUD_FEDERATION_PUBLIC_KEYS is required/);
    fails({ CLOUD_FEDERATION_ENABLED: "yes" }, /true or false/);
    fails({ CLOUD_FEDERATION_ENABLED: "true", CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({ k: JOB_PEM }) }, /SPKI/);
    const c = loadConfig({
      ...base,
      CLOUD_FEDERATION_ENABLED: "true",
      CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({ "prod-1": CLOUD_PUB }),
    });
    assert.ok(c.federation.enabled && c.federation.publicKeys.has("prod-1"));
  });

  it("refuses bad numbers and project ids", () => {
    fails({ COMPUTE_POOL_MAX_VCPU: "0" }, /COMPUTE_POOL_MAX_VCPU/);
    fails({ COMPUTE_POOL_MAX_INSTANCES: "three" }, /whole number/);
    fails({ COMPUTE_JOB_MAX_ATTEMPTS: "11" }, /COMPUTE_JOB_MAX_ATTEMPTS/);
    fails({ COMPUTE_ALLOWED_PROJECTS: "project-a" }, /UUID/);
  });
});
