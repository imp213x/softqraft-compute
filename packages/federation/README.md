# @softqraft/federation

The SoftQraft Service Federation kit: the reference implementation of the
`cloud-federation-v1` contract (including the F5 additions, §8 operator
launches and §9 conformance) for SoftQraft Cloud and every service that
federates with it.

**The package decides what is valid. Each service decides how to store and
serve it.** It has no HTTP framework code, no SQL and no storage beyond an
in-memory nonce store.

- Zero runtime dependencies: `node:crypto` and `node:buffer` only. The one
  exception is `loadBundledVectors()`, which dynamically imports
  `node:fs/promises` when called.
- TypeScript source, ESM, Node ≥ 22, `strict`, `NodeNext`. Internal imports
  use `.js` extensions, so services compile it with their own `tsc`.
- Private. Distributed by **vendoring**, not through a registry.

## Distribution: vendored, pinned and checksummed

```sh
# from a checkout of this repo, at a release tag
node scripts/sync.mjs ../softqraft-realtime-media/packages/federation
node scripts/sync.mjs ../softqraft_labs/vendor/softqraft-federation
```

`sync.mjs` copies `src/`, `vectors/`, `package.json`, `tsconfig.build.json`,
`README.md`, `CHANGELOG.md`, `LICENSE` and `scripts/verify-vendored.mjs`,
then writes `VENDORED.json`:

```json
{ "package": "@softqraft/federation", "version": "1.0.0",
  "tag": "v1.0.0", "commit": "<sha>", "files": { "src/index.ts": "<sha256>", "…": "…" } }
```

It refuses a working tree with uncommitted changes unless `--allow-dirty` is
given, in which case `tag` and `commit` are `null`. Files written by a
previous sync are removed first; nothing else in the target is touched.

Each service runs the verifier **from its own copy** in CI:

```sh
node packages/federation/scripts/verify-vendored.mjs packages/federation [--ignore tsconfig.json]
```

It exits 1 if any listed file is missing or changed, or any unlisted file is
present. `node_modules/`, `dist/` and `*.tsbuildinfo` are ignored; name any
other service-local file (for example a workspace `tsconfig.json`) with
`--ignore`. Never edit a vendored file: change this repo, release, re-sync.

`tsconfig.build.json` compiles `src/` to `dist/` standalone
(`tsc -p tsconfig.build.json`), which is what `package.json` `exports`
points at. A service may instead compile `src/` with its own config.

## Modules

| Module | Used by | Exports |
|---|---|---|
| `contract` | both | `CANONICAL_PREFIX`, `HEADERS`, `HEADERS_LOWER`, `ERROR_CODES`, `VERIFY_FAILURES`, `FAILURE_RESPONSES`, `CONTRACT_RESPONSES`, `SECURITY_EVENTS`, `ENDPOINTS`, TTL constants, `GRANT_PREFIX`, `SESSION_PREFIX`, `OPERATOR_ROLES`, `CONSOLE_ROLES` |
| `signing` | Cloud | `canonicalString`, `sha256Hex`, `createNonce`, `signRequest`, `assertAudience` |
| `verify` | services | `KeyRing`, `parsePublicKeys`, `NonceStore`, `MemoryNonceStore`, `verifyRequest` |
| `grants` | services | `mintGrant`, `hashGrant`, `parseGrant`, `isGrantUsable`, `grantTtlSeconds`, `mintSessionToken`, `parseSessionToken`, `sessionKindOf` |
| `paths` | services | `validateReturnPath` |
| `sessions` | services | `isSessionValid`, `evaluateSession`, `isFresh`, `requireFresh` |
| `roles` | Cloud | `validateServiceId`, `servicePermission`, `servicePermissions`, `resolveOperatorRole`, `operatorRoleCanWrite` |
| `descriptor` | Cloud | `ServiceFederationDescriptor`, `validateDescriptor`, `operatorReturnPathPolicy` |
| `conformance` | both | `runConformance`, `packageTarget`, `conformanceKeyRing`, `summarize`, `parseVectors`, vector types |
| `vectors` | both | `loadBundledVectors`, `bundledVectorsUrl` |

### Cloud: signing

```ts
import { signRequest, ENDPOINTS } from "@softqraft/federation";

const body = JSON.stringify({ principal, role: "admin", returnPath: "/admin/" });
const headers = signRequest({
  audience: descriptor.audience,          // "realtime-media"
  keyId: env.CLOUD_FEDERATION_KEY_ID,
  privateKey: env.CLOUD_FEDERATION_PRIVATE_KEY_PEM,
  method: "POST",
  path: ENDPOINTS.operatorLaunches,
  body,
});
```

### Service: verifying

```ts
import { parsePublicKeys, verifyRequest, type NonceStore } from "@softqraft/federation";

const keyRing = parsePublicKeys(env.CLOUD_FEDERATION_PUBLIC_KEYS);   // at boot; throws on bad config
const nonceStore: NonceStore = {                                     // your storage
  claim: (nonce, ttlSeconds, now) => db.claimNonce(nonce, ttlSeconds, now),
};

const result = await verifyRequest({
  audience: "realtime-media",
  method: req.method, path: req.url, rawBody: req.rawBody, headers: req.headers,
  keyRing, nonceStore,
});
if (!result.ok) return reply.code(result.status).send({ error: { code: result.code, … } });
```

`NonceStore.claim` must be an atomic check-and-set: true when the nonce was
free (and is now held until `now + ttlSeconds`), false when it is still held.

### Grants and sessions

```ts
const { grant, hash, expiresAt } = mintGrant("operator");  // store hash; grant goes only in the URL fragment
const presentedHash = parseGrant(body.grant, "operator");  // null for sqlg_/sqlk_/sqos_/malformed → 401 launch_invalid

isSessionValid({ createdAt, ttlSeconds: OPERATOR_SESSION_TTL_SECONDS, revokedAfter, now });
requireFresh({ createdAt, now });                          // { ok:false, status:403, code:"reauth_required" }
```

## Boundary decisions

All boundaries match the existing Media implementation, which was read and
tested against directly (see "Compatibility").

| Rule | Boundary | Media source |
|---|---|---|
| Clock skew | `|now − timestamp| ≤ 60s` accepted (inclusive); 60.001s is stale | `federation-signing.ts` `skewSeconds <= 60` |
| Nonce hold | held while `now < claimedAt + 300s`; free again at exactly 300s | `MemoryFederationNonceStore` `expiresAt > nowMs` |
| Grant expiry | usable while `now < expiresAt` (exclusive) and unused | `isGrantUsable`, SQL `expires_at > $2` |
| Session expiry | valid while `now < expiresAt` (exclusive); with both `expiresAt` and `ttlSeconds` the earlier wins | `isSessionValid`, SQL `s.expires_at > $2` |
| `revoked_after` | valid only if `createdAt > revokedAfter` (strict); created at the revocation instant = revoked | `isSessionValid`, SQL `s.created_at > p.revoked_after` |
| Freshness | fresh while `now − createdAt < 900s` (strict): 899s fresh, 900s and 901s not | `requireFreshCloudSession` |
| Return path | as Media's `isSafeReturnPath`, generalised to any base path, plus forbidden prefixes matched case-insensitively and including the bare stem (`/admin/v1`) | `cloud-federation/routes.ts` |
| Grant format | prefix + exactly 43 base64url characters, no trimming | Console redeem schema `^sqlg_[A-Za-z0-9_-]{43}$` |

Invalid or missing times fail closed. Signing rejects inputs the verifier
could never accept (a key id outside `[A-Za-z0-9._-]{1,64}`, a non-letter
method, a path with line breaks, an audience that is not a service id); for
every input the old Cloud signer accepted and Media could verify, output is
byte-identical.

## Conformance (contract §9)

```ts
import { loadBundledVectors, runConformance, summarize } from "@softqraft/federation";

const vectors = await loadBundledVectors();
const results = await runConformance({
  audience: "workforce",
  verify: (req) => myVerifier(req),        // configured with vectors.testKey.publicKeyPem
  sessionPolicy: { isSessionValid, isFresh },
  grants: { parse: myParseGrant },
  returnPaths: { validate: myValidateReturnPath },
}, vectors);
assert.equal(summarize(results).failed, 0);
```

Each case gets a fresh `MemoryNonceStore` in `req.nonceStore`; a sequence's
steps share one. A target that exercises its own store implements `reset()`.
For an audience other than `realtime-media` the runner re-signs every signed
vector with the TEST key under that audience, and additionally checks that
the original signatures fail with `federation_signature`. `packageTarget()`
is the reference target built from this package.

## Vectors

`vectors/cloud-federation-v1.vectors.json` is the v1.0 file with F5 sections
appended. Every v1.0 byte is preserved (the tests assert its SHA-256 and that
it is an exact prefix). New sections: `conventions`, `operatorLaunch`,
`sequences`, `crossAudience`, `grantIsolation`, `returnPath`, `sessions`.
They are generated deterministically:

```sh
npx tsx scripts/generate-vectors.ts          # rewrite
npx tsx scripts/generate-vectors.ts --check  # CI: fail if out of date
```

The key in the file is a published **TEST key only**. Never configure it.

## Development

```sh
npm install
npm run typecheck
npm test
npm run vectors:check
```

## Security notes

- Nothing in `src/` logs. Callers must never log grants, session tokens,
  signatures, private keys, raw signed bodies or launch URLs.
- Error messages from `parsePublicKeys` and `signRequest` never contain key
  material.
- A grant is stored only as its SHA-256; the secret appears only in the
  launch URL fragment.
