/**
 * The Proxmox role the host agent's token needs, granted on the pool, the
 * pilot storage and the bridge only (Compute runbook, agent identity step).
 * One list, so the docs and the operator's command cannot drift from it.
 *
 * Pool.Audit is read-only: without it Proxmox VE leaves `pool` out of
 * /cluster/resources, and the driver's pool fence then sees no VM as its own
 * (found on sq-node-01, Proxmox VE 9.2, during C1f-b).
 */
export const PROXMOX_AGENT_ROLE_PRIVILEGES: readonly string[] = Object.freeze([
  "VM.Allocate",
  "VM.Clone",
  "VM.Config.CDROM",
  "VM.Config.CPU",
  "VM.Config.Cloudinit",
  "VM.Config.Disk",
  "VM.Config.HWType",
  "VM.Config.Memory",
  "VM.Config.Network",
  "VM.Config.Options",
  "VM.PowerMgmt",
  "VM.Audit",
  "VM.Console",
  "VM.Snapshot",
  "Datastore.AllocateSpace",
  "Datastore.Audit",
  "SDN.Use",
  "Pool.Audit",
]);

/** The `pveum` command that creates the role. */
export function proxmoxAgentRoleCommand(): string {
  return `pveum role add ComputeAgent -privs "${PROXMOX_AGENT_ROLE_PRIVILEGES.join(" ")}"`;
}
