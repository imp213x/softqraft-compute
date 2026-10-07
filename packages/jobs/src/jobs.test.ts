import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  agentTimestampFresh,
  canonicalJson,
  loadPublicKey,
  loadSigningKey,
  parseAgentHeaders,
  publicKeyPem,
  signAgentRequest,
  signJob,
  verifyAgentSignature,
  verifyJob,
  type JobEnvelope,
} from "./index.js";

// Test keys are generated at run time and never leave the process.
function keyPair() {
  return generateKeyPairSync("ed25519");
}

const HOST = "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c12";
const OTHER_HOST = "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c99";
const ISSUED = new Date("2026-10-07T10:00:00.000Z");

function envelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    id: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11",
    hostId: HOST,
    type: "create",
    payload: { spec: { name: "web", vcpu: 1 }, privateIp: "10.30.0.10" },
    instanceId: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c13",
    attempt: 1,
    issuedAt: ISSUED.toISOString(),
    expiresAt: new Date(ISSUED.getTime() + 300_000).toISOString(),
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("sorts keys at every level and drops whitespace", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } }),
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("is independent of insertion order", () => {
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  it("escapes strings as JSON does", () => {
    assert.equal(canonicalJson({ s: 'q"\n é' }), JSON.stringify({ s: 'q"\n é' }));
  });

  for (const [label, value] of [
    ["undefined", { a: undefined }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", [Infinity]],
    ["bigint", { a: 1n }],
    ["Date", { a: new Date(0) }],
    ["function", { a: () => 1 }],
  ] as const) {
    it(`rejects ${label}`, () => assert.throws(() => canonicalJson(value)));
  }
});

describe("signJob and verifyJob", () => {
  const { privateKey, publicKey } = keyPair();
  const keys = new Map([["job-1", publicKey]]);
  const at = new Date(ISSUED.getTime() + 1000);

  it("accepts a valid job for this host", () => {
    const signed = signJob(envelope(), privateKey, "job-1");
    const result = verifyJob(signed, { keys, hostId: HOST, now: at });
    assert.equal(result.ok, true);
  });

  it("verifies after a JSON round trip with reordered keys", () => {
    const signed = signJob(envelope(), privateKey, "job-1");
    const reordered = JSON.parse(JSON.stringify(signed));
    const env = reordered.envelope;
    reordered.envelope = Object.fromEntries(Object.entries(env).reverse());
    assert.equal(verifyJob(reordered, { keys, hostId: HOST, now: at }).ok, true);
  });

  it("rejects a bad signature", () => {
    const signed = signJob(envelope(), privateKey, "job-1");
    const other = keyPair();
    const forged = signJob(envelope(), other.privateKey, "job-1");
    assert.deepEqual(verifyJob({ ...signed, signature: forged.signature }, { keys, hostId: HOST, now: at }), {
      ok: false,
      reason: "signature",
    });
  });

  it("rejects the wrong host", () => {
    const signed = signJob(envelope(), privateKey, "job-1");
    assert.deepEqual(verifyJob(signed, { keys, hostId: OTHER_HOST, now: at }), {
      ok: false,
      reason: "wrong_host",
    });
  });

  it("rejects an expired job, including at the exact expiry", () => {
    const signed = signJob(envelope(), privateKey, "job-1");
    for (const ms of [300_000, 300_001, 3_600_000]) {
      assert.deepEqual(
        verifyJob(signed, { keys, hostId: HOST, now: new Date(ISSUED.getTime() + ms) }),
        { ok: false, reason: "expired" },
      );
    }
  });

  it("rejects a job issued in the future beyond the skew", () => {
    const signed = signJob(envelope(), privateKey, "job-1");
    assert.deepEqual(
      verifyJob(signed, { keys, hostId: HOST, now: new Date(ISSUED.getTime() - 61_000) }),
      { ok: false, reason: "not_yet_valid" },
    );
  });

  const tampers: Array<[string, (e: JobEnvelope) => JobEnvelope]> = [
    ["type", (e) => ({ ...e, type: "delete" })],
    ["hostId", (e) => ({ ...e, hostId: OTHER_HOST })],
    ["instanceId", (e) => ({ ...e, instanceId: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c77" })],
    ["attempt", (e) => ({ ...e, attempt: 2 })],
    ["expiresAt", (e) => ({ ...e, expiresAt: "2027-01-01T00:00:00.000Z" })],
    ["payload", (e) => ({ ...e, payload: { ...e.payload, privateIp: "10.20.0.5" } })],
    ["nested payload", (e) => ({ ...e, payload: { ...e.payload, spec: { name: "web", vcpu: 4 } } })],
  ];
  for (const [field, tamper] of tampers) {
    it(`rejects an envelope with a tampered ${field}`, () => {
      const signed = signJob(envelope(), privateKey, "job-1");
      const result = verifyJob(
        { ...signed, envelope: tamper(signed.envelope) },
        { keys, hostId: field === "hostId" ? OTHER_HOST : HOST, now: at },
      );
      assert.deepEqual(result, { ok: false, reason: "signature" });
    });
  }

  it("rejects an added envelope field and malformed input", () => {
    const signed = signJob(envelope(), privateKey, "job-1");
    const added = { ...signed, envelope: { ...signed.envelope, extra: 1 } };
    assert.deepEqual(verifyJob(added, { keys, hostId: HOST, now: at }), { ok: false, reason: "malformed" });
    assert.deepEqual(verifyJob(null, { keys, hostId: HOST, now: at }), { ok: false, reason: "malformed" });
    assert.deepEqual(verifyJob({ ...signed, signature: "x" }, { keys, hostId: HOST, now: at }), {
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an unknown key id", () => {
    const signed = signJob(envelope(), privateKey, "job-2");
    assert.deepEqual(verifyJob(signed, { keys, hostId: HOST, now: at }), { ok: false, reason: "unknown_key" });
  });

  it("round-trips keys through PEM", () => {
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const loaded = loadSigningKey(pkcs8);
    const pub = loadPublicKey(publicKeyPem(loaded));
    const signed = signJob(envelope(), loaded, "job-1");
    assert.equal(verifyJob(signed, { keys: new Map([["job-1", pub]]), hostId: HOST, now: at }).ok, true);
  });

  it("refuses non-Ed25519 keys without echoing them", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.throws(() => loadSigningKey(pem), (err: Error) => !err.message.includes("BEGIN"));
    assert.throws(() => loadSigningKey("garbage"), /not a valid private key/);
    assert.throws(() => loadPublicKey(pem), /must be a public key/);
  });
});

describe("agent request signatures", () => {
  const { privateKey, publicKey } = keyPair();
  const now = new Date("2026-10-07T10:00:00.000Z");
  const body = '{"a":1}';

  function signed(overrides: Partial<{ body: string; path: string; method: string }> = {}) {
    const headers = signAgentRequest({
      hostId: HOST,
      privateKey,
      method: "POST",
      path: "/v1/agent/jobs/claim",
      body,
      now,
    });
    return {
      headers,
      parsed: parseAgentHeaders(headers),
      method: overrides.method ?? "POST",
      path: overrides.path ?? "/v1/agent/jobs/claim",
      rawBody: overrides.body ?? body,
    };
  }

  it("verifies a valid request", () => {
    const req = signed();
    assert.ok(req.parsed);
    assert.equal(verifyAgentSignature({ ...req, headers: req.parsed, publicKey }), true);
  });

  it("detects a changed body, path or method", () => {
    for (const change of [{ body: '{"a":2}' }, { path: "/v1/agent/usage" }, { method: "PUT" }]) {
      const req = signed(change);
      assert.ok(req.parsed);
      assert.equal(verifyAgentSignature({ ...req, headers: req.parsed, publicKey }), false);
    }
  });

  it("rejects another host's key", () => {
    const req = signed();
    assert.ok(req.parsed);
    assert.equal(
      verifyAgentSignature({ ...req, headers: req.parsed, publicKey: keyPair().publicKey }),
      false,
    );
  });

  it("parses only well-formed headers", () => {
    const { headers } = signed();
    assert.equal(parseAgentHeaders({ ...headers, "x-sq-host-nonce": "XYZ" }), null);
    assert.equal(parseAgentHeaders({ ...headers, "x-sq-host-id": "not-a-uuid" }), null);
    const { ["x-sq-host-signature"]: _dropped, ...missing } = headers;
    assert.equal(parseAgentHeaders(missing), null);
    assert.equal(parseAgentHeaders({ ...headers, "x-sq-host-timestamp": ["1", "2"] }), null);
  });

  it("accepts timestamps within 300 s and refuses beyond", () => {
    const ts = String(now.getTime() / 1000);
    assert.equal(agentTimestampFresh(ts, new Date(now.getTime() + 300_000)), true);
    assert.equal(agentTimestampFresh(ts, new Date(now.getTime() - 300_000)), true);
    assert.equal(agentTimestampFresh(ts, new Date(now.getTime() + 301_000)), false);
    assert.equal(agentTimestampFresh(ts, new Date(now.getTime() - 301_000)), false);
  });
});
