import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROXMOX_AGENT_ROLE_PRIVILEGES, proxmoxAgentRoleCommand } from "./role.js";

describe("the agent's Proxmox role", () => {
  it("includes Pool.Audit: without it Proxmox hides pool membership and every template reads as missing", () => {
    assert.ok(PROXMOX_AGENT_ROLE_PRIVILEGES.includes("Pool.Audit"));
    for (const p of ["VM.Allocate", "VM.Clone", "VM.Config.Network", "Datastore.AllocateSpace", "SDN.Use"]) {
      assert.ok(PROXMOX_AGENT_ROLE_PRIVILEGES.includes(p), p);
    }
    assert.ok(!PROXMOX_AGENT_ROLE_PRIVILEGES.some((p) => p.startsWith("Sys.") || p.startsWith("Permissions.") || p === "Pool.Allocate"));
  });

  it("is the exact command docs/host-agent.md gives the operator", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../../docs/host-agent.md", import.meta.url)), "utf8");
    assert.ok(doc.includes(proxmoxAgentRoleCommand()), "docs/host-agent.md must contain the role command from role.ts");
  });
});
