# softqraft-compute: repository instructions

This file supplements the canonical workspace contract at `C:\Projects\AGENTS.md` and may only make it stricter. User scope and exclusions take precedence over this file.

## Product and boundaries

- Compute is a federated child service of SoftQraft Cloud: virtual machines on SoftQraft's Hetzner bare-metal fleet. Its design lives in softqraft_labs `myDocs/compute/`; this repository links there and never copies it.
- Node 24+, pnpm 9.15, TypeScript strict, ESM, Fastify 5, `pg`, zod 3, `tsx --test`. Add a dependency only with a stated reason.
- `apps/api` is the control plane. It never talks to a hypervisor; host agents pull signed jobs over outbound HTTPS.
- `packages/contracts` owns the shared shapes. `packages/jobs` owns signing and verification. `packages/driver` owns the hypervisor interface. Packages never import from `apps/`.
- Modules in `apps/api/src/modules/<module>/` talk only through each other's `index.ts`. Dependencies are injected. Stores and drivers come from registries.
- `packages/federation` is the vendored `@softqraft/federation`. Never edit it by hand; replace it with the kit's `scripts/sync.mjs` from a release tag.
- Cloud owns identity, projects and prices. Compute meters usage and never prices it.

## Safety

- Never touch a real host, Proxmox, Hetzner, Cloudflare or AWS from this repository's code, tests or scripts without an approved brief for that step. Changes to a production host need founder approval on the day.
- The pilot network never overlaps `10.20.0.0/24` (production). Pilot caps come from env and hold under concurrency.
- Keys live in env only. Never log keys, tokens, signatures, enrolment tokens, job envelopes, headers or bodies. Tests generate keys at run time.

## Validation and delivery

- `pnpm run test:ci` with a real Postgres (`DATABASE_URL`): build, typecheck, unit tests, Postgres tests, `check:boundaries`, `check:federation-vendor`. Never skip, disable or weaken a test to get green; report what did not run.
- Work on a branch, commit after each logical step, never merge. The founder approves merges.
- In reports, distinguish implemented, locally tested, CI-tested, deployed and production-verified.

## Documentation rules

These rules are the same in every SoftQraft repository and in the workspace contract (`C:\Projects\AGENTS.md`). Keep the copies identical.

**Keep documents slim, current and in one place.** Code, tests and contracts are the source of truth. Documents explain intent, use and operation, and never restate code.

| What | Where |
|---|---|
| What this repo is, how to run, test and deploy it | `README.md` (short; link out) |
| Every user-visible change | `CHANGELOG.md` (Keep a Changelog, `Unreleased` at the top) |
| Vulnerability reporting, supported versions, secrets handling | `SECURITY.md` |
| Branches, PRs, tests, commits, these rules | `CONTRIBUTING.md` |
| The version | the package manifest, or `VERSION` if there is none; one source only |
| Public developer docs (API, SDK, integration) | `docs/` |
| Internal design, one folder per feature | `myDocs/<feature>/` |

- **One living design doc per feature:** `myDocs/<feature>/README.md`, starting with `Status:`, `Updated:` and `Owner:` lines, under about 150 lines, updated in place. Optional beside it: `decisions.md` (dated one-line decisions) and `runbook.md` (operate, deploy, roll back).
- **Working papers are temporary.** Briefs, audits, build records and rollout notes live in `myDocs/<feature>/work/` while the work is open. When it ships, move the lasting facts into the living doc, `CHANGELOG.md` and `decisions.md`, then delete the paper. Git history is the archive.
- **One canonical home for shared material.** Cross-repo contracts, brand and platform shape live in the repo that owns them; others link, never copy. Never edit vendored copies by hand.
- **A new `myDocs/` feature folder needs founder approval.**
- **Developer docs are part of done.** Every product update, enhancement or feature addition updates, in the same PR: `CHANGELOG.md` (always); `README.md` (setup, commands, configuration or behaviour changed); `SECURITY.md` (security model, secrets, exposure or supported versions changed); `CONTRIBUTING.md` (workflow or tooling changed); the version (on release); and the feature's living doc. A behaviour change without them is not done.
- **Product UI carries no developer text.** Screens show what the user needs for the task: no implementation notes, governance explanations, internal identifiers or developer instructions in the layout. Explanations go in docs or behind a help link. Existing screens get a later declutter pass; new work follows this rule now.
