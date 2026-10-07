/**
 * C1d store-backed Console behaviour, run on every store (memory in
 * console.test.ts, Postgres in postgres.pg-test.ts): saved SSH keys,
 * per-instance usage totals and the 15-minute rule for deletes.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import type { ComputeStore } from "../src/store/index.js";
import { harness, instanceOf, OTHER_SI, SI } from "./helpers.js";

export type ConsoleStoreFactory = () => Promise<ComputeStore>;

function sshString(bytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

export function ed25519Line(comment = "dev@laptop"): string {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.from(jwk.x!, "base64url"))]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

export function consoleStoreSuite(label: string, makeStore: ConsoleStoreFactory): void {
  describe(`${label}: saved SSH keys`, () => {
    it("saves once per service instance, lists newest first and deletes", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const a = await h.console("POST", "/console/v1/ssh-keys", { publicKey: ed25519Line("first") });
        assert.equal(a.statusCode, 201, a.body);
        h.clock.advance(60);
        const line = ed25519Line("second");
        const b = await h.console("POST", "/console/v1/ssh-keys", { publicKey: line });
        assert.equal(b.statusCode, 201, b.body);
        const again = await h.console("POST", "/console/v1/ssh-keys", { publicKey: line });
        assert.equal(again.statusCode, 200);
        assert.equal(again.json().sshKey.id, b.json().sshKey.id);
        const list = (await h.console("GET", "/console/v1/ssh-keys")).json().sshKeys;
        assert.deepEqual(list.map((k: { name: string }) => k.name), ["second", "first"]);
        assert.equal(list[0].createdAt, h.clock.now().toISOString());

        // The same key may be saved by another service instance.
        const other = await h.consoleSession("developer", OTHER_SI, "user_other");
        assert.equal((await h.browser(other, "POST", "/console/v1/ssh-keys", { publicKey: line })).statusCode, 201);
        assert.equal((await h.browser(other, "DELETE", `/console/v1/ssh-keys/${a.json().sshKey.id}`)).statusCode, 404);

        assert.equal((await h.console("DELETE", `/console/v1/ssh-keys/${a.json().sshKey.id}`)).statusCode, 204);
        assert.deepEqual(
          (await h.console("GET", "/console/v1/ssh-keys")).json().sshKeys.map((k: { name: string }) => k.name),
          ["second"],
        );
      } finally {
        await h.close();
      }
    });
  });

  describe(`${label}: instance usage and the 15-minute delete rule`, () => {
    it("sums one instance's samples and enforces 14:59 allowed, 15:01 refused, relaunch allowed", async () => {
      const h = await harness({ store: await makeStore() });
      try {
        const agent = await h.enrolAgent();
        await agent.claim();
        const inst = instanceOf(await h.createInstance({ name: "pg-usage", vcpu: 2, memoryMb: 2048, diskGb: 20 }));
        await agent.drain();
        const res = await agent.request("POST", "/v1/agent/usage", {
          samples: [
            { instanceId: inst.id, sampledAt: "2026-10-07T10:00:00.000Z", intervalSeconds: 1800, powerState: "running" },
            { instanceId: inst.id, sampledAt: "2026-10-07T09:30:00.000Z", intervalSeconds: 1800, powerState: "stopped" },
          ],
        });
        assert.equal(res.statusCode, 202, res.body);
        assert.deepEqual((await h.console("GET", `/console/v1/instances/${inst.id}/usage`)).json(), {
          usage: { vcpuHours: 1, memoryGbHours: 1, diskGbHours: 20 },
        });

        const second = instanceOf(await h.createInstance({ name: "pg-second" }));
        await agent.drain();
        const s = await h.consoleSession("developer", SI, "user_pg");
        h.clock.advance(15 * 60 + 1);
        const refused = await h.browser(s, "DELETE", `/console/v1/instances/${inst.id}`);
        assert.equal(refused.statusCode, 403);
        assert.equal(refused.json().error.code, "reauth_required");
        const events = await h.store.transaction((tx) => tx.listSecurityEvents());
        assert.ok(events.some((e) => e.action === "auth.console_reauth_required" && e.subject === "user_pg"));

        const fresh = await h.consoleSession("developer", SI, "user_pg");
        h.clock.advance(14 * 60 + 59);
        assert.equal((await h.browser(fresh, "DELETE", `/console/v1/instances/${inst.id}`)).statusCode, 202);
        h.clock.advance(2);
        assert.equal((await h.browser(fresh, "DELETE", `/console/v1/instances/${second.id}`)).statusCode, 403);
      } finally {
        await h.close();
      }
    });
  });
}
