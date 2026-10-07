import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  conformanceKeyRing,
  loadBundledVectors,
  packageTarget,
  runConformance,
  summarize,
} from "@softqraft/federation";
import { verifyCloudSigned } from "../src/modules/auth/index.js";
import { hashToken } from "../src/modules/hosts/index.js";
import { MemoryComputeStore } from "../src/store/index.js";
import {
  allowOperators,
  baseSpec,
  ed25519,
  harness,
  idempotencyKey,
  instanceOf,
  OTHER_PROJECT,
  PROJECT,
  type FakeAgent,
  type Harness,
} from "./helpers.js";

describe("probes", () => {
  it("answers /health and /ready", async () => {
    const h = await harness();
    try {
      assert.deepEqual((await h.app.inject({ url: "/health" })).json(), { status: "ok" });
      const ready = await h.app.inject({ url: "/ready" });
      assert.equal(ready.statusCode, 200);
      assert.equal(ready.json().status, "ready");
    } finally {
      await h.close();
    }
  });

  it("reports not ready when the store cannot answer", async () => {
    const store = new MemoryComputeStore();
    store.ping = async () => {
      throw new Error("down");
    };
    const h = await harness({ store });
    try {
      const ready = await h.app.inject({ url: "/ready" });
      assert.equal(ready.statusCode, 503);
      assert.equal(ready.json().status, "not_ready");
    } finally {
      await h.close();
    }
  });
});

describe("federation switched off", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ federation: false });
  });
  after(() => h.close());

  for (const [method, url] of [
    ["POST", `/v1/projects/${PROJECT}/instances`],
    ["GET", `/v1/projects/${PROJECT}/instances`],
    ["GET", `/v1/projects/${PROJECT}/instances/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11`],
    ["DELETE", `/v1/projects/${PROJECT}/instances/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11`],
    ["POST", `/v1/projects/${PROJECT}/instances/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11/actions`],
    ["GET", "/v1/images"],
    ["GET", `/v1/projects/${PROJECT}/usage`],
    ["GET", "/v1/fleet/hosts"],
    ["POST", "/v1/fleet/hosts/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11/drain"],
    ["POST", "/v1/fleet/enrolment-tokens"],
  ] as const) {
    it(`${method} ${url.replace(PROJECT, ":projectId")} is 404, as if unrouted`, async () => {
      const signed = await h.cloud(method, url, method === "GET" || method === "DELETE" ? undefined : {});
      assert.equal(signed.statusCode, 404);
      const unknown = await h.app.inject({ method, url: "/v1/no-such-route" });
      assert.equal(unknown.statusCode, 404);
      assert.equal(signed.json().error.code, unknown.json().error.code);
    });
  }

  it("still serves agent routes and probes", async () => {
    assert.equal((await h.app.inject({ url: "/health" })).statusCode, 200);
    const enrol = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: {} });
    assert.equal(enrol.statusCode, 400);
  });
});

describe("Cloud-signed requests (audience compute)", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  it("serves the image catalogue", async () => {
    const res = await h.cloud("GET", "/v1/images");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().images.map((i: { id: string }) => i.id),
      ["debian-12", "ubuntu-24.04"],
    );
  });

  it("rejects an unsigned request as malformed", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/images" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "federation_malformed");
  });

  it("rejects a valid signature made for another audience", async () => {
    const headers = h.signCloud("GET", "/v1/images", "", "realtime-media");
    const res = await h.app.inject({ method: "GET", url: "/v1/images", headers });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "federation_signature");
  });

  it("rejects a replayed nonce, a stale timestamp and an unknown key", async () => {
    const headers = h.signCloud("GET", "/v1/images", "");
    const first = await h.app.inject({ method: "GET", url: "/v1/images", headers });
    assert.equal(first.statusCode, 200);
    const replay = await h.app.inject({ method: "GET", url: "/v1/images", headers });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, "federation_replay");

    const old = h.signCloud("GET", "/v1/images", "");
    h.clock.advance(61);
    const stale = await h.app.inject({ method: "GET", url: "/v1/images", headers: old });
    assert.equal(stale.json().error.code, "federation_stale");

    const unknown = { ...h.signCloud("GET", "/v1/images", ""), "X-SQ-Cloud-Key-Id": "nobody" };
    const res = await h.app.inject({ method: "GET", url: "/v1/images", headers: unknown });
    assert.equal(res.json().error.code, "federation_unknown_key");
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ ...baseSpec, name: "tamper" });
    const headers = h.signCloud("POST", `/v1/projects/${PROJECT}/instances`, body);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT}/instances`,
      payload: body.replace('"vcpu":1', '"vcpu":4'),
      headers: { ...headers, "content-type": "application/json", "idempotency-key": idempotencyKey() },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "federation_signature");
  });

  it("requires Idempotency-Key on create", async () => {
    const res = await h.cloud("POST", `/v1/projects/${PROJECT}/instances`, baseSpec);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "idempotency_key_required");
    const bad = await h.cloud("POST", `/v1/projects/${PROJECT}/instances`, baseSpec, { "idempotency-key": "short" });
    assert.equal(bad.json().error.code, "idempotency_key_invalid");
  });

  it("lets only allow-listed projects create", async () => {
    const res = await h.createInstance({ name: "outsider" }, idempotencyKey(), OTHER_PROJECT);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "project_not_allowed");
  });

  it("refuses everything when the allow-list is empty (the default)", async () => {
    const closed = await harness({ env: { COMPUTE_ALLOWED_PROJECTS: "" } });
    try {
      const res = await closed.createInstance();
      assert.equal(res.statusCode, 403);
    } finally {
      await closed.close();
    }
  });

  it("validates the spec, image and disk, naming fields but not values", async () => {
    const bad = await h.createInstance({ name: "Bad_Name", vcpu: 9 });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "validation_failed");
    assert.match(bad.json().error.message, /name/);
    assert.ok(!bad.body.includes("Bad_Name"));
    const image = await h.createInstance({ name: "img", imageId: "windows-11" });
    assert.equal(image.json().error.code, "unknown_image");
    const json = await h.app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT}/instances`,
      payload: "{not json",
      headers: {
        ...h.signCloud("POST", `/v1/projects/${PROJECT}/instances`, "{not json"),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey(),
      },
    });
    assert.equal(json.statusCode, 400);
    assert.equal(json.json().error.code, "invalid_json");
  });

  it("refuses a duplicate live name in a project", async () => {
    assert.equal((await h.createInstance({ name: "twin" })).statusCode, 201);
    const res = await h.createInstance({ name: "twin" });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "name_taken");
  });

  it("hides other projects' instances", async () => {
    const mine = instanceOf(await h.createInstance({ name: "mine" }));
    const res = await h.cloud("GET", `/v1/projects/${OTHER_PROJECT}/instances/${mine.id}`);
    assert.equal(res.statusCode, 404);
    const del = await h.cloud("DELETE", `/v1/projects/${OTHER_PROJECT}/instances/${mine.id}`);
    assert.equal(del.statusCode, 404);
    const notUuid = await h.cloud("GET", `/v1/projects/${PROJECT}/instances/not-a-uuid`);
    assert.equal(notUuid.statusCode, 404);
  });

  it("refuses start on a pending instance and unknown actions", async () => {
    const inst = instanceOf(await h.createInstance({ name: "idle", memoryMb: 512 }));
    const start = await h.cloud("POST", `/v1/projects/${PROJECT}/instances/${inst.id}/actions`, { action: "start" });
    assert.equal(start.statusCode, 409);
    const reboot = await h.cloud("POST", `/v1/projects/${PROJECT}/instances/${inst.id}/actions`, { action: "reboot" });
    assert.equal(reboot.statusCode, 400);
  });

  it("validates usage ranges", async () => {
    const res = await h.cloud("GET", `/v1/projects/${PROJECT}/usage?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z`);
    assert.equal(res.statusCode, 400);
    const ok = await h.cloud("GET", `/v1/projects/${PROJECT}/usage`);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json().records, []);
  });
});

describe("federation conformance vectors (contract §9)", () => {
  it("passes every shared vector for audience compute", async () => {
    const vectors = await loadBundledVectors();
    const keyRing = conformanceKeyRing(vectors);
    const reference = packageTarget("compute", vectors);
    const results = await runConformance(
      {
        ...reference,
        audience: "compute",
        verify: async (req) => {
          const result = await verifyCloudSigned(keyRing, {
            method: req.method,
            path: req.path,
            rawBody: req.rawBody,
            headers: req.headers,
            now: req.now,
            nonceStore: req.nonceStore,
          });
          return result.ok ? { ok: true, keyId: result.keyId } : { ok: false, code: result.code, status: result.status };
        },
      },
      vectors,
    );
    const summary = summarize(results);
    const failures = results.filter((r) => !r.pass).map((r) => `${r.case}: ${r.detail}`);
    assert.equal(summary.failed, 0, failures.join("\n"));
    assert.ok(summary.total > 20, `ran ${summary.total} cases`);
    process.stdout.write(`# federation conformance: ${summary.passed}/${summary.total} cases passed\n`);
    assert.ok(results.some((r) => /audience/i.test(r.case)), "cross-audience cases ran");
  });
});

describe("agent-signed requests", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  it("activates an enrolled host on its first verified request", async () => {
    const agent = await h.enrolAgent("first-contact");
    let [host] = (await h.services.hosts.list()).filter((x) => x.id === agent.hostId);
    assert.equal(host!.state, "enrolled");
    assert.equal(host!.lastSeenAt, null);
    assert.equal(await agent.claim(), null);
    [host] = (await h.services.hosts.list()).filter((x) => x.id === agent.hostId);
    assert.equal(host!.state, "active");
    assert.equal(host!.lastSeenAt, h.clock.now().toISOString());
  });

  it("rejects missing headers, unknown hosts, stale timestamps, bad signatures and replays", async () => {
    const agent = await h.enrolAgent("checked");
    const path = "/v1/agent/jobs/claim";

    const none = await h.app.inject({ method: "POST", url: path });
    assert.equal(none.json().error.code, "agent_malformed");

    const unknown = await agent.request("POST", path, undefined, (hd) => {
      hd["x-sq-host-id"] = "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11";
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().error.code, "agent_unknown_host");

    const stale = await agent.request("POST", path, undefined, (hd) => {
      hd["x-sq-host-timestamp"] = String(Math.floor(h.clock.now().getTime() / 1000) - 301);
    });
    assert.equal(stale.json().error.code, "agent_stale");

    const edge = await agent.request("POST", path, undefined, (hd) => {
      hd["x-sq-host-timestamp"] = String(Math.floor(h.clock.now().getTime() / 1000) - 300);
    });
    assert.equal(edge.json().error.code, "agent_signature", "300 s is fresh; the changed timestamp breaks the signature");

    const body = { samples: [] };
    const tampered = await h.app.inject({
      method: "POST",
      url: "/v1/agent/usage",
      payload: JSON.stringify({ samples: [{ x: 1 }] }),
      headers: {
        "content-type": "application/json",
        ...agent.sign("POST", "/v1/agent/usage", JSON.stringify(body)),
      },
    });
    assert.equal(tampered.json().error.code, "agent_signature");

    const nonce = "abcdefabcdefabcdefabcdefabcdef01";
    const once = await agentWithNonce(agent, path, nonce);
    assert.equal(once.statusCode, 200, once.body);
    const twice = await agentWithNonce(agent, path, nonce);
    assert.equal(twice.statusCode, 401);
    assert.equal(twice.json().error.code, "agent_replay");
  });

  it("does not let one host touch another host's job", async () => {
    const a = await h.enrolAgent("host-one");
    const b = await h.enrolAgent("host-two");
    await a.claim();
    await b.claim();
    for (const x of await h.services.hosts.list()) if (x.id !== a.hostId) await h.services.hosts.drain(x.id);
    await h.createInstance({ name: "only-a", memoryMb: 512 });
    const job = await a.claim();
    assert.ok(job);
    const steal = await b.request("POST", `/v1/agent/jobs/${job.envelope.id}/complete`, { attempt: 1 });
    assert.equal(steal.statusCode, 404);
    assert.equal(steal.json().error.code, "job_not_found");
    assert.equal(await b.claim(), null);
  });
});

describe("fleet routes", () => {
  it("deny a valid Cloud signature by default (no operator-role claim exists)", async () => {
    const h = await harness();
    try {
      for (const [method, url] of [
        ["GET", "/v1/fleet/hosts"],
        ["POST", "/v1/fleet/hosts/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11/drain"],
        ["POST", "/v1/fleet/enrolment-tokens"],
      ] as const) {
        const res = await h.cloud(method, url, method === "POST" ? {} : undefined);
        assert.equal(res.statusCode, 403, `${method} ${url}`);
        assert.equal(res.json().error.code, "operator_role_required");
      }
      const unsigned = await h.app.inject({ method: "GET", url: "/v1/fleet/hosts" });
      assert.equal(unsigned.statusCode, 400, "the Cloud signature is checked first");
    } finally {
      await h.close();
    }
  });

  it("work with an operator authoriser: tokens, listing and drain", async () => {
    const logs: string[] = [];
    const h = await harness({ operatorAuthorizer: allowOperators, logs });
    try {
      const created = await h.cloud("POST", "/v1/fleet/enrolment-tokens", { hostName: "sq-node-01", ttlSeconds: 600 });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.headers["cache-control"], "no-store");
      const { token, expiresAt } = created.json();
      assert.match(token, /^sqet_[A-Za-z0-9_-]{43}$/);
      assert.equal(expiresAt, new Date(h.clock.now().getTime() + 600_000).toISOString());
      // Stored only as its SHA-256 hash.
      assert.equal(hashToken(token), createHash("sha256").update(token).digest("hex"));
      const consumed = await h.store.transaction((tx) => tx.consumeEnrolmentToken(token, h.clock.now()));
      assert.equal(consumed, null, "the clear token is not a key in the store");

      const { publicKey } = ed25519();
      const enrol = await h.app.inject({
        method: "POST",
        url: "/v1/agent/enrol",
        payload: {
          token,
          name: "sq-node-01",
          driver: "fake",
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
          capacity: { vcpu: 4, memoryMb: 8192, diskGb: 120 },
        },
      });
      assert.equal(enrol.statusCode, 201, enrol.body);
      const { hostId, jobSigningKeys } = enrol.json();
      assert.deepEqual(Object.keys(jobSigningKeys), ["job-1"]);
      assert.match(jobSigningKeys["job-1"], /BEGIN PUBLIC KEY/);

      const list = await h.cloud("GET", "/v1/fleet/hosts");
      assert.equal(list.json().hosts[0].name, "sq-node-01");
      assert.deepEqual(list.json().hosts[0].allocated, { vcpu: 0, memoryMb: 0, diskGb: 0 });

      const drain = await h.cloud("POST", `/v1/fleet/hosts/${hostId}/drain`);
      assert.equal(drain.json().host.state, "draining");
      const again = await h.cloud("POST", `/v1/fleet/hosts/${hostId}/drain`);
      assert.equal(again.statusCode, 200);
      const missing = await h.cloud("POST", "/v1/fleet/hosts/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11/drain");
      assert.equal(missing.statusCode, 404);

      const enrolUnknownDriver = await h.app.inject({
        method: "POST",
        url: "/v1/agent/enrol",
        payload: {
          token: (await h.services.hosts.createEnrolmentToken({ now: h.clock.now() })).token,
          name: "pve-1",
          driver: "proxmox",
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
          capacity: { vcpu: 4, memoryMb: 8192, diskGb: 120 },
        },
      });
      assert.equal(enrolUnknownDriver.json().error.code, "unknown_driver");

      // Nothing secret reaches the logs.
      const text = logs.join("\n");
      assert.ok(logs.length > 0, "logging was on");
      assert.ok(!text.includes(token), "enrolment token not logged");
      assert.ok(!text.includes("sqet_"), "no enrolment token prefix in logs");
      assert.ok(!/x-sq-cloud-signature/i.test(text), "no signature header in logs");
      assert.ok(!text.includes("PUBLIC KEY") && !text.includes("PRIVATE KEY"), "no key material in logs");
    } finally {
      await h.close();
    }
  });
});

describe("job envelopes on the wire", () => {
  it("are signed for the claiming host and carry the create payload", async () => {
    const logs: string[] = [];
    const h = await harness({ logs });
    try {
      const agent = await h.enrolAgent();
      await agent.claim();
      const inst = instanceOf(await h.createInstance({ name: "wire" }));
      const job = await agent.claim();
      assert.ok(job);
      assert.equal(job.keyId, "job-1");
      assert.equal(job.envelope.hostId, agent.hostId);
      assert.equal(job.envelope.instanceId, inst.id);
      assert.equal(job.envelope.type, "create");
      assert.deepEqual(job.envelope.payload, {
        spec: { ...baseSpec, name: "wire" },
        privateIp: inst.privateIp,
        network: { cidr: "10.30.0.0/24", gateway: "10.30.0.1" },
      });
      assert.equal(
        new Date(job.envelope.expiresAt).getTime() - new Date(job.envelope.issuedAt).getTime(),
        300_000,
      );
      const text = logs.join("\n");
      assert.ok(!text.includes(job.signature), "signature not logged");
      assert.ok(!text.includes(inst.privateIp!), "envelope payload not logged");
    } finally {
      await h.close();
    }
  });
});

async function agentWithNonce(agent: FakeAgent, path: string, nonce: string) {
  return agent.request("POST", path, undefined, undefined, nonce);
}
