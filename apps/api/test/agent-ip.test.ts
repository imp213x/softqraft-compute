/**
 * The agent allow-list (founder decision F3): enrolment and every
 * `/v1/agent/*` route accept only COMPUTE_AGENT_ALLOWED_IPS, checked against
 * the client IP the trusted-proxy rules resolve, before any other work.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_IP_EVENTS_PER_MINUTE, AGENT_IP_NOT_ALLOWED_EVENT } from "../src/modules/auth/index.js";
import { agentIpMatcher, loadConfig, parseAgentAllowedIps } from "../src/config.js";
import { ed25519, harness, pem, type Harness } from "./helpers.js";

const HOST_IP = "195.201.167.183";
const PROXY = "172.30.0.2";
const STRANGER = "203.0.113.9";

async function enrolFrom(
  h: Harness,
  remoteAddress: string,
  headers: Record<string, string> = {},
  name = "sq-node-01",
) {
  const { token } = await h.services.hosts.createEnrolmentToken({ hostName: name, now: h.clock.now() });
  const keys = ed25519();
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/agent/enrol",
    remoteAddress,
    headers,
    payload: {
      token,
      name,
      driver: "fake",
      publicKey: pem(keys.publicKey, "spki"),
      capacity: { vcpu: 4, memoryMb: 8192, diskGb: 120 },
    },
  });
  return { res, token };
}

async function ipEvents(h: Harness) {
  return (await h.store.transaction((tx) => tx.listSecurityEvents())).filter((e) => e.action === AGENT_IP_NOT_ALLOWED_EVENT);
}

describe("agent IP allow-list (COMPUTE_AGENT_ALLOWED_IPS)", () => {
  it("lets an allowed IP enrol and call the signed agent routes", async () => {
    const h = await harness({ env: { COMPUTE_AGENT_ALLOWED_IPS: `127.0.0.1, ${HOST_IP}` } });
    try {
      // inject() comes from 127.0.0.1 unless told otherwise.
      const agent = await h.enrolAgent();
      assert.equal(await agent.claim(), null);
      const { res } = await enrolFrom(h, HOST_IP, {}, "sq-node-02");
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await ipEvents(h)).length, 0);
    } finally {
      await h.close();
    }
  });

  it("refuses any other IP with 403 agent_ip_not_allowed before reading the request, and records the IP only", async () => {
    const h = await harness({ env: { COMPUTE_AGENT_ALLOWED_IPS: `${HOST_IP},10.9.0.0/16` } });
    try {
      const { res, token } = await enrolFrom(h, STRANGER);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, "agent_ip_not_allowed");
      assert.deepEqual(await h.store.transaction((tx) => tx.listHosts()), [], "no host was enrolled");

      // The signed routes are refused the same way, signed or not.
      for (const url of ["/v1/agent/jobs/claim", "/v1/agent/usage", "/v1/agent/jobs/00000000-0000-4000-8000-000000000000/heartbeat"]) {
        const r = await h.app.inject({ method: "POST", url, remoteAddress: STRANGER, payload: "{}" });
        assert.equal(r.statusCode, 403, url);
        assert.equal(r.json().error.code, "agent_ip_not_allowed", url);
      }
      // Refused before the body is parsed: even malformed JSON gets the same 403.
      const garbage = await h.app.inject({
        method: "POST",
        url: "/v1/agent/enrol",
        remoteAddress: STRANGER,
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });
      assert.equal(garbage.statusCode, 403);

      const events = await ipEvents(h);
      assert.equal(events.length, 5);
      for (const e of events) assert.deepEqual(e.detail, { ip: STRANGER });
      const text = JSON.stringify(events);
      assert.ok(!text.includes(token), "no enrolment token in the events");
      assert.ok(!text.includes("not json"), "no body in the events");

      // The token was never consumed: it still works from an allowed IP.
      const ok = await h.app.inject({
        method: "POST",
        url: "/v1/agent/enrol",
        remoteAddress: HOST_IP,
        payload: {
          token,
          name: "sq-node-01",
          driver: "fake",
          publicKey: pem(ed25519().publicKey, "spki"),
          capacity: { vcpu: 4, memoryMb: 8192, diskGb: 120 },
        },
      });
      assert.equal(ok.statusCode, 201, ok.body);
      // An address inside an allowed CIDR passes too.
      assert.equal((await enrolFrom(h, "10.9.200.1", {}, "sq-node-03")).res.statusCode, 201);
      // Other routes are not affected.
      assert.equal((await h.app.inject({ method: "GET", url: "/health", remoteAddress: STRANGER })).statusCode, 200);
    } finally {
      await h.close();
    }
  });

  it("caps the refusal events per IP per minute, but refuses every request", async () => {
    const h = await harness({ env: { COMPUTE_AGENT_ALLOWED_IPS: HOST_IP } });
    try {
      for (let i = 0; i < AGENT_IP_EVENTS_PER_MINUTE + 5; i += 1) {
        const r = await h.app.inject({ method: "POST", url: "/v1/agent/jobs/claim", remoteAddress: STRANGER });
        assert.equal(r.statusCode, 403);
      }
      assert.equal((await ipEvents(h)).length, AGENT_IP_EVENTS_PER_MINUTE);
    } finally {
      await h.close();
    }
  });

  it("ignores X-Forwarded-For from an untrusted peer, and resolves it from a trusted proxy", async () => {
    const h = await harness({
      env: { COMPUTE_AGENT_ALLOWED_IPS: HOST_IP, COMPUTE_TRUSTED_PROXY_CIDRS: "172.30.0.0/24" },
    });
    try {
      // A spoofed header from a peer that is not a trusted proxy does not pass.
      const spoofed = await enrolFrom(h, STRANGER, { "x-forwarded-for": HOST_IP });
      assert.equal(spoofed.res.statusCode, 403);
      // A trusted proxy cannot launder a spoofed hop either: the right-most
      // untrusted address is the client.
      const chained = await enrolFrom(h, PROXY, { "x-forwarded-for": `${HOST_IP}, ${STRANGER}` });
      assert.equal(chained.res.statusCode, 403);
      // The proxy itself is not a host.
      const bare = await enrolFrom(h, PROXY);
      assert.equal(bare.res.statusCode, 403);
      assert.deepEqual(
        (await ipEvents(h)).map((e) => e.detail?.ip),
        [STRANGER, STRANGER, PROXY],
      );
      // The real path: the tunnel connector forwards the host's address.
      const real = await enrolFrom(h, PROXY, { "x-forwarded-for": HOST_IP });
      assert.equal(real.res.statusCode, 201, real.res.body);
    } finally {
      await h.close();
    }
  });

  it("allows any IP when the list is empty (development and tests)", async () => {
    const h = await harness();
    try {
      const { res } = await enrolFrom(h, STRANGER);
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await ipEvents(h)).length, 0);
    } finally {
      await h.close();
    }
  });

  it("is required in production with federation on, and validated like the other settings", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x@localhost/x",
      COMPUTE_JOB_SIGNING_KEY_PEM: pem(ed25519().privateKey, "pkcs8"),
      CLOUD_FEDERATION_ENABLED: "true",
      CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({ k: pem(ed25519().publicKey, "spki") }),
      CLOUD_ORIGIN: "https://cloud.example",
      COMPUTE_PUBLIC_URL: "https://compute.example",
    };
    assert.throws(() => loadConfig(base), /COMPUTE_AGENT_ALLOWED_IPS is required/);
    assert.throws(() => loadConfig({ ...base, COMPUTE_AGENT_ALLOWED_IPS: " , " }), /COMPUTE_AGENT_ALLOWED_IPS is required/);
    assert.deepEqual(loadConfig({ ...base, COMPUTE_AGENT_ALLOWED_IPS: HOST_IP }).agentAllowedIps, [HOST_IP]);
    // Production with federation off (agent routes and probes only) and development may leave it empty.
    assert.deepEqual(loadConfig({ ...base, CLOUD_FEDERATION_ENABLED: "false" }).agentAllowedIps, []);
    assert.deepEqual(
      loadConfig({ ...base, NODE_ENV: "development", COMPUTE_STORE: "memory" }).agentAllowedIps,
      [],
    );

    for (const bad of ["evil", "195.201.167.300", "10.0.0.0/33", "10.0.0.0/0", "::/0", "10.0.0.0/8/1", "10.0.0.0/x", "2001:db8::/129"]) {
      assert.throws(() => parseAgentAllowedIps(bad), /COMPUTE_AGENT_ALLOWED_IPS/, bad);
      // The message names the variable, never the value.
      assert.throws(() => parseAgentAllowedIps(bad), (err: Error) => !err.message.includes(bad), bad);
    }
    assert.deepEqual(parseAgentAllowedIps(" 195.201.167.183 , 10.0.0.0/8,2001:db8::/32 "), [
      "195.201.167.183",
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
  });

  it("matches addresses, CIDRs, IPv6 and IPv4-mapped IPv6", () => {
    const allowed = agentIpMatcher(["195.201.167.183", "10.9.0.0/16", "2001:db8::/32"]);
    assert.equal(allowed("195.201.167.183"), true);
    assert.equal(allowed("::ffff:195.201.167.183"), true);
    assert.equal(allowed("195.201.167.184"), false);
    assert.equal(allowed("10.9.255.255"), true);
    assert.equal(allowed("10.10.0.1"), false);
    assert.equal(allowed("2001:db8:1::5"), true);
    assert.equal(allowed("2001:db9::5"), false);
    assert.equal(allowed("not-an-ip"), false);
    assert.equal(allowed(""), false);
    assert.equal(agentIpMatcher([])("203.0.113.9"), true);
  });
});
