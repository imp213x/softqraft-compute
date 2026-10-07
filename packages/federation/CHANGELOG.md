# Changelog

All notable changes to `@softqraft/federation`. Versions follow semver; each
release is a git tag `vX.Y.Z` in `imp213x/softqraft-federation`.

## 1.0.0 (unreleased; tagged after CTO review)

First release, built for F5.1 of the SoftQraft Service Federation.

### Added
- `contract`: `SQCF1` prefix, header names, error codes, §2 failure → HTTP
  status map, TTLs (skew 60s, nonce 300s, grant 60s, link grant 600s,
  operator session 3600s, Console session 28800s, fresh write 900s), grant
  prefixes (`sqlg_`, `sqlk_`, `sqog_`), session prefixes (`sqcs_`, `sqos_`),
  operator and Console role vocabularies.
- `signing`: canonical string with the audience as a parameter, `signRequest`,
  nonce generation. Byte-identical to the pre-package Cloud signer.
- `verify`: `verifyRequest` with a pluggable `KeyRing` and `NonceStore`,
  `parsePublicKeys`, `MemoryNonceStore`. Identical results to the
  pre-package Media verifier.
- `grants`: mint, hash and kind-strict parse for grants and session tokens;
  `isGrantUsable`.
- `paths`: `validateReturnPath` (Media's Console rule, generalised to any
  base path with forbidden API prefixes).
- `sessions`: `isSessionValid`, `evaluateSession`, `isFresh`, `requireFresh`.
- `roles`: `service:<id>:operate|view` slugs, `resolveOperatorRole`,
  `validateServiceId`.
- `descriptor`: `ServiceFederationDescriptor`, `validateDescriptor`,
  `operatorReturnPathPolicy`.
- `conformance`: `runConformance` runner with audience substitution,
  `packageTarget` reference target; `loadBundledVectors`.
- Vectors 1.1.0: v1.0 content unchanged, plus `operatorLaunch`, `sequences`,
  `crossAudience`, `grantIsolation`, `returnPath` and `sessions`.
- `scripts/sync.mjs` and `scripts/verify-vendored.mjs` for pinned,
  checksummed vendoring.
