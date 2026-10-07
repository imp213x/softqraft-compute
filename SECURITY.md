# Security

## Reporting a vulnerability

Email **support@softqraftlabs.com** with a description, the affected component and steps to reproduce. Do not open a public issue for a vulnerability, and do not include live credentials in the report.

## Supported versions

| Component | Supported |
|---|---|
| Compute API (`apps/api`) | `main`. Nothing is deployed yet (C1 pilot in build). |
| Host agent (`apps/host-agent`) | `main`. Not installed on any host yet (C1f). |
| `packages/*` | The versions in this repository. Not published. |

## Secrets

- Keys live only in the environment, never in the repository, logs or the database. `.env` and `.env.*` are git-ignored; `.env.example` holds placeholders only.
- `COMPUTE_JOB_SIGNING_KEY_PEM` (Ed25519 private key) signs every job. Agents get only the public key, at enrolment.
- `CLOUD_FEDERATION_PUBLIC_KEYS` holds Cloud's public keys (not secret). `DATABASE_URL` carries a database password.
- Host keys: each host generates its own Ed25519 key pair; the API stores only the public key. The agent keeps the private key in `/var/lib/softqraft-compute-agent/host-key.pem` (mode 0600, directory 0700) and refuses to start if either is readable by others.
- The agent's env file `/etc/softqraft/compute-agent.env` (owner root, mode 0600) holds the Proxmox token secret and, until first start, the enrolment token. The founder writes it on the host; it is never in git, chat or a ticket.
- **Proxmox token scope.** The agent's token `compute-agent@pve!agent` has the `ComputeAgent` role only on the pilot pool, the pilot storage and `vmbr10` (runbook section 4). The agent sends it only as `Authorization: PVEAPIToken=…`, only to the local API, and never logs it.
- Enrolment tokens (`sqet_`) are shown once and stored only as SHA-256 hashes. They work once and expire after 30 minutes.
- Launch grants (`sqlg_`, `sqog_`) and session tokens (`sqcs_`, `sqos_`) are stored only as SHA-256 hashes. Grants appear only in the launch URL fragment; session tokens only in their cookie.
- Console tickets are handed to the browser once and cleared; an untaken ticket is cleared within 5 minutes.
- The API never logs keys, grants, session tokens, cookies, console tickets, signatures, enrolment tokens, job envelopes, request or response headers, or bodies.
- Tests generate their keys at run time. `packages/federation/vectors/cloud-federation-v1.vectors.json` (vendored) contains the kit's published TEST key. Never configure it anywhere.

## Security model

- `/cloud/v1/*` accepts only Cloud-signed requests (cloud-federation-v1, audience `compute`), with a 60 s clock window and single-use nonces. They do not exist unless `CLOUD_FEDERATION_ENABLED=true`.
- **Sessions.** Customers reach `/console/v1/*` only with a Console session from a one-time Console launch (§3.2, §4). Staff reach `/admin/v1/*` only with an operator session from a one-time operator launch (§8). Grants live 60 s and work once. One generic `launch_invalid` covers every bad grant, and the two grant kinds never stand in for each other. Redemption is limited to 20 per minute per IP (in process memory).
- **Lifetimes and roles.** Console sessions last 8 hours and operator sessions 1 hour, both absolute (no sliding, no idle timeout, as in Realtime Media). Console viewers and operator viewers are read-only. Operator writes need a session younger than 15 minutes (`reauth_required`).
- **Cookies** (`sq_console_session`, `sq_admin_session`) are HttpOnly, SameSite=Strict, scoped to `/console` or `/admin`, and Secure when `COMPUTE_PUBLIC_URL` is https (it must be in production). Startup refuses `COMPUTE_COOKIE_SECURE=false` unless the public URL is a local development one (unset, `http://localhost` or `http://127.0.0.1`). `Max-Age` is the session lifetime. A new launch ends the browser's previous session.
- **Same origin.** Every cookie-authenticated mutation, redemption and logout must carry this service's `Origin`. `/console` and `/admin` responses carry `no-store`, `nosniff`, `DENY` framing, `no-referrer` and a strict CSP.
- **Revocation.** A §3.3 revocation sets the principal's `revoked_after` and deletes every Console and operator session of that principal. Cloud calls it when a SoftQraft sign-in ends.
- **Operator launch** and the Admin routes exist only while `CLOUD_OPERATOR_LAUNCH_ENABLED=true`. Turning it off ends every operator session, because the routes are gone. There is no local operator login and no break-glass credential.
- **Kill switch.** `POST /admin/v1/fleet/hosts/:id/disable`:
  - stops new work on the host;
  - lets its agent claim only stop and delete jobs, so a VM already being deleted is still removed;
  - queues a stop for every running instance on it;
  - stops anything that comes up there later.
  It is recorded as a security event in the same transaction as the change; every fleet write is, so a change without its audit record never commits. The switch holds under concurrency: disable, drain, enable and every job outcome lock the host row, and agent requests only record `last_seen_at` (and promote an `enrolled` host), so no request in flight can write the host back to `active` or bring an instance up unseen. On the host, `systemctl stop softqraft-compute-agent` stops the agent, and the runbook's kill-switch command stops every pilot VM.
- Agents sign every request with their host key: body hash, a 300 s timestamp window and a single-use nonce. Agents verify every job's signature, target host and expiry before running it.
- The host agent pulls jobs over outbound HTTPS. No management port is opened on a host.
- Only projects in `COMPUTE_ALLOWED_PROJECTS` may create instances (none by default). Pool caps hold under concurrency.
- The pilot network may never overlap `10.20.0.0/24` (production); startup refuses such a range.
- **Abuse controls.** The host's iptables rules (runbook section 3) block outbound SMTP and forwarding to production and rate-limit new connections. The agent checks at every start that the SMTP and production blocks are present and runs no job otherwise (`network_guard_missing`). Every VM gets the Proxmox firewall with IP and MAC filtering, inbound DROP, and the `ipfilter-net0` ipset pinned to its assigned address.
- The API never holds hypervisor credentials: console tickets come from the host agent. The Proxmox driver offers no console in C1.

## Host agent and Proxmox

- **TLS pinning.** The agent talks only to `https://127.0.0.1:<port>` (the local Proxmox API). The connection is checked against the certificate's SHA-256 fingerprint (`PROXMOX_TLS_FINGERPRINT`) before any request byte is sent, so the token never reaches a server that does not match. CA verification is skipped only for that pinned socket; it is never disabled globally.
- **Fences**, checked by the client before every call, so a refused call is never sent (`proxmox_fence_refused`):
  - VMIDs: instances only in `COMPUTE_VMID_RANGE` (2000-2999), templates only in 9000-9099, and templates are only read, cloned or converted;
  - pool: a VM is touched only after a read showed it in `PROXMOX_POOL`, and everything is created there;
  - storage: disks only on `PROXMOX_STORAGE`; vendor downloads only to `PROXMOX_IMPORT_STORAGE`, over https and with a checksum;
  - bridge: every NIC on `PROXMOX_BRIDGE` (`vmbr10`);
  - endpoints and parameters: a fixed list, on `PROXMOX_NODE` only.
- **Dry run** (`COMPUTE_AGENT_DRY_RUN=true`) sends no Proxmox write at all: writes are logged with secrets replaced and SSH keys counted, and every job is failed with `dry_run`.
- **Jobs** run only after `verifyJob` accepts them (signature by a key received at enrolment, this host, not expired). A refused job never reaches the driver.
- **Images** are downloaded by Proxmox with the hash from the vendor's published checksum list; a mismatch is discarded before import. The lists' GPG signatures are not verified yet.
- **The unit** runs as `softqraft-compute` with `NoNewPrivileges`, `ProtectSystem=strict`, write access only to the state directory, `PrivateTmp`, no capabilities and only IP and Unix sockets. Only its `ExecStartPre` runs privileged, to snapshot the FORWARD rules read-only.
- **Logs** are structured and redacted: no tokens, keys, signatures, envelopes or payloads.
