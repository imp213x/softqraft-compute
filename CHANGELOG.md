# Changelog

All notable changes to softqraft-compute are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- C1f-a: Compute ready to deploy, and the pilot host ready to set up (founder decisions F1 to F9, 2026-10-08). Nothing is deployed.
  - **Image:** a multi-stage `Dockerfile` on Cloud's pinned Node 24 slim base, pnpm through corepack, whose build runs the new `pnpm run test:image` gate (everything in `test:ci` except the Postgres tests, which stay in CI). The runtime stage holds only the API's production dependencies, `dist`, migrations and console assets, and runs as `node`. A `host-agent-bundle` target exports the gated agent bundle. `.dockerignore` keeps `.git`, `node_modules`, `.env*`, `deploy/`, `.github/`, `docs/` and key files out of the context.
  - **`deploy/scripts/build-compute-image.sh`:** refuses a dirty tree, tags `softqraft/compute:<full commit SHA>`, checks the entry point, migrations, console and non-root user; `--agent-bundle` writes the agent bundle with `install.sh` as one tarball and prints its SHA-256.
  - **`deploy/compose/compute.compose.yml`:** the `softqraft-compute` project for SQ-CLOUD-01. `compute-api` on `127.0.0.1:8080`, read-only, `cap_drop: ALL`, `no-new-privileges`, PID limit, 1 CPU and 1 GB, health check, log rotation, on the external network `softqraft-edge` as `compute-api` for Cloud's `cloudflared`. Migrations run from `dist`: `run --rm --no-deps compute-api node dist/migrate.js`. `deploy/compose/deployment.env.example`.
  - **`COMPUTE_AGENT_ALLOWED_IPS`:** enrolment and every `/v1/agent/` route accept only these IPs or CIDRs, checked against the trusted-proxy client IP before anything else; others get **403 `agent_ip_not_allowed`**, recorded as `agent.ip_not_allowed` with the IP only. Required in production with federation on.
  - **Pilot VM limits:** every create sets `mbps_rd`, `mbps_wr`, `iops_rd` and `iops_wr` on the VM's disk and `onboot=0`, from `COMPUTE_VM_DISK_MBPS` (default 100) and `COMPUTE_VM_DISK_IOPS` (default 2000).
  - **Hand-built templates:** with `COMPUTE_AGENT_ENSURE_IMAGES=false`, the agent checks templates 9000 and 9001 at start and refuses create jobs with `templates_missing` while one is missing.
  - **`proxmox_tls_pin_mismatch`:** one plain log line with the pinned and presented fingerprints and the re-pin procedure.
  - **`install.sh --node-tarball FILE --node-sha256 HEX`:** installs Node 24 from the official tarball into `/opt` after checking its digest and entries, and points the unit at it. No download, no apt source.
  - `docs/deploy.md` (first-time setup, release, rollback); `docs/host-agent.md` gains the Node install, the templates prerequisite and the re-pin procedure.

- C1e: the host agent and the Proxmox driver:
  - `@softqraft/compute-host-agent` (`apps/host-agent`, Node 24): configuration from `/etc/softqraft/compute-agent.env` validated with zod; an Ed25519 host key (0600) and the enrolment record in `/var/lib/softqraft-compute-agent` (0700); first-run enrolment with the one-time token, then the token is blanked in the env file or the operator is told to remove it; a loop that claims, verifies (`verifyJob`), runs and reports jobs, heartbeating inside the 120 s lease, with exponential backoff while the API is unreachable; usage samples every 60 s; structured logs without secrets; graceful SIGTERM.
  - Dry run (`COMPUTE_AGENT_DRY_RUN=true`): jobs are verified, Proxmox writes are logged without secrets and never sent, and each job is failed with `dry_run`.
  - Network guard: the agent runs no job unless the host's FORWARD rules block outbound SMTP and forwarding to production (`network_guard_missing`).
  - `@softqraft/compute-driver-proxmox`: a Proxmox VE 8 HTTP API client with `PVEAPIToken` authentication and TLS pinned to `PROXMOX_TLS_FINGERPRINT`; fences checked before every call (VMIDs 2000-2999 and templates 9000-9099, the pool, the storage, the bridge `vmbr10`, the node, an endpoint and parameter list); `ProxmoxDriver` with create (full clone, cores and memory, `net0` with the firewall, cloud-init, IP and MAC filtering with the `ipfilter-net0` ipset, disk resize, start), start, graceful stop, delete with purge, resize, snapshots, status and list, all idempotent; stable, secret-free error codes; `ensureImages` for Debian 12 and Ubuntu 24.04 templates from vendor cloud images verified against the vendor's checksum lists.
  - `deploy/host-agent`: a hardened systemd unit, `install.sh` (non-destructive) and `compute-agent.env.example`.
  - `@softqraft/compute-proxmox-fake`: a test-only fake Proxmox API that checks the token and records every call.
  - `HypervisorDriver.capabilities` (`console`, `resize`, `snapshot`) and `list()`. Instances carry their host driver's `capabilities`; the API refuses a resize, snapshot or console the driver cannot do with **409 `not_supported`**.
  - The API knows the `proxmox` driver (enrolment accepts it). Its capabilities in C1: no console (it needs a relay that comes later), resize and snapshots.
- C1d: the Compute console and the staff fleet pages:
  - `apps/console`: static, framework-free ES modules served by the API at `/console/` and `/admin/`, with no build step, `no-store` caching and a strict CSP (no inline script or style, connections to this origin only).
  - Customer console: an empty state with one "Create your first VM" button; a one-screen create with a suggested name, Small, Medium and Large presets, Ubuntu 24.04 preselected (Debian 12 offered) and the remembered SSH key; the VM list and detail with status in words, a copy-ready `ssh` command, usage hours, snapshots and one actions menu (Start or Stop, Resize only while stopped, Snapshot, Delete); delete by typing the VM name, and an inline "Sign in again to delete" when the sign-in is older than 15 minutes. Lists poll every 5 s only while something is changing. The console button shows only when the host offers a console.
  - Staff fleet: hosts with state in words, capacity used and free and last seen; Drain, "Stop all VMs on this host" (with a confirmation) and Enable, disabled for viewers with the reason; "Add a host" shows a one-time enrolment token with a copy button, its 30-minute expiry and a link to the runbook steps; a read-only table of all instances. Stale operator writes get "Sign in again", through Ops.
  - Every API error code maps to one plain sentence with the next step. No codes, ids or stack traces on screen.
  - The detail page reads the instance's `capabilities`: the console button shows only when `console` is true, and Resize and Snapshot are hidden when `resize` or `snapshot` is false. `not_supported` has its own plain sentence.
  - `GET /console/v1/sizes`: the presets, built from the pilot caps.
  - `GET`, `POST` and `DELETE /console/v1/ssh-keys`: saved public keys per service instance, ed25519 or RSA of at least 3072 bits, checked from the key blob (migration `004_ssh_keys`).
  - `GET /console/v1/instances/:id/usage` returns the instance's usage hours.
  - `GET /console/v1/auth/status` and `GET /admin/v1/auth/status` name the "Sign in again" destination from `CLOUD_ORIGIN`.
  - Configuration: `CLOUD_ORIGIN` (required, https, in production with federation on) and `COMPUTE_HOST_RUNBOOK_URL`.
  - The parent brand is pinned by SHA-256 (`scripts/sync-parent-brand.mjs`, `apps/console/brand-manifest.json`); `check:console` (brand pins and `scripts/check-console-ui.test.mjs`) runs in `test:ci`.
  - `pnpm --filter @softqraft/compute-api preview`: the pages on the memory store with seeded fake data, for local use.

- C1b: Compute is a federated provider of cloud-federation-v1, like Realtime Media:
  - Service instances (§3.1, §3.4, §7.1): `PUT`, `GET` and `health` under `/cloud/v1/service-instances/:id`, Cloud-signed with audience `compute`. Responses carry the contract's `mediaTenantId` field (`cld_` + 12 hex of sha256(serviceInstanceId)). `regionId` must be `COMPUTE_REGION_ID` (default `eu-central`).
  - Console launches (§3.2) and redemption (§4): one-time `sqlg_` grants, `sq_console_session` cookies (8 hours, HttpOnly, SameSite=Strict, `Path=/console`), sessions scoped to one service instance and a role (admin, developer, viewer). Viewers are read-only.
  - Operator launches (§8.2 to §8.4): `sqog_` grants in their own store, `sq_admin_session` cookies (1 hour, `Path=/admin`), roles owner, admin and viewer, writes only on a session younger than 15 minutes.
  - Revocation (§3.3) ends a principal's Console and operator sessions.
  - Grants and session tokens are stored only as SHA-256 hashes; security events record launches, re-auth refusals and fleet writes.
  - Console routes under `/console/v1`: instances, actions (`start`, `stop`, `resize`), snapshots, console tickets, images, usage, `auth/me`, `auth/logout`.
  - Fleet routes under `/admin/v1/fleet`: hosts, drain, disable (kill switch), enable, 30-minute enrolment tokens, all instances; plus `/admin/v1/auth/me` and `auth/logout`.
  - Read-only Cloud routes for the Cloud summary and Copilot: `/cloud/v1/service-instances/:id/instances` and `…/usage` (records in `usage`).
  - Resize (stopped only; the disk only grows), snapshot list and delete, and console tickets in the contracts, the job types, `HypervisorDriver` and `FakeDriver`. Snapshots hold disk against the pool cap.
  - Migration `002_service_instances` re-keys instances, idempotency keys and usage by service instance (additive; it refuses to run if instances or usage rows exist).
  - Configuration: `COMPUTE_PUBLIC_URL`, `COMPUTE_COOKIE_SECURE`, `COMPUTE_TRUSTED_PROXY_CIDRS`, `COMPUTE_DEFAULT_DISK_GB` (16), `COMPUTE_REGION_ID`, `COMPUTE_CONSOLE_WAIT_SECONDS`, `CLOUD_OPERATOR_LAUNCH_ENABLED`.
  - `test:conformance` runs the kit's §9 runner against Compute's verifier, session policy, grant parser and return-path check; it is part of `test:ci`.


- C1a foundation of the Compute control plane:
  - `@softqraft/compute-api`: Fastify API with instances, images, hosts, jobs, scheduler, IPAM, quotas, usage, auth and health modules; in-memory and Postgres stores; migration `001_initial` and a `migrate` script.
  - Instance lifecycle with an explicit state machine, `Idempotency-Key` on create, and pilot pool caps reserved atomically.
  - Signed job queue: Ed25519 envelopes over canonical JSON, leases, heartbeats, retries up to `COMPUTE_JOB_MAX_ATTEMPTS`, expired leases returned to the queue.
  - Cloud-facing routes verified with `@softqraft/federation` (audience `compute`), off unless `CLOUD_FEDERATION_ENABLED=true`.
  - Agent enrolment with one-time tokens stored as SHA-256 hashes, and host-signed agent requests.
  - Fleet routes, refused by default until the federation contract defines an operator-role claim.
  - Usage samples aggregated into vCPU-hours, memory GB-hours and disk GB-hours per project per hour.
  - `@softqraft/compute-contracts`, `@softqraft/compute-jobs` and `@softqraft/compute-driver` (with `FakeDriver`).
  - Vendored `@softqraft/federation` v1.0.0 with `check:federation-vendor`.
  - `check:boundaries`, `test:ci` and the CI workflow.
  - `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `.env.example` and `docs/api.md`.

### Changed

- A create now reads the cloned VM's config once (for its disk volume) and its config write also carries `onboot` and `scsi0`. The client fence allows `scsi0` in a config write only for the VM's own volume on `PROXMOX_STORAGE`.
- Blank lines in the agent's env file count as unset, so a copied env example takes the defaults. The example starts with `COMPUTE_AGENT_DRY_RUN=true` and `COMPUTE_AGENT_ENSURE_IMAGES=false`.

- **The 15-minute rule for Console deletes.** `DELETE` of an instance or a snapshot needs a Console sign-in from the last 15 minutes; otherwise **403 `reauth_required`**, recorded as `auth.console_reauth_required`. A new Cloud launch resets it.
- The browser CSP is stricter: `default-src 'none'`, no `'unsafe-inline'` styles and no `data:` images.
- `POST /console/v1/instances/:id/console` returns **409 `not_supported`** when the instance's host driver offers no console.

- Instances, usage and quotas belong to a Cloud service instance (`serviceInstanceId`) instead of a raw Cloud project id. `COMPUTE_ALLOWED_PROJECTS` still lists Cloud project ids and is checked through the service instance.
- `diskGb` is optional on create and defaults to 16 GB.
- Enrolment tokens always expire after 30 minutes; `COMPUTE_ENROLMENT_TOKEN_TTL_SECONDS` and the `ttlSeconds` field are gone.
- A disabled host's agent still authenticates, but can claim only stop and delete jobs. `host_disabled` is no longer an agent auth error.
- A failed snapshot job marks the snapshot `error` and no longer moves its instance to `error`.

### Removed

- The C1a `/v1/projects/*` and `/v1/images` routes, the deny-all `/v1/fleet/*` routes and the `OperatorAuthorizer`.

### Fixed

- The kill switch can no longer be undone by an agent request in flight: agent auth records `last_seen_at` and promotes only `enrolled` hosts, in one conditional update, and never writes the host's state back.
- A create or start that completes while its host is being disabled is stopped: job outcomes and host state changes take the host row lock (`FOR UPDATE`), so disable and completion are serialised.
- Snapshots and resizes read their instance under the pool lock, so a snapshot is never checked or sized against a disk a concurrent resize has changed.
- Locks are taken in one order everywhere: pool, then host, then instance.
- The kill switch no longer leaves a VM that is being deleted running: a disabled host may claim delete jobs as well as stops.
- `COMPUTE_COOKIE_SECURE=false` is refused at startup unless `COMPUTE_PUBLIC_URL` is a local development URL (unset, `http://localhost` or `http://127.0.0.1`), so session cookies cannot lose `Secure` on an https or federated deployment.
- Every fleet write (drain, disable, enable, enrolment token) and its `fleet.*` security event commit in one transaction: if the event cannot be written, the change is rolled back.
- Usage is metered at the size an instance had when it was used: a resize request records only a pending target (`pendingSize`, reserved against the pool), the spec changes when the resize completes, and each applied size is kept in an effective-dated history (migration `003_instance_sizes`). A failed resize leaves the spec and history unchanged and releases its reservation.
