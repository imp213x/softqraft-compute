# Changelog

All notable changes to softqraft-compute are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
