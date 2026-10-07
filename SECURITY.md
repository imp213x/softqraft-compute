# Security

## Reporting a vulnerability

Email **support@softqraftlabs.com** with a description, the affected component and steps to reproduce. Do not open a public issue for a vulnerability, and do not include live credentials in the report.

## Supported versions

| Component | Supported |
|---|---|
| Compute API (`apps/api`) | `main`. Nothing is deployed yet (C1 pilot in build). |
| `packages/*` | The versions in this repository. Not published. |

## Secrets

- Keys live only in the environment, never in the repository, logs or the database. `.env` and `.env.*` are git-ignored; `.env.example` holds placeholders only.
- `COMPUTE_JOB_SIGNING_KEY_PEM` (Ed25519 private key) signs every job. Agents get only the public key, at enrolment.
- `CLOUD_FEDERATION_PUBLIC_KEYS` holds Cloud's public keys (not secret). `DATABASE_URL` carries a database password.
- Host keys: each host generates its own Ed25519 key pair; the API stores only the public key.
- Enrolment tokens (`sqet_`) are shown once and stored only as SHA-256 hashes. They expire and work once.
- The API never logs keys, tokens, signatures, enrolment tokens, job envelopes, request headers or bodies.
- Tests generate their keys at run time. `packages/federation/vectors/cloud-federation-v1.vectors.json` (vendored) contains the kit's published TEST key. Never configure it anywhere.

## Security model

- Cloud-facing routes accept only Cloud-signed requests (cloud-federation-v1, audience `compute`), with a 60 s clock window and single-use nonces. They do not exist unless `CLOUD_FEDERATION_ENABLED=true`.
- Agents sign every request with their host key: body hash, a 300 s timestamp window and a single-use nonce. Agents verify every job's signature, target host and expiry before running it.
- The host agent pulls jobs over outbound HTTPS. No management port is opened on a host.
- Fleet (staff) routes are refused by default until the federation contract defines an operator-role claim.
- Only projects in `COMPUTE_ALLOWED_PROJECTS` may create instances (none by default). Pool caps hold under concurrency.
- The pilot network may never overlap `10.20.0.0/24` (production); startup refuses such a range.
- Abuse controls (outbound SMTP block, connection rate limits, kill switch) arrive with the host agent and host setup in C1b and C1d.
