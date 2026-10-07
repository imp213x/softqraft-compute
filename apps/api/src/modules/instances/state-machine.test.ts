import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INSTANCE_STATES, type InstanceState } from "@softqraft/compute-contracts";
import { assertTransition, canTransition, InvalidTransitionError, TRANSITIONS } from "./state-machine.js";

// Written out independently of TRANSITIONS, so the table is checked, not echoed.
const LEGAL = new Set([
  "pending>provisioning",
  "pending>deleting",
  "provisioning>running",
  "provisioning>error",
  "running>stopping",
  "running>deleting",
  "running>error",
  "stopping>stopped",
  "stopping>error",
  "stopped>starting",
  "stopped>deleting",
  "stopped>error",
  "starting>running",
  "starting>error",
  "deleting>deleted",
  "deleting>error",
  "error>deleting",
]);

describe("instance state machine", () => {
  it("has an entry for every state", () => {
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...INSTANCE_STATES].sort());
  });

  it("allows exactly the 17 listed moves", () => {
    let count = 0;
    for (const from of INSTANCE_STATES) count += TRANSITIONS[from].length;
    assert.equal(count, LEGAL.size);
  });

  for (const from of INSTANCE_STATES) {
    for (const to of INSTANCE_STATES) {
      const legal = LEGAL.has(`${from}>${to}`);
      it(`${legal ? "allows" : "refuses"} ${from} -> ${to}`, () => {
        assert.equal(canTransition(from, to), legal);
        if (legal) {
          assert.doesNotThrow(() => assertTransition(from, to));
        } else {
          assert.throws(
            () => assertTransition(from, to),
            (err: unknown) => err instanceof InvalidTransitionError && err.from === from && err.to === to,
          );
        }
      });
    }
  }

  it("treats deleted as terminal", () => {
    for (const to of INSTANCE_STATES) assert.equal(canTransition("deleted" as InstanceState, to), false);
  });
});
