/**
 * Contract §9 conformance runner.
 *
 * `runConformance(target, vectors)` executes the shared vectors against a
 * service's verifier and, when supplied, its session policy, grant parser,
 * return-path validator and (for Cloud) its signer. It returns one result
 * per case and never throws for a failing case.
 *
 * The vectors are passed in as a parsed JSON object: the runner does no
 * file I/O. `loadBundledVectors()` in `./vectors.js` reads the copy that
 * ships with the package.
 *
 * Audience substitution. The vector signatures are made for
 * `vectors.audience` (`realtime-media`). For any other target audience the
 * runner re-signs every signed case with the published TEST key under the
 * target's audience, keeping every other field, so the same negative cases
 * apply to every service. The unmodified signatures then act as extra
 * cross-audience cases, which must fail with `signature`.
 */

import { Buffer } from "node:buffer";
import { createPrivateKey, type KeyObject } from "node:crypto";
import {
  CONTRACT_NAME,
  FAILURE_RESPONSES,
  VERIFY_FAILURES,
  type GrantKind,
  type VerifyFailure,
} from "./contract.js";
import { parseGrant } from "./grants.js";
import { validateReturnPath, type ReturnPathOptions } from "./paths.js";
import { isFresh, isSessionValid, type SessionValidityInput } from "./sessions.js";
import { signRequest } from "./signing.js";
import {
  MemoryNonceStore,
  parsePublicKeys,
  verifyRequest,
  type NonceStore,
} from "./verify.js";

// ---------------------------------------------------------------------------
// Vector schema
// ---------------------------------------------------------------------------

export type VectorHeaders = Record<string, string>;

export interface SignedVector {
  name: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
  bodySha256: string;
  canonicalString: string;
  headers: VectorHeaders;
  verifyAt: number;
  note?: string;
}

export interface InvalidVector {
  name: string;
  reason: VerifyFailure;
  verifyAt: number;
  method: string;
  path: string;
  body: string;
  headers: VectorHeaders;
  note?: string;
}

export interface SequenceStep {
  /** `<section>/<name>`, section one of: valid, invalid, operatorLaunch.valid, operatorLaunch.invalid. */
  ref: string;
  /** Overrides the referenced case's verifyAt. */
  verifyAt?: number;
  expect: "ok" | VerifyFailure;
}

export interface SequenceVector {
  name: string;
  note?: string;
  steps: SequenceStep[];
}

export interface CrossAudienceVector {
  name: string;
  signedFor: string;
  verifyAs: string;
  expect: "ok" | "signature";
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
  headers: VectorHeaders;
  verifyAt: number;
  note?: string;
}

export interface GrantIsolationVector {
  name: string;
  value: string;
  expectedKind: GrantKind;
  accept: boolean;
  /** SHA-256 hex of `value`, present when accepted. */
  hash?: string;
}

export interface ReturnPathVector {
  name: string;
  profile: string;
  path: string;
  accept: boolean;
}

export interface SessionValidityVector {
  name: string;
  createdAt: string;
  expiresAt?: string;
  ttlSeconds?: number;
  revokedAfter?: string | null;
  now: string;
  valid: boolean;
  reason?: string;
}

export interface SessionFreshnessVector {
  name: string;
  createdAt: string;
  now: string;
  maxAgeSeconds: number;
  fresh: boolean;
}

export interface FederationVectors {
  contract: string;
  warning: string;
  audience: string;
  clockSkewSeconds: number;
  nonceTtlSeconds: number;
  testKey: { keyId: string; privateKeyPem: string; publicKeyPem: string };
  valid: SignedVector[];
  invalid: InvalidVector[];
  replay: { name: string; note: string };
  // F5 additions (all optional so the v1.0 legacy file still loads).
  vectorsVersion?: string;
  conventions?: Record<string, string>;
  operatorLaunch?: { valid: SignedVector[]; invalid: InvalidVector[] };
  sequences?: SequenceVector[];
  crossAudience?: CrossAudienceVector[];
  grantIsolation?: GrantIsolationVector[];
  returnPath?: {
    profiles: Record<string, { basePath: string; forbiddenPrefixes: string[] }>;
    cases: ReturnPathVector[];
  };
  sessions?: {
    validity: SessionValidityVector[];
    freshness: SessionFreshnessVector[];
  };
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

export interface ConformanceRequest {
  method: string;
  path: string;
  /** Raw body as sent (UTF-8). */
  rawBody: string;
  headers: VectorHeaders;
  now: Date;
  /**
   * A nonce store for this case, fresh per case and shared across the steps
   * of one sequence. A target that exercises its own store instead must
   * implement `reset`.
   */
  nonceStore: NonceStore;
}

export type ConformanceVerifyResult =
  | { ok: true; keyId?: string }
  | { ok: false; code: string; status: number };

export interface ConformanceTarget {
  /** The service's audience id. */
  audience: string;
  /** The service's verifier, configured with the vectors' TEST public key. */
  verify(req: ConformanceRequest): ConformanceVerifyResult | Promise<ConformanceVerifyResult>;
  /** Called before every case and sequence, e.g. to clear the target's own nonce store. */
  reset?(): void | Promise<void>;
  sessionPolicy?: {
    isSessionValid(input: SessionValidityInput): boolean;
    isFresh(input: { createdAt: string; now: string; maxAgeSeconds: number }): boolean;
  };
  grants?: { parse(value: string, kind: GrantKind): string | null };
  returnPaths?: { validate(path: string, options: ReturnPathOptions): boolean };
  /** Cloud's signer, checked for byte-identical headers on every signed vector. */
  signer?: {
    sign(input: {
      audience: string;
      keyId: string;
      privateKeyPem: string;
      method: string;
      path: string;
      body: string;
      now: number;
      nonce: string;
    }): Record<string, string> | Promise<Record<string, string>>;
  };
}

export interface ConformanceResult {
  case: string;
  pass: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A key ring holding only the vectors' TEST public key. */
export function conformanceKeyRing(vectors: FederationVectors): Map<string, KeyObject> {
  return parsePublicKeys({ [vectors.testKey.keyId]: vectors.testKey.publicKeyPem });
}

/**
 * A target built from this package's own functions: the reference that a
 * service's target should behave like.
 */
export function packageTarget(audience: string, vectors: FederationVectors): ConformanceTarget {
  const keyRing = conformanceKeyRing(vectors);
  return {
    audience,
    verify: (req) =>
      verifyRequest({
        audience,
        method: req.method,
        path: req.path,
        rawBody: req.rawBody,
        headers: req.headers,
        keyRing,
        nonceStore: req.nonceStore,
        now: req.now,
      }),
    sessionPolicy: { isSessionValid, isFresh },
    grants: { parse: (value, kind) => parseGrant(value, kind) },
    returnPaths: { validate: (path, options) => validateReturnPath(path, options) },
    signer: {
      sign: ({ privateKeyPem, ...rest }) => ({ ...signRequest({ ...rest, privateKey: privateKeyPem }) }),
    },
  };
}

export function summarize(results: readonly ConformanceResult[]): {
  total: number;
  passed: number;
  failed: number;
  failures: ConformanceResult[];
} {
  const failures = results.filter((r) => !r.pass);
  return {
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    failures,
  };
}

function headerValue(headers: VectorHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function describe(result: ConformanceVerifyResult): string {
  if (result.ok) return "ok";
  // Explicit cast: services compiled without strictNullChecks do not narrow on `ok`.
  const failure = result as { code: string; status: number };
  return `${failure.status} ${failure.code}`;
}

function matches(
  result: ConformanceVerifyResult,
  expect: "ok" | VerifyFailure,
  keyId: string,
): boolean {
  if (expect === "ok") {
    return result.ok === true && (result.keyId === undefined || result.keyId === keyId);
  }
  const want = FAILURE_RESPONSES[expect];
  return result.ok === false && result.code === want.code && result.status === want.status;
}

function expectLabel(expect: "ok" | VerifyFailure): string {
  if (expect === "ok") return "ok";
  const want = FAILURE_RESPONSES[expect];
  return `${want.status} ${want.code}`;
}

interface PreparedCase {
  method: string;
  path: string;
  body: string;
  headers: VectorHeaders;
  verifyAt: number;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runConformance(
  target: ConformanceTarget,
  vectors: FederationVectors,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const record = (name: string, pass: boolean, detail: string): void => {
    results.push({ case: name, pass, detail });
  };

  if (vectors.contract !== CONTRACT_NAME) {
    record("vectors/contract", false, `expected ${CONTRACT_NAME}, got ${vectors.contract}`);
    return results;
  }
  record("vectors/contract", true, CONTRACT_NAME);

  const keyId = vectors.testKey.keyId;
  const privateKey = createPrivateKey(vectors.testKey.privateKeyPem);
  const substitute = target.audience !== vectors.audience;
  const signedSections: Array<[string, SignedVector[]]> = [
    ["valid", vectors.valid],
    ["operatorLaunch.valid", vectors.operatorLaunch?.valid ?? []],
  ];
  const invalidSections: Array<[string, InvalidVector[]]> = [
    ["invalid", vectors.invalid],
    ["operatorLaunch.invalid", vectors.operatorLaunch?.invalid ?? []],
  ];

  // Original signature → signature for the target audience.
  const resigned = new Map<string, string>();
  if (substitute) {
    for (const [, cases] of signedSections) {
      for (const v of cases) {
        const original = headerValue(v.headers, "x-sq-cloud-signature");
        if (original === undefined) continue;
        const headers = signRequest({
          audience: target.audience,
          keyId: headerValue(v.headers, "x-sq-cloud-key-id") ?? keyId,
          privateKey,
          method: v.method,
          path: v.path,
          body: v.body,
          now: v.timestamp,
          nonce: v.nonce,
        });
        resigned.set(original, headers["X-SQ-Cloud-Signature"]);
      }
    }
  }
  const prepareHeaders = (headers: VectorHeaders): VectorHeaders => {
    if (!substitute) return { ...headers };
    const out: VectorHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      out[key] =
        key.toLowerCase() === "x-sq-cloud-signature" ? (resigned.get(value) ?? value) : value;
    }
    return out;
  };

  const byRef = new Map<string, PreparedCase>();
  for (const [section, cases] of [...signedSections, ...invalidSections]) {
    for (const v of cases) {
      byRef.set(`${section}/${v.name}`, {
        method: v.method,
        path: v.path,
        body: v.body,
        headers: prepareHeaders(v.headers),
        verifyAt: v.verifyAt,
      });
    }
  }

  const runOne = async (
    prepared: PreparedCase,
    nonceStore: NonceStore,
    verifyAt = prepared.verifyAt,
  ): Promise<ConformanceVerifyResult> =>
    target.verify({
      method: prepared.method,
      path: prepared.path,
      rawBody: prepared.body,
      headers: { ...prepared.headers },
      now: new Date(verifyAt * 1000),
      nonceStore,
    });

  const check = async (
    name: string,
    prepared: PreparedCase,
    expect: "ok" | VerifyFailure,
  ): Promise<void> => {
    try {
      await target.reset?.();
      const result = await runOne(prepared, new MemoryNonceStore());
      record(
        name,
        matches(result, expect, keyId),
        `expected ${expectLabel(expect)}, got ${describe(result)}`,
      );
    } catch (error) {
      record(name, false, `threw: ${(error as Error).message}`);
    }
  };

  // Signer (Cloud): byte-identical headers for every signed vector.
  if (target.signer) {
    for (const [section, cases] of signedSections) {
      for (const v of cases) {
        const name = `signer/${section}/${v.name}`;
        try {
          const headers = await target.signer.sign({
            audience: vectors.audience,
            keyId,
            privateKeyPem: vectors.testKey.privateKeyPem,
            method: v.method,
            path: v.path,
            body: v.body,
            now: v.timestamp,
            nonce: v.nonce,
          });
          const mismatched = Object.entries(v.headers).filter(
            ([header, value]) => headerValue(headers, header) !== value,
          );
          record(
            name,
            mismatched.length === 0,
            mismatched.length === 0
              ? "headers byte-identical"
              : `mismatched headers: ${mismatched.map(([h]) => h).join(", ")}`,
          );
        } catch (error) {
          record(name, false, `threw: ${(error as Error).message}`);
        }
      }
    }
  }

  // Signed valid cases, as given and with lowercase header names.
  for (const [section, cases] of signedSections) {
    for (const v of cases) {
      const prepared = byRef.get(`${section}/${v.name}`)!;
      await check(`verify/${section}/${v.name}`, prepared, "ok");
      const lower: VectorHeaders = {};
      for (const [k, value] of Object.entries(prepared.headers)) lower[k.toLowerCase()] = value;
      await check(`verify/${section}/${v.name}#lowercase-headers`, { ...prepared, headers: lower }, "ok");
    }
  }

  // Negative cases.
  for (const [section, cases] of invalidSections) {
    for (const v of cases) {
      if (!VERIFY_FAILURES.includes(v.reason)) {
        record(`verify/${section}/${v.name}`, false, `unknown reason ${String(v.reason)}`);
        continue;
      }
      await check(`verify/${section}/${v.name}`, byRef.get(`${section}/${v.name}`)!, v.reason);
    }
  }

  // Sequences share one nonce store across their steps.
  const sequences: SequenceVector[] = vectors.sequences ?? [
    {
      name: vectors.replay.name,
      note: vectors.replay.note,
      steps: [
        { ref: `valid/${vectors.valid[1]?.name ?? ""}`, expect: "ok" },
        { ref: `valid/${vectors.valid[1]?.name ?? ""}`, expect: "replay" },
      ],
    },
  ];
  for (const seq of sequences) {
    const name = `sequence/${seq.name}`;
    try {
      await target.reset?.();
      const store = new MemoryNonceStore();
      const outcomes: string[] = [];
      let pass = true;
      for (const step of seq.steps) {
        const prepared = byRef.get(step.ref);
        if (!prepared) {
          pass = false;
          outcomes.push(`${step.ref}: unknown ref`);
          break;
        }
        const result = await runOne(prepared, store, step.verifyAt ?? prepared.verifyAt);
        const ok = matches(result, step.expect, keyId);
        outcomes.push(`${step.ref} → ${describe(result)}${ok ? "" : ` (expected ${expectLabel(step.expect)})`}`);
        if (!ok) {
          pass = false;
          break;
        }
      }
      record(name, pass, outcomes.join("; "));
    } catch (error) {
      record(name, false, `threw: ${(error as Error).message}`);
    }
  }

  // Cross-audience.
  for (const v of vectors.crossAudience ?? []) {
    const name = `crossAudience/${v.name}`;
    const prepared: PreparedCase = {
      method: v.method,
      path: v.path,
      body: v.body,
      headers: { ...v.headers },
      verifyAt: v.verifyAt,
    };
    if (v.verifyAs === target.audience) {
      await check(name, prepared, v.expect);
    } else if (v.signedFor !== target.audience) {
      await check(`${name}@${target.audience}`, prepared, "signature");
    } else {
      record(name, true, `not applicable: signed for this audience (${target.audience})`);
    }
  }
  if (substitute) {
    // The original signatures belong to another audience here.
    for (const [section, cases] of signedSections) {
      for (const v of cases) {
        await check(
          `crossAudience/original-signature/${section}/${v.name}@${target.audience}`,
          {
            method: v.method,
            path: v.path,
            body: v.body,
            headers: { ...v.headers },
            verifyAt: v.verifyAt,
          },
          "signature",
        );
      }
    }
  }
  {
    // Synthesised: a signature for a foreign audience must fail here.
    const foreign = target.audience === "conformance-foreign" ? "conformance-other" : "conformance-foreign";
    const base = vectors.operatorLaunch?.valid[0] ?? vectors.valid[0];
    if (base) {
      const headers = signRequest({
        audience: foreign,
        keyId,
        privateKey,
        method: base.method,
        path: base.path,
        body: base.body,
        now: base.timestamp,
        nonce: base.nonce,
      });
      await check(
        `crossAudience/synthesised/${foreign}→${target.audience}`,
        { method: base.method, path: base.path, body: base.body, headers: { ...headers }, verifyAt: base.verifyAt },
        "signature",
      );
    }
  }

  // Grant isolation.
  if (target.grants) {
    for (const v of vectors.grantIsolation ?? []) {
      const name = `grantIsolation/${v.name}`;
      try {
        const hash = target.grants.parse(v.value, v.expectedKind);
        const pass = v.accept ? hash !== null && (v.hash === undefined || hash === v.hash) : hash === null;
        record(name, pass, `expected ${v.accept ? "accept" : "reject"} as ${v.expectedKind}, got ${hash === null ? "reject" : "accept"}`);
      } catch (error) {
        record(name, false, `threw: ${(error as Error).message}`);
      }
    }
  }

  // Return paths.
  if (target.returnPaths && vectors.returnPath) {
    for (const v of vectors.returnPath.cases) {
      const name = `returnPath/${v.name}`;
      const profile = vectors.returnPath.profiles[v.profile];
      if (!profile) {
        record(name, false, `unknown profile ${v.profile}`);
        continue;
      }
      try {
        const got = target.returnPaths.validate(v.path, profile);
        record(name, got === v.accept, `expected ${v.accept ? "accept" : "reject"}, got ${got ? "accept" : "reject"}`);
      } catch (error) {
        record(name, false, `threw: ${(error as Error).message}`);
      }
    }
  }

  // Session policy.
  if (target.sessionPolicy && vectors.sessions) {
    for (const v of vectors.sessions.validity) {
      const name = `sessions/validity/${v.name}`;
      try {
        const input: SessionValidityInput = { createdAt: v.createdAt, now: v.now };
        if (v.expiresAt !== undefined) input.expiresAt = v.expiresAt;
        if (v.ttlSeconds !== undefined) input.ttlSeconds = v.ttlSeconds;
        if (v.revokedAfter !== undefined) input.revokedAfter = v.revokedAfter;
        const got = target.sessionPolicy.isSessionValid(input);
        record(name, got === v.valid, `expected ${v.valid ? "valid" : "invalid"}, got ${got ? "valid" : "invalid"}`);
      } catch (error) {
        record(name, false, `threw: ${(error as Error).message}`);
      }
    }
    for (const v of vectors.sessions.freshness) {
      const name = `sessions/freshness/${v.name}`;
      try {
        const got = target.sessionPolicy.isFresh({
          createdAt: v.createdAt,
          now: v.now,
          maxAgeSeconds: v.maxAgeSeconds,
        });
        record(name, got === v.fresh, `expected ${v.fresh ? "fresh" : "stale"}, got ${got ? "fresh" : "stale"}`);
      } catch (error) {
        record(name, false, `threw: ${(error as Error).message}`);
      }
    }
  }

  return results;
}

/** Parse vectors from JSON text or bytes (no file access). */
export function parseVectors(json: string | Uint8Array): FederationVectors {
  const text = typeof json === "string" ? json : Buffer.from(json).toString("utf8");
  const parsed = JSON.parse(text) as FederationVectors;
  if (!parsed || parsed.contract !== CONTRACT_NAME) {
    throw new Error(`Vectors are not ${CONTRACT_NAME}`);
  }
  return parsed;
}
