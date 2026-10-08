# softqraft-compute

Virtual machines for SoftQraft Cloud, on SoftQraft's Hetzner bare-metal fleet. This repository holds the Compute control plane (the API, its database, the signed job queue and the hypervisor driver interface) and the host agent with its Proxmox driver. Compute joins Cloud as a federated provider of cloud-federation-v1, like Realtime Media: Cloud provisions service instances, customers open the Compute Console and staff open the fleet pages through one-time launches. The API also serves the customer Console at `/console/` and the staff fleet pages at `/admin/`.

Status: C1 pilot in build. C1d (console) and C1e (host agent) merged; C1f-a makes Compute ready to deploy and the pilot host ready to set up. Not deployed yet. Design: [softqraft_labs `myDocs/compute/`](https://github.com/imp213x/softqraft_labs/tree/main/myDocs/compute). API reference: [`docs/api.md`](docs/api.md). Host agent: [`docs/host-agent.md`](docs/host-agent.md). Deploy: [`docs/deploy.md`](docs/deploy.md).

## Layout

| Path | What |
|---|---|
| `apps/console` | The Console and staff fleet pages: static ES modules, no framework, no build step, served by the API. The parent brand is pinned in `brand-manifest.json`. |
| `apps/api` | Fastify control plane API. `src/index.ts` is the composition root; one public `index.ts` per module in `src/modules/`; SQL in `migrations/`. |
| `packages/contracts` | zod schemas and types shared by the API, the agent and Cloud |
| `packages/jobs` | Canonical JSON, signed job envelopes (`signJob`, `verifyJob`) and agent request signatures |
| `apps/host-agent` | The host agent: enrols, pulls and verifies signed jobs, runs them on Proxmox, reports usage. Dry-run mode. |
| `packages/driver` | `HypervisorDriver` (with capabilities), the in-memory `FakeDriver` and the driver registry |
| `packages/driver-proxmox` | Proxmox VE 8 API client (TLS pinned, fenced) and `ProxmoxDriver`, with `ensureImages` |
| `packages/proxmox-fake` | Test-only fake Proxmox HTTPS API |
| `deploy/host-agent` | Hardened systemd unit, `install.sh` (also installs Node 24 from a checksum-verified tarball) and the agent's env example |
| `Dockerfile`, `deploy/compose`, `deploy/scripts` | The API image (its build runs the test gate), the `softqraft-compute` Compose project for SQ-CLOUD-01 and `build-compute-image.sh` |
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

For the federated routes set `CLOUD_FEDERATION_ENABLED=true`, `CLOUD_FEDERATION_PUBLIC_KEYS` and `COMPUTE_PUBLIC_URL` (https in production); `CLOUD_OPERATOR_LAUNCH_ENABLED=true` adds the staff fleet routes and pages. `CLOUD_ORIGIN` names where "Sign in again" goes (required, https, in production with federation on). With federation off, only the agent routes and probes exist. The agent routes accept only `COMPUTE_AGENT_ALLOWED_IPS` (any IP when empty; required in production with federation on), resolved through `COMPUTE_TRUSTED_PROXY_CIDRS`.

To look at the pages without Cloud: `pnpm --filter @softqraft/compute-api preview` starts the API on the memory store with seeded fake data and prints launch links (`http://127.0.0.1:8099/__preview/launch?as=console`, `?as=operator`). It is for local use only.

Generate a local job signing key with `node -e 'console.log(require("crypto").generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}))'`. Every variable is listed in [`.env.example`](.env.example). Bad configuration stops startup with a message naming the variable.

The API never talks to a hypervisor. Host agents pull signed jobs from it.

## Deploy

Compute runs on SQ-CLOUD-01 as its own Compose project, `softqraft-compute` ([`deploy/compose/compute.compose.yml`](deploy/compose/compute.compose.yml)), behind Cloud's Cloudflare tunnel at `https://compute.softqraftlabs.com`, with its database on Neon. Build the image from a clean checkout with `sh ./deploy/scripts/build-compute-image.sh` (tag `softqraft/compute:<full commit SHA>`); the image build runs `pnpm run test:image`. Migrations run from the built `dist` in the same image (`node dist/migrate.js`). The release procedure, first-time setup and rollback are in [`docs/deploy.md`](docs/deploy.md). The founder runs every step.

## Host agent

The agent runs on each Proxmox host as the `softqraft-compute-agent` systemd service, configured by `/etc/softqraft/compute-agent.env`. Install it with `deploy/host-agent/install.sh` (Node 24 from the official tarball, checked against `SHASUMS256.txt`) and start it with `COMPUTE_AGENT_DRY_RUN=true` first. The pilot's templates are built by hand (`COMPUTE_AGENT_ENSURE_IMAGES=false`), and every pilot VM gets disk IO limits and `onboot=0`. Configuration, the Proxmox calls each job makes, the fences and the network guard are in [`docs/host-agent.md`](docs/host-agent.md); host setup is the runbook in softqraft_labs `myDocs/compute/runbook.md`. No browser console in C1.

## Test

```bash
pnpm run test:ci
```

`pnpm run test:image` is the same without the Postgres tests: it is the gate the image build runs. This builds, typechecks, runs the unit tests (including the Proxmox driver against a fake Proxmox, and the agent end to end against the built API and the fake Proxmox), runs the cloud-federation-v1 §9 conformance runner against Compute's verifier and session policy (`test:conformance`), runs the Postgres tests (they need `DATABASE_URL` and fail without it), then `check:boundaries`, `check:federation-vendor` and `check:console` (the parent brand pins and the UI contract test: brand tokens, no developer text, no semicolons or em dashes in copy, every error code mapped, CSP). CI runs it on Node 24 with a `postgres:16` service ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

For the Postgres tests locally: `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=local postgres:16`, then `DATABASE_URL=postgres://postgres:local@localhost:5432/postgres pnpm run test:pg`. Each run uses its own schemas and drops them.

## Brand

The pages inherit the SoftQraft Labs identity exactly, as Realtime Media does. `node scripts/sync-parent-brand.mjs` verifies the pinned files; `--source ../softqraft_labs` compares with a parent checkout and `--write` updates them intentionally, after review. Never invent a child brand.
