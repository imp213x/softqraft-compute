# Contributing

## Branches and pull requests

- Work on a feature branch from `main`. Never push to `main` directly.
- Open a pull request into `main`. A pull request needs the founder's approval to merge. Agents never merge.
- Keep one logical change per pull request.
- Do not force-push shared branches or delete branches you did not create.

## Toolchain

- Node 24 or newer (`engines` in `package.json`).
- pnpm 9.15 (`packageManager` in `package.json`, installed by `corepack enable`).
- Postgres 16 for the Postgres tests.
- `openssl` on the PATH: the Proxmox tests generate a throwaway TLS certificate at run time.

## Checks that must pass

```bash
pnpm install --frozen-lockfile
DATABASE_URL=postgres://… pnpm run test:ci
```

`test:ci` builds, typechecks, runs the unit tests (the host agent's end-to-end test starts the built API, so run `pnpm run build` before `pnpm run test`), the cloud-federation-v1 §9 conformance runner (`test:conformance`) and the Postgres tests, then `check:boundaries`, `check:federation-vendor` and `check:console` (the parent brand pins and the Console UI contract). CI runs the same in `.github/workflows/ci.yml`. A test is never skipped, disabled or weakened to get green; if something cannot run, say so in the pull request.

The image build runs `pnpm run test:image` (everything in `test:ci` except the Postgres tests) inside a context without `.git`, `node_modules`, `.env*`, `deploy/`, `.github/` or `docs/` ([`.dockerignore`](.dockerignore)). So a test must never read those paths: it would pass in a checkout and fail the production build. Check a change that touches tests or tooling in a copy shaped like that context too:

```bash
CTX=$(mktemp -d)
git ls-files -co --exclude-standard | grep -Ev '^(deploy|docs|\.github)/|(^|/)\.env' \
  | while read -r f; do [ -f "$f" ] && mkdir -p "$CTX/$(dirname "$f")" && cp -p "$f" "$CTX/$f"; done
for d in node_modules apps/*/node_modules packages/*/node_modules; do ln -s "$PWD/$d" "$CTX/$d"; done
(cd "$CTX" && pnpm run test:image)
```

Shell scripts pass `sh -n` and `shellcheck`.

## Code rules

- Modules in `apps/api/src/modules/<module>/` talk to each other only through `index.ts`. Dependencies are injected; stores and drivers come from registries.
- Packages never import from `apps/`.
- No test, script or tool contacts a real Proxmox, Hetzner or host. Proxmox tests use `@softqraft/compute-proxmox-fake`, and vendor checksum lists are injected.
- Migrations are numbered and additive. Never edit one that has been applied; add a new file.
- API changes update `docs/api.md` and, for shapes, `packages/contracts`.

## Commit messages

A short prefix and a plain summary: `feat:`, `fix:`, `test:`, `docs:` or `chore:`.

## Documentation is part of done

Every product change updates `CHANGELOG.md` in the same pull request, and `README.md`, `SECURITY.md`, this file, the version and the feature's living doc when they are affected. Compute's living design doc is in softqraft_labs [`myDocs/compute/`](https://github.com/imp213x/softqraft_labs/tree/main/myDocs/compute). The full rules are in [AGENTS.md](AGENTS.md#documentation-rules).

## Never

- Commit secrets, `.env` files, keys or logs with credentials.
- Edit the vendored `packages/federation/**` by hand. Replace it with the kit's `scripts/sync.mjs` from a release tag; `pnpm run check:federation-vendor` checks it.
