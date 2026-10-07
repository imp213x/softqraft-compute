/**
 * C1d Console routes: size presets, saved SSH keys, the 15-minute rule for
 * deletes, the instance detail (console capability, usage), the operator
 * write freshness on the fleet routes, and the static pages with their
 * security headers.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MemoryComputeStore } from "../src/store/index.js";
import { consoleStoreSuite } from "./console-suites.js";
import { harness, instanceOf, SI, OTHER_SI, type Harness } from "./helpers.js";

consoleStoreSuite("memory store", async () => new MemoryComputeStore());

/** One SSH wire-format string: uint32 length, then the bytes. */
function sshString(bytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/** An unsigned big-endian integer as an SSH mpint (a leading zero when the top bit is set). */
function mpint(bytes: Buffer): Buffer {
  return sshString(bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

/** A fresh OpenSSH ed25519 public key line, generated at run time. */
function ed25519Line(comment = "dev@laptop"): string {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.from(jwk.x!, "base64url"))]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

/** A fresh OpenSSH RSA public key line of `bits` bits. */
function rsaLine(bits: number): string {
  const jwk = generateKeyPairSync("rsa", { modulusLength: bits }).publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([
    sshString(Buffer.from("ssh-rsa")),
    mpint(Buffer.from(jwk.e!, "base64url")),
    mpint(Buffer.from(jwk.n!, "base64url")),
  ]);
  return `ssh-rsa ${blob.toString("base64")} rsa@test`;
}

describe("GET /console/v1/sizes", () => {
  it("offers Small, Medium and Large at the default disk, Small first", async () => {
    const h = await harness();
    try {
      const res = await h.console("GET", "/console/v1/sizes");
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json(), {
        sizes: [
          { id: "small", name: "Small", vcpu: 1, memoryMb: 1024, diskGb: 16 },
          { id: "medium", name: "Medium", vcpu: 2, memoryMb: 2048, diskGb: 16 },
          { id: "large", name: "Large", vcpu: 2, memoryMb: 4096, diskGb: 16 },
        ],
        defaultSizeId: "small",
      });
    } finally {
      await h.close();
    }
  });

  it("builds the presets from the pilot caps: a preset the pool can never hold is not offered", async () => {
    const h = await harness({ env: { COMPUTE_POOL_MAX_MEMORY_MB: "2048" } });
    try {
      assert.deepEqual(
        (await h.console("GET", "/console/v1/sizes")).json().sizes.map((s: { id: string }) => s.id),
        ["small", "medium"],
      );
    } finally {
      await h.close();
    }
    const one = await harness({ env: { COMPUTE_POOL_MAX_VCPU: "1" } });
    try {
      assert.deepEqual(
        (await one.console("GET", "/console/v1/sizes")).json().sizes.map((s: { id: string }) => s.id),
        ["small"],
      );
    } finally {
      await one.close();
    }
    const tiny = await harness({ env: { COMPUTE_POOL_MAX_DISK_GB: "10", COMPUTE_DEFAULT_DISK_GB: "16" } });
    try {
      assert.deepEqual((await tiny.console("GET", "/console/v1/sizes")).json(), { sizes: [], defaultSizeId: null });
    } finally {
      await tiny.close();
    }
  });

  it("needs a Console session", async () => {
    const h = await harness();
    try {
      assert.equal((await h.browser(null, "GET", "/console/v1/sizes")).statusCode, 401);
    } finally {
      await h.close();
    }
  });
});

describe("/console/v1/ssh-keys", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await h.close();
  });

  it("saves an ed25519 key once, names it from its comment, and lists it", async () => {
    const line = ed25519Line("ada@laptop");
    const first = await h.console("POST", "/console/v1/ssh-keys", { publicKey: line });
    assert.equal(first.statusCode, 201, first.body);
    const key = first.json().sshKey;
    assert.equal(key.type, "ssh-ed25519");
    assert.equal(key.bits, 256);
    assert.equal(key.name, "ada@laptop");
    assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(key.publicKey, line.split(" ").slice(0, 2).join(" "), "stored without the comment");

    const again = await h.console("POST", "/console/v1/ssh-keys", { publicKey: `${line.split(" ").slice(0, 2).join(" ")}  other`, name: "Again" });
    assert.equal(again.statusCode, 200, "the same key is not saved twice");
    assert.equal(again.json().sshKey.id, key.id);

    const list = await h.console("GET", "/console/v1/ssh-keys");
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().sshKeys.map((k: { id: string }) => k.id), [key.id]);
  });

  it("accepts RSA of 3072 bits or more and refuses smaller RSA keys", async () => {
    const strong = await h.console("POST", "/console/v1/ssh-keys", { publicKey: rsaLine(3072), name: "Build server" });
    assert.equal(strong.statusCode, 201, strong.body);
    assert.equal(strong.json().sshKey.bits, 3072);
    assert.equal(strong.json().sshKey.name, "Build server");
    const weak = await h.console("POST", "/console/v1/ssh-keys", { publicKey: rsaLine(2048) });
    assert.equal(weak.statusCode, 400);
    assert.equal(weak.json().error.code, "ssh_key_too_weak");
  });

  it("refuses other key types, private keys and malformed keys, storing nothing", async () => {
    const before = (await h.console("GET", "/console/v1/ssh-keys")).json().sshKeys.length;
    const cases: Array<[string, string]> = [
      ["ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBA== x", "ssh_key_unsupported"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", "ssh_key_private"],
      ["ssh-ed25519 not-base64!", "ssh_key_invalid"],
      // A valid base64 blob that claims to be RSA inside an ed25519 line.
      [`ssh-ed25519 ${rsaLine(3072).split(" ")[1]}`, "ssh_key_invalid"],
      // An ed25519 blob cut short.
      [`ssh-ed25519 ${Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.alloc(16))]).toString("base64")}`, "ssh_key_invalid"],
      ["hello", "ssh_key_invalid"],
    ];
    for (const [publicKey, code] of cases) {
      const res = await h.console("POST", "/console/v1/ssh-keys", { publicKey });
      assert.equal(res.statusCode, 400, publicKey);
      assert.equal(res.json().error.code, code, publicKey);
    }
    assert.equal((await h.console("GET", "/console/v1/ssh-keys")).json().sshKeys.length, before);
  });

  it("keeps keys per service instance, lets viewers read only, and deletes", async () => {
    const mine = (await h.console("POST", "/console/v1/ssh-keys", { publicKey: ed25519Line() })).json().sshKey;
    const viewer = await h.consoleSession("viewer", SI, "user_viewer");
    assert.equal((await h.browser(viewer, "GET", "/console/v1/ssh-keys")).statusCode, 200);
    const refused = await h.browser(viewer, "POST", "/console/v1/ssh-keys", { publicKey: ed25519Line() });
    assert.equal(refused.statusCode, 403);
    assert.equal((await h.browser(viewer, "DELETE", `/console/v1/ssh-keys/${mine.id}`)).statusCode, 403);

    const other = await h.consoleSession("developer", OTHER_SI, "user_other");
    assert.deepEqual((await h.browser(other, "GET", "/console/v1/ssh-keys")).json().sshKeys, []);
    assert.equal((await h.browser(other, "DELETE", `/console/v1/ssh-keys/${mine.id}`)).statusCode, 404);

    const del = await h.console("DELETE", `/console/v1/ssh-keys/${mine.id}`);
    assert.equal(del.statusCode, 204);
    assert.equal((await h.console("DELETE", `/console/v1/ssh-keys/${mine.id}`)).statusCode, 404);
    const ids = (await h.console("GET", "/console/v1/ssh-keys")).json().sshKeys.map((k: { id: string }) => k.id);
    assert.ok(!ids.includes(mine.id));
  });

  it("caps saved keys at 20 per service instance", async () => {
    const fresh = await harness();
    try {
      for (let i = 0; i < 20; i += 1) {
        assert.equal((await fresh.console("POST", "/console/v1/ssh-keys", { publicKey: ed25519Line() })).statusCode, 201);
      }
      const over = await fresh.console("POST", "/console/v1/ssh-keys", { publicKey: ed25519Line() });
      assert.equal(over.statusCode, 409);
      assert.equal(over.json().error.code, "ssh_key_limit");
    } finally {
      await fresh.close();
    }
  });
});

describe("the 15-minute rule for Console deletes", () => {
  /** A running instance with one available snapshot. */
  async function runningWithSnapshot(h: Harness, name: string) {
    const agent = await h.enrolAgent(`host-${name}`);
    await agent.claim();
    const inst = instanceOf(await h.createInstance({ name }));
    await agent.drain();
    const snap = await h.console("POST", `/console/v1/instances/${inst.id}/snapshots`, { name: "before" });
    assert.equal(snap.statusCode, 202, snap.body);
    await agent.drain();
    return { inst, snapshotId: snap.json().snapshot.id as string, agent };
  }

  it("allows a delete at 14:59 after sign-in", async () => {
    const h = await harness();
    try {
      const { inst, snapshotId } = await runningWithSnapshot(h, "fresh");
      const s = await h.consoleSession("developer", SI, "user_del");
      h.clock.advance(14 * 60 + 59);
      const snap = await h.browser(s, "DELETE", `/console/v1/instances/${inst.id}/snapshots/${snapshotId}`);
      assert.equal(snap.statusCode, 202, snap.body);
      const del = await h.browser(s, "DELETE", `/console/v1/instances/${inst.id}`);
      assert.equal(del.statusCode, 202, del.body);
      assert.equal(del.json().instance.state, "deleting");
    } finally {
      await h.close();
    }
  });

  it("refuses a delete at 15:01 with reauth_required, changes nothing, and records it", async () => {
    const h = await harness();
    try {
      const { inst, snapshotId } = await runningWithSnapshot(h, "stale");
      const s = await h.consoleSession("admin", SI, "user_stale");
      h.clock.advance(15 * 60 + 1);
      for (const url of [`/console/v1/instances/${inst.id}/snapshots/${snapshotId}`, `/console/v1/instances/${inst.id}`]) {
        const res = await h.browser(s, "DELETE", url);
        assert.equal(res.statusCode, 403, url);
        assert.equal(res.json().error.code, "reauth_required", url);
      }
      const detail = await h.browser(s, "GET", `/console/v1/instances/${inst.id}`);
      assert.equal(detail.statusCode, 200, "reads still work");
      assert.equal(detail.json().instance.state, "running", "nothing was deleted");
      const snaps = await h.browser(s, "GET", `/console/v1/instances/${inst.id}/snapshots`);
      assert.equal(snaps.json().snapshots[0].state, "available");
      // Other writes are not under the rule.
      const stop = await h.browser(s, "POST", `/console/v1/instances/${inst.id}/actions`, { action: "stop" });
      assert.equal(stop.statusCode, 202, stop.body);
      const events = await h.store.transaction((tx) => tx.listSecurityEvents());
      const refusals = events.filter((e) => e.action === "auth.console_reauth_required");
      assert.equal(refusals.length, 2);
      assert.equal(refusals[0]!.subject, "user_stale");
      assert.equal(refusals[0]!.serviceInstanceId, SI);
    } finally {
      await h.close();
    }
  });

  it("refuses at exactly 15:00, and a fresh Cloud launch allows the delete again", async () => {
    const h = await harness();
    try {
      const { inst } = await runningWithSnapshot(h, "relaunch");
      const s = await h.consoleSession("developer", SI, "user_back");
      h.clock.advance(15 * 60);
      assert.equal((await h.browser(s, "DELETE", `/console/v1/instances/${inst.id}`)).statusCode, 403);
      h.clock.advance(3600);
      const again = await h.consoleSession("developer", SI, "user_back");
      const del = await h.browser(again, "DELETE", `/console/v1/instances/${inst.id}`);
      assert.equal(del.statusCode, 202, del.body);
    } finally {
      await h.close();
    }
  });

  it("keeps the role rule first: a viewer gets forbidden, not reauth_required", async () => {
    const h = await harness();
    try {
      const { inst } = await runningWithSnapshot(h, "viewer");
      const v = await h.consoleSession("viewer", SI, "user_v");
      h.clock.advance(3600);
      const res = await h.browser(v, "DELETE", `/console/v1/instances/${inst.id}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, "forbidden");
    } finally {
      await h.close();
    }
  });
});

describe("instance detail: console capability and usage", () => {
  it("reports console support from the host's driver, and refuses a console where there is none", async () => {
    const yes = await harness();
    try {
      const agent = await yes.enrolAgent();
      await agent.claim();
      const inst = instanceOf(await yes.createInstance({ name: "with-console" }));
      const pending = await yes.console("GET", `/console/v1/instances/${inst.id}`);
      assert.deepEqual(pending.json().capabilities, { console: true });
      await agent.drain();
      assert.deepEqual((await yes.console("GET", `/console/v1/instances/${inst.id}`)).json().capabilities, { console: true });
    } finally {
      await yes.close();
    }

    const no = await harness({ consoleDrivers: new Set() });
    try {
      const agent = await no.enrolAgent();
      await agent.claim();
      const inst = instanceOf(await no.createInstance({ name: "no-console" }));
      await agent.drain();
      const detail = await no.console("GET", `/console/v1/instances/${inst.id}`);
      assert.equal(detail.json().instance.state, "running");
      assert.deepEqual(detail.json().capabilities, { console: false });
      const open = await no.console("POST", `/console/v1/instances/${inst.id}/console`);
      assert.equal(open.statusCode, 409);
      assert.equal(open.json().error.code, "console_unsupported");
      assert.equal(await agent.claim(), null, "no console job was queued");
    } finally {
      await no.close();
    }
  });

  it("sums one instance's usage hours from its samples, without prices", async () => {
    const h = await harness();
    try {
      const agent = await h.enrolAgent();
      await agent.claim();
      const a = instanceOf(await h.createInstance({ name: "used", vcpu: 2, memoryMb: 2048, diskGb: 20 }));
      const b = instanceOf(await h.createInstance({ name: "other" }));
      await agent.drain();
      h.clock.current = new Date("2026-10-07T12:00:00.000Z");
      const res = await agent.request("POST", "/v1/agent/usage", {
        samples: [
          { instanceId: a.id, sampledAt: "2026-10-07T11:00:00.000Z", intervalSeconds: 3600, powerState: "running" },
          { instanceId: a.id, sampledAt: "2026-10-07T11:30:00.000Z", intervalSeconds: 1800, powerState: "stopped" },
          { instanceId: b.id, sampledAt: "2026-10-07T11:00:00.000Z", intervalSeconds: 3600, powerState: "running" },
        ],
      });
      assert.equal(res.statusCode, 202, res.body);
      const usage = await h.console("GET", `/console/v1/instances/${a.id}/usage`);
      assert.equal(usage.statusCode, 200, usage.body);
      assert.deepEqual(usage.json(), { usage: { vcpuHours: 2, memoryGbHours: 2, diskGbHours: 30 } });
      assert.doesNotMatch(usage.body, /price|cost|amount|currency/i);
      const other = await h.consoleSession("developer", OTHER_SI, "user_o");
      assert.equal((await h.browser(other, "GET", `/console/v1/instances/${a.id}/usage`)).statusCode, 404);
    } finally {
      await h.close();
    }
  });
});

describe("fleet writes and freshness", () => {
  it("drains, stops all and enables a host inside 15 minutes, refuses at 15:01, and allows again after a new launch", async () => {
    const h = await harness();
    try {
      const agent = await h.enrolAgent("sq-node-01");
      await agent.claim();
      const s = await h.operatorSession("admin", "user_ops");
      h.clock.advance(14 * 60 + 59);
      const base = `/admin/v1/fleet/hosts/${agent.hostId}`;
      assert.equal((await h.browser(s, "POST", `${base}/drain`)).json().host.state, "draining");
      const off = await h.browser(s, "POST", `${base}/disable`);
      assert.equal(off.statusCode, 200, off.body);
      assert.equal(off.json().host.state, "disabled");
      h.clock.advance(2);
      const stale = await h.browser(s, "POST", `${base}/enable`);
      assert.equal(stale.statusCode, 403);
      assert.equal(stale.json().error.code, "reauth_required");
      const again = await h.operatorSession("admin", "user_ops");
      const on = await h.browser(again, "POST", `${base}/enable`);
      assert.equal(on.statusCode, 200, on.body);
      assert.equal(on.json().host.state, "active");
    } finally {
      await h.close();
    }
  });

  it("lists hosts with capacity, allocation and last seen, which agent requests keep current", async () => {
    const h = await harness();
    try {
      const agent = await h.enrolAgent("sq-node-02");
      const before = (await h.admin("GET", "/admin/v1/fleet/hosts")).json().hosts[0];
      assert.equal(before.state, "enrolled");
      assert.equal(before.lastSeenAt, null);
      h.clock.advance(30);
      await agent.claim();
      instanceOf(await h.createInstance({ name: "placed", vcpu: 2, memoryMb: 2048 }));
      const host = (await h.admin("GET", "/admin/v1/fleet/hosts")).json().hosts[0];
      assert.equal(host.state, "active");
      assert.equal(host.lastSeenAt, h.clock.now().toISOString());
      assert.deepEqual(host.capacity, { vcpu: 4, memoryMb: 8192, diskGb: 120 });
      assert.deepEqual(host.allocated, { vcpu: 2, memoryMb: 2048, diskGb: 10 });
    } finally {
      await h.close();
    }
  });
});

describe("console and admin pages", () => {
  it("serves the pages and their files with a strict CSP and no caching", async () => {
    const h = await harness({ env: { CLOUD_ORIGIN: "https://cloud.example" } });
    try {
      for (const url of ["/console/", "/console/launch", "/admin/", "/admin/launch"]) {
        const res = await h.app.inject({ method: "GET", url });
        assert.equal(res.statusCode, 200, url);
        assert.match(String(res.headers["content-type"]), /^text\/html/);
        const csp = String(res.headers["content-security-policy"]);
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /script-src 'self'(;|$)/);
        assert.match(csp, /style-src 'self'(;|$)/);
        assert.match(csp, /connect-src 'self'(;|$)/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
        assert.equal(res.headers["cache-control"], "no-store");
        assert.equal(res.headers["x-frame-options"], "DENY");
        assert.doesNotMatch(res.body, /<script>|<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=|style=/i, `${url}: no inline script, handler or style`);
      }
      assert.equal((await h.app.inject({ method: "GET", url: "/console" })).statusCode, 302);
      const js = await h.app.inject({ method: "GET", url: "/console/modules/console-app.js" });
      assert.equal(js.statusCode, 200);
      assert.match(String(js.headers["content-type"]), /^text\/javascript/);
      assert.equal(js.headers["cache-control"], "no-store");
      const css = await h.app.inject({ method: "GET", url: "/admin/styles/app.css" });
      assert.equal(css.statusCode, 200);
      assert.match(String(css.headers["content-type"]), /^text\/css/);
      const png = await h.app.inject({ method: "GET", url: "/console/assets/brand/favicon-32.png" });
      assert.equal(png.statusCode, 200);
      assert.equal(png.headers["content-type"], "image/png");
      for (const url of [
        "/console/modules/../console.html",
        "/console/modules/%2e%2e/console.html",
        "/console/modules/.hidden.js",
        "/console/styles/missing.css",
        "/console/assets/brand/favicon.ico",
        "/admin/modules/../../api/package.json",
      ]) {
        assert.equal((await h.app.inject({ method: "GET", url })).statusCode, 404, url);
      }
    } finally {
      await h.close();
    }
  });

  it("names the sign-in destinations from CLOUD_ORIGIN, never a fixed URL", async () => {
    const h = await harness({ env: { CLOUD_ORIGIN: "https://cloud.example" } });
    try {
      const c = await h.app.inject({ method: "GET", url: "/console/v1/auth/status" });
      assert.deepEqual(c.json(), { signInUrl: "https://cloud.example/cloud/open/compute" });
      const a = await h.app.inject({ method: "GET", url: "/admin/v1/auth/status" });
      assert.equal(a.json().signInUrl, "https://cloud.example/dashboard/services");
      assert.match(a.json().hostRunbookUrl, /^https:\/\/.*runbook\.md#6-host-agent$/);
    } finally {
      await h.close();
    }
    const none = await harness();
    try {
      assert.deepEqual((await none.app.inject({ method: "GET", url: "/console/v1/auth/status" })).json(), { signInUrl: null });
    } finally {
      await none.close();
    }
  });

  it("does not serve the pages while federation is off", async () => {
    const h = await harness({ federation: false });
    try {
      for (const url of ["/console/", "/admin/", "/console/modules/console-app.js", "/console/v1/auth/status"]) {
        assert.equal((await h.app.inject({ method: "GET", url })).statusCode, 404, url);
      }
    } finally {
      await h.close();
    }
  });
});
