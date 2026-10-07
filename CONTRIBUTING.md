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

## Checks that must pass

```bash
pnpm install --frozen-lockfile
DATABASE_URL=postgres://… pnpm run test:ci
```

`test:ci` builds, typechecks, runs unit tests and the Postgres tests, then `check:boundaries` and `check:federation-vendor`. CI runs the same in `.github/workflows/ci.yml`. A test is never skipped, disabled or weakened to get green; if something cannot run, say so in the pull request.

## Code rules

- Modules in `apps/api/src/modules/<module>/` talk to each other only through `index.ts`. Dependencies are injected; stores and drivers come from registries.
- Packages never import from `apps/`.
- Migrations are numbered and additive. Never edit one that has been applied; add a new file.
- API changes update `docs/api.md` and, for shapes, `packages/contracts`.

## Commit messages

A short prefix and a plain summary: `feat:`, `fix:`, `test:`, `docs:` or `chore:`.

## Documentation is part of done

Every product change updates `CHANGELOG.md` in the same pull request, and `README.md`, `SECURITY.md`, this file, the version and the feature's living doc when they are affected. Compute's living design doc is in softqraft_labs [`myDocs/compute/`](https://github.com/imp213x/softqraft_labs/tree/main/myDocs/compute). The full rules are in [AGENTS.md](AGENTS.md#documentation-rules).

## Never

- Commit secrets, `.env` files, keys or logs with credentials.
- Edit the vendored `packages/federation/**` by hand. Replace it with the kit's `scripts/sync.mjs` from a release tag; `pnpm run check:federation-vendor` checks it.
