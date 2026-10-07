/**
 * A ComputeStore wrapper for deterministic interleaving tests. `pauseAfter`
 * holds the next transaction that makes a matching store call, right after
 * that call, until `release()`. Other requests can run meanwhile. On
 * Postgres that reproduces two concurrent transactions; the memory store
 * runs transactions one at a time, so there the second request waits.
 */

import type { ComputeStore, StoreTx } from "../src/store/index.js";

type Predicate = (args: unknown[], result: unknown) => boolean;

interface Pause {
  method: keyof StoreTx;
  predicate: Predicate;
  /** Pause right after the call, or at the end of the transaction, just before it commits. */
  at: "call" | "commit";
  reached: () => void;
  gate: Promise<void>;
}

export class HookedStore implements ComputeStore {
  private pause: Pause | null = null;
  private failing: keyof StoreTx | null = null;

  /** Make the next call of `method` throw, as a failed insert would. */
  failNext(method: keyof StoreTx): void {
    this.failing = method;
  }

  constructor(readonly inner: ComputeStore) {}

  get kind(): string {
    return this.inner.kind;
  }

  /** Pause the next transaction that calls `method` (and matches), after the call returns. */
  pauseAfter(method: keyof StoreTx, predicate: Predicate = () => true): { reached: Promise<void>; release: () => void } {
    return this.arm(method, predicate, "call");
  }

  /** Pause the next transaction that calls `method` (and matches) just before it commits. */
  pauseBeforeCommit(method: keyof StoreTx, predicate: Predicate = () => true): { reached: Promise<void>; release: () => void } {
    return this.arm(method, predicate, "commit");
  }

  private arm(method: keyof StoreTx, predicate: Predicate, at: Pause["at"]) {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reachedP = new Promise<void>((r) => (reached = r));
    this.pause = { method, predicate, at, reached, gate };
    return { reached: reachedP, release };
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.inner.transaction(async (tx) => {
      let heldAtCommit: Pause | null = null;
      const proxy = new Proxy(tx, {
        get: (target, prop, receiver) => {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (this.failing === prop) {
              this.failing = null;
              throw new Error(`injected failure in ${String(prop)}`);
            }
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            const p = this.pause;
            if (p && p.method === prop && p.predicate(args, result)) {
              this.pause = null;
              if (p.at === "commit") {
                heldAtCommit = p;
              } else {
                p.reached();
                await p.gate;
              }
            }
            return result;
          };
        },
      });
      const out = await fn(proxy);
      const held = heldAtCommit as Pause | null;
      if (held) {
        held.reached();
        await held.gate;
      }
      return out;
    });
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/** Wait for `p`, but no longer than `ms`. True when `p` settled in time. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  const done = p.then(
    () => true as const,
    () => true as const,
  );
  const settled = await Promise.race([done, timeout]);
  clearTimeout(timer);
  return settled;
}
