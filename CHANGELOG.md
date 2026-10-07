# Changelog

All notable changes to softqraft-compute are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
