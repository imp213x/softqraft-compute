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
- Enrolment tokens (`sqet_`) are shown once and stored only as SHA-256 hashes. They work once and expire after 30 minutes.
- Launch grants (`sqlg_`, `sqog_`) and session tokens (`sqcs_`, `sqos_`) are stored only as SHA-256 hashes. Grants appear only in the launch URL fragment; session tokens only in their cookie.
- Console tickets are handed to the browser once and cleared; an untaken ticket is cleared within 5 minutes.
- The API never logs keys, grants, session tokens, cookies, console tickets, signatures, enrolment tokens, job envelopes, request or response headers, or bodies.
- Tests generate their keys at run time. `packages/federation/vectors/cloud-federation-v1.vectors.json` (vendored) contains the kit's published TEST key. Never configure it anywhere.

## Security model

- `/cloud/v1/*` accepts only Cloud-signed requests (cloud-federation-v1, audience `compute`), with a 60 s clock window and single-use nonces. They do not exist unless `CLOUD_FEDERATION_ENABLED=true`.
- **Sessions.** Customers reach `/console/v1/*` only with a Console session from a one-time Console launch (§3.2, §4). Staff reach `/admin/v1/*` only with an operator session from a one-time operator launch (§8). Grants live 60 s and work once. One generic `launch_invalid` covers every bad grant, and the two grant kinds never stand in for each other. Redemption is limited to 20 per minute per IP (in process memory).
- **Lifetimes and roles.** Console sessions last 8 hours and operator sessions 1 hour, both absolute (no sliding, no idle timeout, as in Realtime Media). Console viewers and operator viewers are read-only. Operator writes and Console deletes need a sign-in younger than 15 minutes (`reauth_required`).
- **Cookies** (`sq_console_session`, `sq_admin_session`) are HttpOnly, SameSite=Strict, scoped to `/console` or `/admin`, and Secure when `COMPUTE_PUBLIC_URL` is https (it must be in production). Startup refuses `COMPUTE_COOKIE_SECURE=false` unless the public URL is a local development one (unset, `http://localhost` or `http://127.0.0.1`). `Max-Age` is the session lifetime. A new launch ends the browser's previous session.
- **Same origin.** Every cookie-authenticated mutation, redemption and logout must carry this service's `Origin`.
- **Pages and CSP.** The Console and fleet pages (`apps/console`) are static files from this origin only. Every `/console` and `/admin` response carries `no-store`, `nosniff`, `DENY` framing, `no-referrer`, same-origin opener and resource policies, and the CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`. No inline script, style or handler; pages build the DOM from text nodes only, never from HTML strings; nothing is kept in browser storage. Only `.js`, `.css`, `.svg` and `.png` files under `modules/`, `styles/` and `assets/` are served. The launch page removes the grant from the address bar before redeeming it.
- **The 15-minute rule.** Deleting an instance or a snapshot needs a Console sign-in from the last 15 minutes (the session's `createdAt`; a new Cloud launch resets it): otherwise **403 `reauth_required`**, recorded as `auth.console_reauth_required`, and nothing changes. Operator writes follow the same 15-minute rule. The pages send people to sign in again through Cloud (`CLOUD_ORIGIN/cloud/open/compute`) or Ops (`CLOUD_ORIGIN/dashboard/services`), never to a fixed URL.
- **Saved SSH keys** are public keys only: ed25519, or RSA of at least 3072 bits, checked from the key blob. A pasted private key is refused and never stored or logged.
- **Revocation.** A §3.3 revocation sets the principal's `revoked_after` and deletes every Console and operator session of that principal. Cloud calls it when a SoftQraft sign-in ends.
- **Operator launch** and the Admin routes exist only while `CLOUD_OPERATOR_LAUNCH_ENABLED=true`. Turning it off ends every operator session, because the routes are gone. There is no local operator login and no break-glass credential.
- **Kill switch.** `POST /admin/v1/fleet/hosts/:id/disable`:
  - stops new work on the host;
  - lets its agent claim only stop and delete jobs, so a VM already being deleted is still removed;
  - queues a stop for every running instance on it;
  - stops anything that comes up there later.
  It is recorded as a security event in the same transaction as the change; every fleet write is, so a change without its audit record never commits. The switch holds under concurrency: disable, drain, enable and every job outcome lock the host row, and agent requests only record `last_seen_at` (and promote an `enrolled` host), so no request in flight can write the host back to `active` or bring an instance up unseen. The host-side kill switch (agent and VMs) arrives with C1e.
- Agents sign every request with their host key: body hash, a 300 s timestamp window and a single-use nonce. Agents verify every job's signature, target host and expiry before running it.
- The host agent pulls jobs over outbound HTTPS. No management port is opened on a host.
- Only projects in `COMPUTE_ALLOWED_PROJECTS` may create instances (none by default). Pool caps hold under concurrency.
- The pilot network may never overlap `10.20.0.0/24` (production); startup refuses such a range.
- Abuse controls on the host (outbound SMTP block, connection rate limits) arrive with the host agent and host setup in C1e and C1f.
- The API never holds hypervisor credentials: console tickets come from the host agent.
