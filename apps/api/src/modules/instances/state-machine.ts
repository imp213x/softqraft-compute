/**
 * The instance state machine. Every allowed move is listed here; anything
 * else is refused. Tests check every pair of states against this table.
 *
 * | From         | To                                  | Why                                   |
 * |--------------|-------------------------------------|---------------------------------------|
 * | pending      | provisioning                        | placed on a host, create job queued   |
 * | pending      | deleting                            | deleted before placement              |
 * | provisioning | running                             | create job succeeded                  |
 * | provisioning | error                               | create job failed after last attempt  |
 * | running      | stopping                            | stop action                           |
 * | running      | deleting                            | delete                                |
 * | running      | error                               | (kept from C1a; no job sets it now)   |
 * | stopping     | stopped                             | stop job succeeded                    |
 * | stopping     | error                               | stop job failed after last attempt    |
 * | stopped      | starting                            | start action                          |
 * | stopped      | deleting                            | delete                                |
 * | stopped      | resizing                            | resize action, resize job queued      |
 * | stopped      | error                               | (kept from C1a; no job sets it now)   |
 * | starting     | running                             | start job succeeded                   |
 * | starting     | error                               | start job failed after last attempt   |
 * | resizing     | stopped                             | resize job succeeded                  |
 * | resizing     | error                               | resize job failed after last attempt  |
 * | deleting     | deleted                             | delete job succeeded (or never placed)|
 * | deleting     | error                               | delete job failed after last attempt  |
 * | error        | deleting                            | delete to clean up                    |
 * | deleted      | (none)                              | terminal                              |
 */

import type { InstanceState } from "@softqraft/compute-contracts";

export const TRANSITIONS: Readonly<Record<InstanceState, readonly InstanceState[]>> = Object.freeze({
  pending: Object.freeze(["provisioning", "deleting"] as const),
  provisioning: Object.freeze(["running", "error"] as const),
  running: Object.freeze(["stopping", "deleting", "error"] as const),
  stopping: Object.freeze(["stopped", "error"] as const),
  stopped: Object.freeze(["starting", "resizing", "deleting", "error"] as const),
  starting: Object.freeze(["running", "error"] as const),
  resizing: Object.freeze(["stopped", "error"] as const),
  deleting: Object.freeze(["deleted", "error"] as const),
  deleted: Object.freeze([] as const),
  error: Object.freeze(["deleting"] as const),
});

export function canTransition(from: InstanceState, to: InstanceState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: InstanceState;
  readonly to: InstanceState;
  constructor(from: InstanceState, to: InstanceState) {
    super(`An instance cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: InstanceState, to: InstanceState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
