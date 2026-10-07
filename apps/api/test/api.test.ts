import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { CONSOLE_ROLES as KIT_CONSOLE_ROLES, OPERATOR_ROLES as KIT_OPERATOR_ROLES, hashGrant } from "@softqraft/federation";
import { CONSOLE_ROLES, OPERATOR_ROLES } from "@softqraft/compute-contracts";
import { hashToken } from "../src/modules/hosts/index.js";
import { MemoryComputeStore } from "../src/store/index.js";
import {
  baseSpec,
  ed25519,
  grantFrom,
  harness,
  idempotencyKey,
  instanceOf,
  ORIGIN,
  OTHER_SI,
  principal,
  SI,
  tokenFrom,
  type FakeAgent,
  type Harness,
} from "./helpers.js";

const NO_SUCH = "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11";

function cookieLine(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const lines = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  return lines.find((l) => l.startsWith(`${name}=`)) ?? "";
}

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

const FEDERATED_ROUTES = [
  ["PUT", `/cloud/v1/service-instances/${SI}`],
  ["GET", `/cloud/v1/service-instances/${SI}`],
  ["GET", `/cloud/v1/service-instances/${SI}/health`],
  ["POST", `/cloud/v1/service-instances/${SI}/console-launches`],
  ["GET", `/cloud/v1/service-instances/${SI}/instances`],
  ["GET", `/cloud/v1/service-instances/${SI}/usage`],
  ["POST", "/cloud/v1/principals/user_x/revocations"],
  ["POST", "/cloud/v1/operator-launches"],
  ["POST", "/console/v1/auth/cloud-launch/redeem"],
  ["POST", "/console/v1/auth/logout"],
  ["GET", "/console/v1/auth/me"],
  ["GET", "/console/v1/instances"],
  ["POST", "/console/v1/instances"],
  ["GET", "/console/v1/images"],
  ["GET", "/console/v1/usage"],
  ["POST", "/admin/v1/auth/cloud-launch/redeem"],
  ["GET", "/admin/v1/auth/me"],
  ["GET", "/admin/v1/fleet/hosts"],
  ["POST", `/admin/v1/fleet/hosts/${NO_SUCH}/disable`],
  ["POST", "/admin/v1/fleet/enrolment-tokens"],
  ["GET", "/admin/v1/fleet/instances"],
] as const;

describe("federation switched off", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ federation: false });
  });
  after(() => h.close());

  for (const [method, url] of FEDERATED_ROUTES) {
    it(`${method} ${url} is 404, as if unrouted`, async () => {
      const signed = await h.cloud(method, url, method === "GET" ? undefined : {});
      assert.equal(signed.statusCode, 404);
      assert.equal(signed.json().error.code, "not_found");
    });
  }

  it("still serves agent routes and probes", async () => {
    assert.equal((await h.app.inject({ url: "/health" })).statusCode, 200);
    const enrol = await h.app.inject({ method: "POST", url: "/v1/agent/enrol", payload: {} });
    assert.equal(enrol.statusCode, 400);
  });
});

describe("operator launch switched off", () => {
  it("leaves /cloud/v1/operator-launches and every /admin route unrouted", async () => {
    const h = await harness({ env: { CLOUD_OPERATOR_LAUNCH_ENABLED: "false" } });
    try {
      const launch = await h.cloud("POST", "/cloud/v1/operator-launches", {
        principal: principal("user_staff"),
        role: "admin",
        returnPath: "/admin/fleet",
      });
      assert.equal(launch.statusCode, 404);
      for (const [method, url] of FEDERATED_ROUTES.filter(([, u]) => u.startsWith("/admin/"))) {
        const res = await h.browser(null, method, url, method === "GET" ? undefined : {});
        assert.equal(res.statusCode, 404, `${method} ${url}`);
      }
      // Console launches still work.
      await h.consoleSession("viewer");
    } finally {
      await h.close();
    }
  });
});

describe("C1a routes are gone", () => {
  it("answers 404 for /v1/projects, /v1/images and /v1/fleet, signed or not", async () => {
    const h = await harness();
    try {
      for (const [method, url] of [
        ["GET", "/v1/projects/22222222-2222-4222-8222-222222222222/instances"],
        ["POST", "/v1/projects/22222222-2222-4222-8222-222222222222/instances"],
        ["GET", "/v1/projects/22222222-2222-4222-8222-222222222222/usage"],
        ["GET", "/v1/images"],
        ["GET", "/v1/fleet/hosts"],
        ["POST", `/v1/fleet/hosts/${NO_SUCH}/drain`],
        ["POST", "/v1/fleet/enrolment-tokens"],
      ] as const) {
        const res = await h.cloud(method, url, method === "POST" ? {} : undefined);
        assert.equal(res.statusCode, 404, `${method} ${url}`);
      }
    } finally {
      await h.close();
    }
  });
});

describe("Cloud-signed requests (audience compute)", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());
  const path = `/cloud/v1/service-instances/${SI}`;

  it("rejects an unsigned request as malformed", async () => {
    const res = await h.app.inject({ method: "GET", url: path });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "federation_malformed");
  });

  it("rejects a valid signature made for another audience", async () => {
    const headers = h.signCloud("GET", path, "", "realtime-media");
    const res = await h.app.inject({ method: "GET", url: path, headers });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "federation_signature");
  });

  it("rejects a replayed nonce, a stale timestamp and an unknown key", async () => {
    const headers = h.signCloud("GET", path, "");
    assert.equal((await h.app.inject({ method: "GET", url: path, headers })).statusCode, 200);
    const replay = await h.app.inject({ method: "GET", url: path, headers });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, "federation_replay");

    const old = h.signCloud("GET", path, "");
    h.clock.advance(61);
    const stale = await h.app.inject({ method: "GET", url: path, headers: old });
    assert.equal(stale.json().error.code, "federation_stale");

    const unknown = { ...h.signCloud("GET", path, ""), "X-SQ-Cloud-Key-Id": "nobody" };
    const res = await h.app.inject({ method: "GET", url: path, headers: unknown });
    assert.equal(res.json().error.code, "federation_unknown_key");
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({
      cloudOrganisationId: "11111111-1111-4111-8111-111111111111",
      cloudProjectId: "22222222-2222-4222-8222-222222222222",
      displayName: "A",
      regionId: "eu-central",
    });
    const headers = h.signCloud("PUT", "/cloud/v1/service-instances/si-tamper", body);
    const res = await h.app.inject({
      method: "PUT",
      url: "/cloud/v1/service-instances/si-tamper",
      payload: body.replace('"A"', '"B"'),
      headers: { ...headers, "content-type": "application/json" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "federation_signature");
  });

  it("serves read-only instances and usage for a service instance", async () => {
    const created = instanceOf(await h.createInstance({ name: "listed" }));
    const list = await h.cloud("GET", `/cloud/v1/service-instances/${SI}/instances`);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().instances.map((i: { id: string }) => i.id), [created.id]);
    const other = await h.cloud("GET", `/cloud/v1/service-instances/${OTHER_SI}/instances`);
    assert.deepEqual(other.json().instances, []);
    const unknown = await h.cloud("GET", "/cloud/v1/service-instances/nope/instances");
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, "federation_unknown_instance");

    const usage = await h.cloud("GET", `/cloud/v1/service-instances/${SI}/usage`);
    assert.equal(usage.statusCode, 200);
    assert.equal(usage.json().serviceInstanceId, SI);
    assert.deepEqual(usage.json().usage, [], "Cloud reads records from `usage`");
    assert.equal(usage.json().records, undefined);
    const bad = await h.cloud(
      "GET",
      `/cloud/v1/service-instances/${SI}/usage?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z`,
    );
    assert.equal(bad.json().error.code, "invalid_range");
  });

  it("has no write route for instances on the Cloud side", async () => {
    const res = await h.cloud("POST", `/cloud/v1/service-instances/${SI}/instances`, baseSpec);
    assert.equal(res.statusCode, 404);
  });
});

describe("service instances (§3.1, §3.4, §7.1)", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  it("provisions once (201), then answers 200 with the same body", async () => {
    const first = await h.provision("si-new-1");
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(first.json(), {
      serviceInstanceId: "si-new-1",
      mediaTenantId: `cld_${createHash("sha256").update("si-new-1").digest("hex").slice(0, 12)}`,
      status: "active",
      connection: { gatewayUrl: ORIGIN, regionId: "eu-central" },
    });
    const again = await h.provision("si-new-1");
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), first.json());
  });

  it("refuses the same id for another project (409 federation_link_conflict)", async () => {
    const res = await h.provision("si-new-1", "44444444-4444-4444-8444-444444444444");
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "federation_link_conflict");
  });

  it("validates the id, the body and the region", async () => {
    const badId = await h.cloud("PUT", "/cloud/v1/service-instances/bad%20id", {});
    assert.equal(badId.statusCode, 400);
    const badBody = await h.cloud("PUT", "/cloud/v1/service-instances/si-x", { cloudProjectId: "nope" });
    assert.equal(badBody.json().error.code, "validation_failed");
    const region = await h.cloud("PUT", "/cloud/v1/service-instances/si-x", {
      cloudOrganisationId: "11111111-1111-4111-8111-111111111111",
      cloudProjectId: "22222222-2222-4222-8222-222222222222",
      displayName: "X",
      regionId: "us-east",
    });
    assert.equal(region.statusCode, 400);
    assert.equal(region.json().error.code, "validation_failed");
    assert.equal(region.json().error.message, "regionId must be eu-central");
    const stored = await h.store.transaction((tx) => tx.getServiceInstance("si-new-1"));
    assert.equal(stored?.regionId, "eu-central", "the region is stored on the service instance");
  });

  it("looks a service instance up, and 404s an unknown one", async () => {
    const res = await h.cloud("GET", `/cloud/v1/service-instances/${SI}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().serviceInstanceId, SI);
    assert.match(res.json().mediaTenantId, /^cld_[0-9a-f]{12}$/);
    assert.equal(res.json().status, "active");
    assert.equal(res.json().regionId, "eu-central");
    assert.equal(res.json().cloudProjectId, "22222222-2222-4222-8222-222222222222");
    const missing = await h.cloud("GET", "/cloud/v1/service-instances/si-missing");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "federation_unknown_instance");
  });

  it("reports health: degraded with no host, operational with a recently seen active host", async () => {
    const first = await h.cloud("GET", `/cloud/v1/service-instances/${SI}/health`);
    assert.deepEqual(first.json(), { status: "degraded", checkedAt: h.clock.now().toISOString() });
    const agent = await h.enrolAgent("health-host");
    await agent.claim();
    const ok = await h.cloud("GET", `/cloud/v1/service-instances/${SI}/health`);
    assert.equal(ok.json().status, "operational");
    h.clock.advance(301);
    const quiet = await h.cloud("GET", `/cloud/v1/service-instances/${SI}/health`);
    assert.equal(quiet.json().status, "degraded");
    const missing = await h.cloud("GET", "/cloud/v1/service-instances/si-missing/health");
    assert.equal(missing.statusCode, 404);
  });
});

describe("Console launch and redemption (§3.2, §4)", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  const launch = (body: Record<string, unknown>, si = SI) =>
    h.cloud("POST", `/cloud/v1/service-instances/${si}/console-launches`, {
      principal: principal("user_a"),
      role: "developer",
      returnPath: "/console/instances",
      ...body,
    });

  it("returns a /console/launch URL with an sqlg_ grant in the fragment, valid 60 s", async () => {
    const res = await launch({});
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.headers["cache-control"], "no-store");
    const { launchUrl, expiresAt } = res.json();
    assert.match(launchUrl, /^http:\/\/compute\.test\/console\/launch#grant=sqlg_[A-Za-z0-9_-]{43}$/);
    assert.equal(expiresAt, new Date(h.clock.now().getTime() + 60_000).toISOString());
  });

  it("refuses an unknown service instance and unsafe return paths", async () => {
    const unknown = await launch({}, "si-missing");
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, "federation_unknown_instance");
    for (const returnPath of [
      "/admin/x",
      "//evil.example/console/",
      "/console/../admin",
      "https://evil.example/console/",
      "/console\\x",
    ]) {
      const res = await launch({ returnPath });
      assert.equal(res.statusCode, 400, returnPath);
      assert.equal(res.json().error.code, "federation_return_path");
    }
    const role = await launch({ role: "owner" });
    assert.equal(role.statusCode, 400);
  });

  it("redeems once into an HttpOnly, SameSite=Strict, /console cookie for 8 hours", async () => {
    const grant = grantFrom((await launch({ returnPath: "/console/instances?x=1" })).json().launchUrl);
    const res = await h.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", { grant });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { returnPath: "/console/instances?x=1" });
    const line = cookieLine(res, "sq_console_session");
    assert.match(
      line,
      /^sq_console_session=sqcs_[A-Za-z0-9_-]{43}; Path=\/console; Max-Age=28800; HttpOnly; SameSite=Strict$/,
    );
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["cache-control"], "no-store");
    const again = await h.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", { grant });
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().error.code, "launch_invalid");
  });

  it("sets Secure when the public URL is https", async () => {
    const s = await harness({ env: { COMPUTE_PUBLIC_URL: "https://compute.test" } });
    try {
      const l = await s.cloud("POST", `/cloud/v1/service-instances/${SI}/console-launches`, {
        principal: principal("user_s"),
        role: "viewer",
        returnPath: "/console/",
      });
      const res = await s.browser(
        null,
        "POST",
        "/console/v1/auth/cloud-launch/redeem",
        { grant: grantFrom(l.json().launchUrl) },
        { origin: "https://compute.test" },
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.match(cookieLine(res, "sq_console_session"), /; HttpOnly; Secure; SameSite=Strict$/);
    } finally {
      await s.close();
    }
  });

  it("gives one generic 401 for unknown, expired, malformed and operator grants", async () => {
    const expired = grantFrom((await launch({})).json().launchUrl);
    h.clock.advance(60);
    const operator = grantFrom(
      (
        await h.cloud("POST", "/cloud/v1/operator-launches", {
          principal: principal("user_a"),
          role: "admin",
          returnPath: "/admin/x",
        })
      ).json().launchUrl,
    );
    for (const grant of [expired, `sqlg_${"A".repeat(43)}`, "sqlg_short", operator, `sqlk_${"A".repeat(43)}`, 42, undefined]) {
      const res = await h.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", { grant });
      assert.equal(res.statusCode, 401, String(grant));
      assert.equal(res.json().error.code, "launch_invalid");
    }
  });

  it("requires the service's own Origin to redeem", async () => {
    const grant = grantFrom((await launch({})).json().launchUrl);
    const cross = await h.browser(
      null,
      "POST",
      "/console/v1/auth/cloud-launch/redeem",
      { grant },
      { origin: "https://evil.example" },
    );
    assert.equal(cross.statusCode, 403);
    assert.equal(cross.json().error.code, "cross_origin");
    const none = await h.app.inject({ method: "POST", url: "/console/v1/auth/cloud-launch/redeem", payload: { grant } });
    assert.equal(none.statusCode, 403);
    const ok = await h.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", { grant });
    assert.equal(ok.statusCode, 200, "the refused attempts did not use the grant");
  });

  it("stores grants and session tokens only as SHA-256 hashes", async () => {
    const grant = grantFrom((await launch({})).json().launchUrl);
    const res = await h.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", { grant });
    const token = tokenFrom(res, "sq_console_session");
    const state = JSON.stringify((h.store as unknown as { state: unknown }).state, (_k, v) =>
      v instanceof Map ? [...v.entries()] : v,
    );
    assert.ok(!state.includes(grant), "no clear grant");
    assert.ok(!state.includes(token), "no clear session token");
    assert.ok(state.includes(hashGrant(grant)));
    assert.ok(state.includes(hashGrant(token)));
  });

  it("limits redemption to 20 per minute per IP", async () => {
    const s = await harness();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        codes.push((await s.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", { grant: "x" })).statusCode);
      }
      assert.deepEqual(codes.slice(0, 20), Array(20).fill(401));
      assert.equal(codes[20], 429);
      s.clock.advance(60);
      const later = await s.browser(null, "POST", "/console/v1/auth/cloud-launch/redeem", { grant: "x" });
      assert.equal(later.statusCode, 401);
    } finally {
      await s.close();
    }
  });

  it("records auth.cloud_launch with no secrets", async () => {
    const events = await h.store.transaction((tx) => tx.listSecurityEvents());
    const launches = events.filter((e) => e.action === "auth.cloud_launch");
    assert.ok(launches.length > 0);
    assert.equal(launches[0]!.serviceInstanceId, SI);
    assert.equal(launches[0]!.subject, "user_a");
    assert.ok(!JSON.stringify(events).includes("sqlg_") && !JSON.stringify(events).includes("sqcs_"));
  });
});

describe("Console sessions (§5)", () => {
  let h: Harness;
  before(async () => {
    // Several creates share this harness: lift the pilot caps (tested elsewhere).
    h = await harness({ env: { COMPUTE_POOL_MAX_INSTANCES: "20", COMPUTE_POOL_MAX_VCPU: "40", COMPUTE_POOL_MAX_MEMORY_MB: "40960", COMPUTE_POOL_MAX_DISK_GB: "1000" } });
  });
  after(() => h.close());

  it("answers auth/me with the principal, role, service instance and session times", async () => {
    const s = await h.consoleSession("admin", SI, "user_me");
    const res = await h.browser(s, "GET", "/console/v1/auth/me");
    assert.equal(res.statusCode, 200);
    const now = h.clock.now().getTime();
    assert.deepEqual(res.json(), {
      principal: { subject: "user_me", displayName: "Test User", email: "test@example.com" },
      role: "admin",
      serviceInstance: { id: SI, displayName: "Pilot", regionId: "eu-central" },
      session: {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 8 * 3600_000).toISOString(),
        freshUntil: new Date(now + 900_000).toISOString(),
      },
    });
  });

  it("needs a session: none, garbage and operator tokens are 401", async () => {
    assert.equal((await h.browser(null, "GET", "/console/v1/instances")).statusCode, 401);
    const garbage = { cookie: "sq_console_session=nope", token: "" };
    assert.equal((await h.browser(garbage, "GET", "/console/v1/instances")).statusCode, 401);
    const op = await h.operatorSession("admin");
    const res = await h.browser({ cookie: `sq_console_session=${op.token}`, token: op.token }, "GET", "/console/v1/instances");
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "unauthorized");
  });

  it("lets viewers read and nothing else", async () => {
    const viewer = await h.consoleSession("viewer", SI, "user_viewer");
    assert.equal((await h.browser(viewer, "GET", "/console/v1/instances")).statusCode, 200);
    assert.equal((await h.browser(viewer, "GET", "/console/v1/images")).statusCode, 200);
    assert.equal((await h.browser(viewer, "GET", "/console/v1/usage")).statusCode, 200);
    const created = instanceOf(await h.createInstance({ name: "viewed" }));
    assert.equal((await h.browser(viewer, "GET", `/console/v1/instances/${created.id}/snapshots`)).statusCode, 200);
    for (const [method, url, body] of [
      ["POST", "/console/v1/instances", baseSpec],
      ["DELETE", `/console/v1/instances/${created.id}`, undefined],
      ["POST", `/console/v1/instances/${created.id}/actions`, { action: "stop" }],
      ["POST", `/console/v1/instances/${created.id}/snapshots`, { name: "s" }],
      ["DELETE", `/console/v1/instances/${created.id}/snapshots/${NO_SUCH}`, undefined],
      ["POST", `/console/v1/instances/${created.id}/console`, undefined],
    ] as const) {
      const res = await h.browser(viewer, method, url, body, { "idempotency-key": idempotencyKey() });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(res.json().error.code, "forbidden");
    }
  });

  it("lets developers and admins write", async () => {
    for (const role of ["developer", "admin"] as const) {
      const s = await h.consoleSession(role, SI, `user_${role}`);
      const res = await h.createInstance({ name: `by-${role}`, memoryMb: 512 }, idempotencyKey(), s);
      assert.equal(res.statusCode, 201, res.body);
    }
  });

  it("rejects cross-origin writes, even with a valid cookie", async () => {
    const res = await h.console("POST", "/console/v1/instances", baseSpec, {
      origin: "https://evil.example",
      "idempotency-key": idempotencyKey(),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "cross_origin");
  });

  it("scopes a session to its service instance", async () => {
    const mine = instanceOf(await h.createInstance({ name: "scoped", memoryMb: 512 }));
    const other = await h.consoleSession("admin", OTHER_SI, "user_other");
    assert.deepEqual((await h.browser(other, "GET", "/console/v1/instances")).json().instances, []);
    assert.equal((await h.browser(other, "GET", `/console/v1/instances/${mine.id}`)).statusCode, 404);
    assert.equal((await h.browser(other, "DELETE", `/console/v1/instances/${mine.id}`)).statusCode, 404);
    const bad = await h.console("GET", "/console/v1/instances/not-a-uuid");
    assert.equal(bad.statusCode, 404);
  });

  it("allows only allow-listed Cloud projects to create (D4, via the service instance)", async () => {
    const other = await h.consoleSession("admin", OTHER_SI, "user_other");
    const res = await h.createInstance({ name: "outsider" }, idempotencyKey(), other);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "project_not_allowed");
  });

  it("requires Idempotency-Key and validates the spec, naming fields but not values", async () => {
    const none = await h.console("POST", "/console/v1/instances", baseSpec);
    assert.equal(none.json().error.code, "idempotency_key_required");
    const short = await h.console("POST", "/console/v1/instances", baseSpec, { "idempotency-key": "short" });
    assert.equal(short.json().error.code, "idempotency_key_invalid");
    const bad = await h.createInstance({ name: "Bad_Name", vcpu: 9 });
    assert.equal(bad.json().error.code, "validation_failed");
    assert.ok(!bad.body.includes("Bad_Name"));
    const image = await h.createInstance({ name: "img", imageId: "windows-11" });
    assert.equal(image.json().error.code, "unknown_image");
  });

  it("defaults the disk to 16 GB when diskGb is left out", async () => {
    const { diskGb: _d, ...noDisk } = baseSpec;
    const res = await h.console(
      "POST",
      "/console/v1/instances",
      { ...noDisk, name: "default-disk", memoryMb: 512 },
      { "idempotency-key": idempotencyKey() },
    );
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(instanceOf(res).spec.diskGb, 16);
  });

  it("ends after 8 hours, absolute", async () => {
    const s = await h.consoleSession("viewer", SI, "user_clock");
    h.clock.advance(8 * 3600 - 1);
    assert.equal((await h.browser(s, "GET", "/console/v1/instances")).statusCode, 200);
    h.clock.advance(1);
    assert.equal((await h.browser(s, "GET", "/console/v1/instances")).statusCode, 401);
  });

  it("logs out: the session ends and the cookie is cleared", async () => {
    const s = await h.consoleSession("viewer", SI, "user_out");
    const res = await h.browser(s, "POST", "/console/v1/auth/logout");
    assert.equal(res.statusCode, 200);
    assert.match(
      cookieLine(res, "sq_console_session"),
      /^sq_console_session=; Path=\/console; Max-Age=0; HttpOnly; SameSite=Strict$/,
    );
    assert.equal((await h.browser(s, "GET", "/console/v1/instances")).statusCode, 401);
  });

  it("a new launch ends the browser's previous session", async () => {
    const first = await h.consoleSession("viewer", SI, "user_rot");
    const l = await h.cloud("POST", `/cloud/v1/service-instances/${SI}/console-launches`, {
      principal: principal("user_rot"),
      role: "viewer",
      returnPath: "/console/",
    });
    const res = await h.browser(first, "POST", "/console/v1/auth/cloud-launch/redeem", {
      grant: grantFrom(l.json().launchUrl),
    });
    assert.equal(res.statusCode, 200);
    assert.equal((await h.browser(first, "GET", "/console/v1/instances")).statusCode, 401);
    assert.notEqual(tokenFrom(res, "sq_console_session"), first.token);
  });
});

describe("revocation (§3.3)", () => {
  it("ends every Console and operator session of a principal, and is idempotent", async () => {
    const h = await harness();
    try {
      const a = await h.consoleSession("admin", SI, "user_rev");
      const b = await h.consoleSession("viewer", OTHER_SI, "user_rev");
      const op = await h.operatorSession("owner", "user_rev");
      const keep = await h.consoleSession("viewer", SI, "user_keep");
      const res = await h.cloud("POST", "/cloud/v1/principals/user_rev/revocations");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { revokedSessions: 3 });
      assert.equal((await h.browser(a, "GET", "/console/v1/instances")).statusCode, 401);
      assert.equal((await h.browser(b, "GET", "/console/v1/instances")).statusCode, 401);
      assert.equal((await h.browser(op, "GET", "/admin/v1/fleet/hosts")).statusCode, 401);
      assert.equal((await h.browser(keep, "GET", "/console/v1/instances")).statusCode, 200);
      const again = await h.cloud("POST", "/cloud/v1/principals/user_rev/revocations");
      assert.deepEqual(again.json(), { revokedSessions: 0 });
      const unknown = await h.cloud("POST", "/cloud/v1/principals/user_nobody/revocations");
      assert.deepEqual(unknown.json(), { revokedSessions: 0 });
      const bad = await h.cloud("POST", "/cloud/v1/principals/a%20b/revocations");
      assert.equal(bad.statusCode, 400);

      // A session created after the revocation works.
      h.clock.advance(1);
      const fresh = await h.consoleSession("viewer", SI, "user_rev");
      assert.equal((await h.browser(fresh, "GET", "/console/v1/instances")).statusCode, 200);
    } finally {
      await h.close();
    }
  });
});

describe("operator launch and sessions (§8)", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  const launch = (body: Record<string, unknown>) =>
    h.cloud("POST", "/cloud/v1/operator-launches", {
      principal: principal("user_staff"),
      role: "admin",
      returnPath: "/admin/fleet",
      ...body,
    });

  it("returns an /admin/launch URL with an sqog_ grant", async () => {
    const res = await launch({});
    assert.equal(res.statusCode, 201, res.body);
    assert.match(res.json().launchUrl, /^http:\/\/compute\.test\/admin\/launch#grant=sqog_[A-Za-z0-9_-]{43}$/);
  });

  it("refuses return paths outside /admin/ or under /admin/v1/", async () => {
    for (const returnPath of [
      "/admin/v1/fleet/hosts",
      "/admin/v1",
      "/ADMIN/V1/x",
      "/console/x",
      "//x/admin/",
      "/admin/../console/",
    ]) {
      const res = await launch({ returnPath });
      assert.equal(res.statusCode, 400, returnPath);
      assert.equal(res.json().error.code, "federation_return_path");
    }
    assert.equal((await launch({ role: "developer" })).statusCode, 400);
  });

  it("redeems only sqog_ grants, into a 1-hour /admin cookie", async () => {
    const consoleGrant = grantFrom(
      (
        await h.cloud("POST", `/cloud/v1/service-instances/${SI}/console-launches`, {
          principal: principal("user_staff"),
          role: "admin",
          returnPath: "/console/",
        })
      ).json().launchUrl,
    );
    const wrong = await h.browser(null, "POST", "/admin/v1/auth/cloud-launch/redeem", { grant: consoleGrant });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error.code, "launch_invalid");

    const grant = grantFrom((await launch({})).json().launchUrl);
    const res = await h.browser(null, "POST", "/admin/v1/auth/cloud-launch/redeem", { grant });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      returnPath: "/admin/fleet",
      sessionExpiresAt: new Date(h.clock.now().getTime() + 3600_000).toISOString(),
    });
    assert.match(
      cookieLine(res, "sq_admin_session"),
      /^sq_admin_session=sqos_[A-Za-z0-9_-]{43}; Path=\/admin; Max-Age=3600; HttpOnly; SameSite=Strict$/,
    );
    assert.equal((await h.browser(null, "POST", "/admin/v1/auth/cloud-launch/redeem", { grant })).statusCode, 401);

    const events = await h.store.transaction((tx) => tx.listSecurityEvents());
    const e = events.find((x) => x.action === "auth.operator_launch");
    assert.equal(e?.subject, "user_staff");
    assert.equal(e?.role, "admin");
  });

  it("answers auth/me and ends after 1 hour, absolute", async () => {
    const s = await h.operatorSession("viewer", "user_hour");
    const me = await h.browser(s, "GET", "/admin/v1/auth/me");
    assert.equal(me.json().operator.role, "viewer");
    h.clock.advance(3599);
    assert.equal((await h.browser(s, "GET", "/admin/v1/fleet/hosts")).statusCode, 200);
    h.clock.advance(1);
    assert.equal((await h.browser(s, "GET", "/admin/v1/fleet/hosts")).statusCode, 401);
  });

  it("lets viewers read the fleet but never write", async () => {
    const s = await h.operatorSession("viewer", "user_view");
    assert.equal((await h.browser(s, "GET", "/admin/v1/fleet/hosts")).statusCode, 200);
    assert.equal((await h.browser(s, "GET", "/admin/v1/fleet/instances")).statusCode, 200);
    for (const url of ["/admin/v1/fleet/enrolment-tokens", `/admin/v1/fleet/hosts/${NO_SUCH}/disable`]) {
      const res = await h.browser(s, "POST", url, {});
      assert.equal(res.statusCode, 403, url);
      assert.equal(res.json().error.code, "forbidden");
    }
  });

  it("needs a session younger than 15 minutes for writes, and records the refusal", async () => {
    const s = await h.operatorSession("owner", "user_fresh");
    h.clock.advance(899);
    assert.equal((await h.browser(s, "POST", "/admin/v1/fleet/enrolment-tokens", {})).statusCode, 201);
    h.clock.advance(1);
    const stale = await h.browser(s, "POST", "/admin/v1/fleet/enrolment-tokens", {});
    assert.equal(stale.statusCode, 403);
    assert.equal(stale.json().error.code, "reauth_required");
    assert.equal((await h.browser(s, "GET", "/admin/v1/fleet/hosts")).statusCode, 200, "reads still work");
    const events = await h.store.transaction((tx) => tx.listSecurityEvents());
    assert.ok(events.some((e) => e.action === "auth.operator_reauth_required" && e.subject === "user_fresh"));
  });

  it("rejects cross-origin fleet writes and logs out", async () => {
    const s = await h.operatorSession("admin", "user_x");
    const cross = await h.browser(s, "POST", "/admin/v1/fleet/enrolment-tokens", {}, { origin: "https://evil.example" });
    assert.equal(cross.json().error.code, "cross_origin");
    const out = await h.browser(s, "POST", "/admin/v1/auth/logout");
    assert.equal(out.statusCode, 200);
    assert.equal((await h.browser(s, "GET", "/admin/v1/fleet/hosts")).statusCode, 401);
  });

  it("uses the platform role vocabularies of the kit", () => {
    assert.deepEqual([...OPERATOR_ROLES], [...KIT_OPERATOR_ROLES]);
    assert.deepEqual([...CONSOLE_ROLES], [...KIT_CONSOLE_ROLES]);
  });
});

describe("fleet routes", () => {
  it("create 30-minute enrolment tokens shown once, list, drain, disable and enable hosts", async () => {
    const logs: string[] = [];
    const h = await harness({ logs });
    try {
      const created = await h.admin("POST", "/admin/v1/fleet/enrolment-tokens", { hostName: "sq-node-01" });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.headers["cache-control"], "no-store");
      const { token, expiresAt } = created.json();
      assert.match(token, /^sqet_[A-Za-z0-9_-]{43}$/);
      assert.equal(expiresAt, new Date(h.clock.now().getTime() + 1800_000).toISOString());
      assert.equal(hashToken(token), createHash("sha256").update(token).digest("hex"));
      assert.equal((await h.admin("POST", "/admin/v1/fleet/enrolment-tokens", { ttlSeconds: 60 })).statusCode, 400);

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
      const { hostId } = enrol.json();

      const list = await h.admin("GET", "/admin/v1/fleet/hosts");
      assert.equal(list.json().hosts[0].name, "sq-node-01");
      assert.deepEqual(list.json().hosts[0].allocated, { vcpu: 0, memoryMb: 0, diskGb: 0 });

      assert.equal((await h.admin("POST", `/admin/v1/fleet/hosts/${hostId}/drain`)).json().host.state, "draining");
      const disabled = await h.admin("POST", `/admin/v1/fleet/hosts/${hostId}/disable`);
      assert.equal(disabled.json().host.state, "disabled");
      assert.equal(disabled.json().stopsQueued, 0);
      const drainDisabled = await h.admin("POST", `/admin/v1/fleet/hosts/${hostId}/drain`);
      assert.equal(drainDisabled.json().error.code, "host_disabled");
      const enabled = await h.admin("POST", `/admin/v1/fleet/hosts/${hostId}/enable`);
      assert.equal(enabled.json().host.state, "enrolled", "never seen, so back to enrolled");
      assert.equal((await h.admin("POST", `/admin/v1/fleet/hosts/${NO_SUCH}/disable`)).statusCode, 404);

      const events = await h.store.transaction((tx) => tx.listSecurityEvents());
      assert.deepEqual(
        events.filter((e) => e.action.startsWith("fleet.")).map((e) => e.action),
        ["fleet.enrolment_token", "fleet.host_drain", "fleet.host_disable", "fleet.host_enable"],
      );
      assert.equal(events.find((e) => e.action === "fleet.host_disable")?.detail?.hostId, hostId);

      // Nothing secret reaches the logs.
      const text = logs.join("\n");
      assert.ok(logs.length > 0, "logging was on");
      assert.ok(!text.includes(token) && !text.includes("sqet_"), "no enrolment token in logs");
      assert.ok(!/sq(lg|og|cs|os)_/.test(text), "no grant or session token in logs");
      assert.ok(
        !/x-sq-cloud-signature|set-cookie|sq_admin_session|sq_console_session/i.test(text),
        "no signature or cookie in logs",
      );
      assert.ok(!text.includes("PUBLIC KEY") && !text.includes("PRIVATE KEY"), "no key material in logs");
    } finally {
      await h.close();
    }
  });

  it("list every instance for support", async () => {
    const h = await harness();
    try {
      const a = instanceOf(await h.createInstance({ name: "support-a", memoryMb: 512 }));
      const res = await h.admin("GET", "/admin/v1/fleet/instances");
      assert.deepEqual(
        res.json().instances.map((i: { id: string; serviceInstanceId: string }) => [i.id, i.serviceInstanceId]),
        [[a.id, SI]],
      );
      await h.console("DELETE", `/console/v1/instances/${a.id}`);
      assert.deepEqual((await h.admin("GET", "/admin/v1/fleet/instances")).json().instances, []);
      assert.equal((await h.admin("GET", "/admin/v1/fleet/instances?include=deleted")).json().instances.length, 1);
    } finally {
      await h.close();
    }
  });
});

describe("driver capabilities", () => {
  it("reports each instance's host driver capabilities and refuses what the driver cannot do", async () => {
    const h = await harness();
    try {
      const pending = instanceOf(await h.createInstance({ name: "early" }));
      assert.equal(pending.state, "pending");
      assert.deepEqual(pending.capabilities, { console: false, resize: false, snapshot: false });

      const agent = await h.enrolAgent("sq-node-01", { vcpu: 4, memoryMb: 8192, diskGb: 120 }, "proxmox");
      await agent.drain();
      const listed = (await h.console("GET", "/console/v1/instances")).json().instances;
      assert.equal(listed[0].state, "running");
      assert.deepEqual(listed[0].capabilities, { console: false, resize: true, snapshot: true });
      const one = await h.console("GET", `/console/v1/instances/${pending.id}`);
      assert.deepEqual(one.json().instance.capabilities, { console: false, resize: true, snapshot: true });
      const fleet = (await h.admin("GET", "/admin/v1/fleet/instances")).json().instances;
      assert.deepEqual(fleet[0].capabilities, { console: false, resize: true, snapshot: true });

      const console = await h.console("POST", `/console/v1/instances/${pending.id}/console`);
      assert.equal(console.statusCode, 409);
      assert.equal(console.json().error.code, "not_supported");
      assert.equal(await agent.claim(), null, "no console job is queued");

      const snap = await h.console("POST", `/console/v1/instances/${pending.id}/snapshots`, { name: "one" });
      assert.equal(snap.statusCode, 202, snap.body);
    } finally {
      await h.close();
    }
  });

  it("reports full capabilities for the fake driver", async () => {
    const h = await harness();
    try {
      const agent = await h.enrolAgent();
      await agent.drain(); // the first signed request makes the host active
      const created = instanceOf(await h.createInstance());
      assert.equal(created.state, "provisioning");
      assert.deepEqual(created.capabilities, { console: true, resize: true, snapshot: true });
      await agent.drain();
    } finally {
      await h.close();
    }
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
      hd["x-sq-host-id"] = NO_SUCH;
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().error.code, "agent_unknown_host");

    const stale = await agent.request("POST", path, undefined, (hd) => {
      hd["x-sq-host-timestamp"] = String(Math.floor(h.clock.now().getTime() / 1000) - 301);
    });
    assert.equal(stale.json().error.code, "agent_stale");

    const body = { samples: [] };
    const tampered = await h.app.inject({
      method: "POST",
      url: "/v1/agent/usage",
      payload: JSON.stringify({ samples: [{ x: 1 }] }),
      headers: { "content-type": "application/json", ...agent.sign("POST", "/v1/agent/usage", JSON.stringify(body)) },
    });
    assert.equal(tampered.json().error.code, "agent_signature");

    const nonce = "abcdefabcdefabcdefabcdefabcdef01";
    const once = await agent.request("POST", path, undefined, undefined, nonce);
    assert.equal(once.statusCode, 200, once.body);
    const twice = await agent.request("POST", path, undefined, undefined, nonce);
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

  it("refuses a result on a job that returns none", async () => {
    const agent: FakeAgent = await h.enrolAgent("no-result");
    await agent.claim();
    for (const x of await h.services.hosts.list()) if (x.id !== agent.hostId) await h.services.hosts.drain(x.id);
    await h.createInstance({ name: "no-result", memoryMb: 512 });
    const job = await agent.claim();
    assert.ok(job);
    const res = await agent.request("POST", `/v1/agent/jobs/${job.envelope.id}/complete`, {
      attempt: 1,
      result: { protocol: "vnc", ticket: "x", expiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString() },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "invalid_result");
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
      assert.equal(new Date(job.envelope.expiresAt).getTime() - new Date(job.envelope.issuedAt).getTime(), 300_000);
      const text = logs.join("\n");
      assert.ok(!text.includes(job.signature), "signature not logged");
      assert.ok(!text.includes(inst.privateIp!), "envelope payload not logged");
    } finally {
      await h.close();
    }
  });
});

describe("configuration", () => {
  it("requires an https public URL in production with federation on", async () => {
    const { loadConfig } = await import("../src/config.js");
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x@localhost/x",
      COMPUTE_JOB_SIGNING_KEY_PEM: ed25519().privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      CLOUD_FEDERATION_ENABLED: "true",
      CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({
        k: ed25519().publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
      // C1d: production with federation also needs Cloud's https origin.
      CLOUD_ORIGIN: "https://cloud.example",
    };
    const url = "https://compute.example";
    assert.throws(() => loadConfig(base), /COMPUTE_PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...base, COMPUTE_PUBLIC_URL: "http://compute.example" }), /COMPUTE_PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...base, COMPUTE_PUBLIC_URL: `${url}/path` }), /COMPUTE_PUBLIC_URL/);
    const ok = loadConfig({ ...base, COMPUTE_PUBLIC_URL: url });
    assert.equal(ok.publicUrl, url);
    assert.equal(ok.cookieSecure, true);
    assert.equal(ok.defaultDiskGb, 16);
    assert.equal(ok.federation.operatorLaunch, false, "operator launch is off by default");
    assert.throws(() => loadConfig({ ...base, COMPUTE_PUBLIC_URL: url, COMPUTE_DEFAULT_DISK_GB: "8" }), /COMPUTE_DEFAULT_DISK_GB/);
    assert.throws(
      () => loadConfig({ ...base, COMPUTE_PUBLIC_URL: url, COMPUTE_TRUSTED_PROXY_CIDRS: "evil" }),
      /COMPUTE_TRUSTED_PROXY_CIDRS/,
    );
  });

  it("refuses COMPUTE_COOKIE_SECURE=false except on a local development URL (review finding 3)", async () => {
    const { loadConfig } = await import("../src/config.js");
    const base = {
      NODE_ENV: "development",
      COMPUTE_STORE: "memory",
      COMPUTE_JOB_SIGNING_KEY_PEM: ed25519().privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    const federated = {
      ...base,
      CLOUD_FEDERATION_ENABLED: "true",
      CLOUD_FEDERATION_PUBLIC_KEYS: JSON.stringify({ k: ed25519().publicKey.export({ type: "spki", format: "pem" }).toString() }),
    };
    const off = { COMPUTE_COOKIE_SECURE: "false" };
    // https: never.
    assert.throws(() => loadConfig({ ...base, ...off, COMPUTE_PUBLIC_URL: "https://compute.example" }), /COMPUTE_COOKIE_SECURE/);
    // Federation on with a non-local URL: never.
    assert.throws(() => loadConfig({ ...federated, ...off, COMPUTE_PUBLIC_URL: "http://compute.example" }), /COMPUTE_COOKIE_SECURE/);
    // Local development URLs: allowed.
    for (const url of ["http://localhost:8080", "http://127.0.0.1:8080", "http://localhost"]) {
      assert.equal(loadConfig({ ...federated, ...off, COMPUTE_PUBLIC_URL: url }).cookieSecure, false, url);
    }
    // No public URL means the local listener (http://127.0.0.1): allowed.
    assert.equal(loadConfig({ ...federated, ...off }).cookieSecure, false);
    // Secure on is always fine.
    assert.equal(loadConfig({ ...federated, COMPUTE_COOKIE_SECURE: "true", COMPUTE_PUBLIC_URL: "http://compute.example" }).cookieSecure, true);
  });
});
