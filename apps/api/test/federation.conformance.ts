/**
 * cloud-federation-v1 §9 conformance: the kit's runner against Compute's
 * own verifier (audience `compute`), session policy, grant parser and
 * return-path check. Every case must pass. Run by `pnpm run test:conformance`
 * (part of `test:ci`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conformanceKeyRing, loadBundledVectors, runConformance, summarize } from "@softqraft/federation";
import { FEDERATION_AUDIENCE, verifyCloudSigned } from "../src/modules/auth/index.js";
import {
  COMPUTE_SESSION_POLICY,
  isSafeReturnPath,
  parsePresentedGrant,
} from "../src/modules/sessions/index.js";

describe("cloud-federation-v1 conformance (§9), audience compute", () => {
  it("passes every shared vector with Compute's verifier, session policy, grants and return paths", async () => {
    assert.equal(FEDERATION_AUDIENCE, "compute");
    const vectors = await loadBundledVectors();
    const keyRing = conformanceKeyRing(vectors);
    const results = await runConformance(
      {
        audience: FEDERATION_AUDIENCE,
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
        sessionPolicy: COMPUTE_SESSION_POLICY,
        grants: { parse: (value, kind) => parsePresentedGrant(value, kind) },
        returnPaths: { validate: (path, options) => isSafeReturnPath(path, options) },
      },
      vectors,
    );
    const summary = summarize(results);
    const failures = results.filter((r) => !r.pass).map((r) => `${r.case}: ${r.detail}`);
    process.stdout.write(`# federation conformance (compute): ${summary.passed}/${summary.total} cases passed\n`);
    for (const section of ["verify/", "sequence/", "crossAudience/", "grantIsolation/", "returnPath/", "sessions/validity/", "sessions/freshness/"]) {
      const n = results.filter((r) => r.case.startsWith(section)).length;
      process.stdout.write(`#   ${section} ${n}\n`);
      assert.ok(n > 0, `${section} cases ran`);
    }
    assert.equal(summary.failed, 0, failures.join("\n"));
  });
});
