# softqraft-compute

Virtual machines for SoftQraft Cloud, on SoftQraft's Hetzner bare-metal fleet. This repository holds the Compute control plane: the API, its database, the signed job queue and the hypervisor driver interface. The host agent and the Proxmox driver arrive in C1b.

Status: C1 pilot in build (C1a foundation). Design: [softqraft_labs `myDocs/compute/`](https://github.com/imp213x/softqraft_labs/tree/main/myDocs/compute). API reference: [`docs/api.md`](docs/api.md).

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify control plane API. `src/index.ts` is the composition root; one public `index.ts` per module in `src/modules/`; SQL in `migrations/`. |
| `packages/contracts` | zod schemas and types shared by the API, the agent and Cloud |
| `packages/jobs` | Canonical JSON, signed job envelopes (`signJob`, `verifyJob`) and agent request signatures |
| `packages/driver` | `HypervisorDriver`, the in-memory `FakeDriver` and the driver registry |
| `packages/federation` | Vendored `@softqraft/federation` v1.0.0. Never edit by hand. |
| `scripts/` | `check-boundaries.mjs` |

## Run

Needs Node 24 and pnpm 9.15 (`corepack enable`), and Postgres 16.

```bash
pnpm install --frozen-lockfile
pnpm run build
cp .env.example .env    # then fill in DATABASE_URL and COMPUTE_JOB_SIGNING_KEY_PEM
set -a; . ./.env; set +a
pnpm --filter @softqraft/compute-api migrate
pnpm --filter @softqraft/compute-api start     # or: dev (tsx watch)
```

Generate a local job signing key with `node -e 'console.log(require("crypto").generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}))'`. Every variable is listed in [`.env.example`](.env.example). Bad configuration stops startup with a message naming the variable.

The API never talks to a hypervisor. Host agents pull signed jobs from it.

## Test

```bash
pnpm run test:ci
```

This builds, typechecks, runs the unit tests, runs the Postgres tests (they need `DATABASE_URL` and fail without it), then `check:boundaries` and `check:federation-vendor`. CI runs it on Node 24 with a `postgres:16` service ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

For the Postgres tests locally: `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=local postgres:16`, then `DATABASE_URL=postgres://postgres:local@localhost:5432/postgres pnpm run test:pg`. Each run uses its own schemas and drops them.
