# softqraft-compute

Virtual machines for SoftQraft Cloud, on SoftQraft's Hetzner bare-metal fleet. This repository holds the Compute control plane: the API, its database, the signed job queue and the hypervisor driver interface. Compute joins Cloud as a federated provider of cloud-federation-v1, like Realtime Media: Cloud provisions service instances, customers open the Compute Console and staff open the fleet pages through one-time launches. The API also serves the customer Console at `/console/` and the staff fleet pages at `/admin/`. The host agent and the Proxmox driver arrive in C1e.

Status: C1 pilot in build (C1d console). Design: [softqraft_labs `myDocs/compute/`](https://github.com/imp213x/softqraft_labs/tree/main/myDocs/compute). API reference: [`docs/api.md`](docs/api.md).

## Layout

| Path | What |
|---|---|
| `apps/console` | The Console and staff fleet pages: static ES modules, no framework, no build step, served by the API. The parent brand is pinned in `brand-manifest.json`. |
| `apps/api` | Fastify control plane API. `src/index.ts` is the composition root; one public `index.ts` per module in `src/modules/`; SQL in `migrations/`. |
| `packages/contracts` | zod schemas and types shared by the API, the agent and Cloud |
| `packages/jobs` | Canonical JSON, signed job envelopes (`signJob`, `verifyJob`) and agent request signatures |
| `packages/driver` | `HypervisorDriver`, the in-memory `FakeDriver` and the driver registry |
| `packages/federation` | Vendored `@softqraft/federation` v1.0.0. Never edit by hand. |
| `scripts/` | `check-boundaries.mjs`, `sync-parent-brand.mjs`, `check-console-ui.test.mjs` |

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

For the federated routes set `CLOUD_FEDERATION_ENABLED=true`, `CLOUD_FEDERATION_PUBLIC_KEYS` and `COMPUTE_PUBLIC_URL` (https in production); `CLOUD_OPERATOR_LAUNCH_ENABLED=true` adds the staff fleet routes and pages. `CLOUD_ORIGIN` names where "Sign in again" goes (required, https, in production with federation on). With federation off, only the agent routes and probes exist.

To look at the pages without Cloud: `pnpm --filter @softqraft/compute-api preview` starts the API on the memory store with seeded fake data and prints launch links (`http://127.0.0.1:8099/__preview/launch?as=console`, `?as=operator`). It is for local use only.

Generate a local job signing key with `node -e 'console.log(require("crypto").generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}))'`. Every variable is listed in [`.env.example`](.env.example). Bad configuration stops startup with a message naming the variable.

The API never talks to a hypervisor. Host agents pull signed jobs from it.

## Test

```bash
pnpm run test:ci
```

This builds, typechecks, runs the unit tests, runs the cloud-federation-v1 §9 conformance runner against Compute's verifier and session policy (`test:conformance`), runs the Postgres tests (they need `DATABASE_URL` and fail without it), then `check:boundaries`, `check:federation-vendor` and `check:console` (the parent brand pins and the UI contract test: brand tokens, no developer text, no semicolons or em dashes in copy, every error code mapped, CSP). CI runs it on Node 24 with a `postgres:16` service ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

For the Postgres tests locally: `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=local postgres:16`, then `DATABASE_URL=postgres://postgres:local@localhost:5432/postgres pnpm run test:pg`. Each run uses its own schemas and drops them.

## Brand

The pages inherit the SoftQraft Labs identity exactly, as Realtime Media does. `node scripts/sync-parent-brand.mjs` verifies the pinned files; `--source ../softqraft_labs` compares with a parent checkout and `--write` updates them intentionally, after review. Never invent a child brand.
