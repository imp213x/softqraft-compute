# Security

## Reporting a vulnerability

Email **support@softqraftlabs.com** with a description, the affected component and steps to reproduce. Do not open a public issue for a vulnerability, and do not include live credentials in the report.

## Supported versions

| Component | Supported |
|---|---|
| Compute API (`apps/api`) | `main`. Nothing is deployed yet: the image and Compose project are ready, the founder deploys on C1f-b. |
| Host agent (`apps/host-agent`) | `main`. Not installed on any host yet (C1f-b). |
| `packages/*` | The versions in this repository. Not published. |

## Secrets

- Keys live only in the environment, never in the repository, logs or the database. `.env` and `.env.*` are git-ignored; `.env.example` holds placeholders only.
- `COMPUTE_JOB_SIGNING_KEY_PEM` (Ed25519 private key) signs every job. Agents get only the public key, at enrolment.
- `CLOUD_FEDERATION_PUBLIC_KEYS` holds Cloud's public keys (not secret). `DATABASE_URL` carries a database password.
- In production these live only in `/etc/softqraft/compute/runtime.env` on SQ-CLOUD-01, with the same owner and mode as Cloud's `runtime.env`. The founder types the Neon login and generates the job signing key on the VM ([`docs/deploy.md`](docs/deploy.md)). The image holds no secret, and `.dockerignore` keeps `.env*` and key files out of the build context.
- Host keys: each host generates its own Ed25519 key pair; the API stores only the public key. The agent keeps the private key in `/var/lib/softqraft-compute-agent/host-key.pem` (mode 0600, directory 0700) and refuses to start if either is readable by others.
- The agent's env file `/etc/softqraft/compute-agent.env` (owner root, mode 0600) holds the Proxmox token secret and, until first start, the enrolment token. The founder writes it on the host; it is never in git, chat or a ticket.
- **Proxmox token scope.** The agent's token `compute-agent@pve!agent` has the `ComputeAgent` role only on the pilot pool, the pilot storage and `vmbr10` (runbook section 4); the privilege list is `PROXMOX_AGENT_ROLE_PRIVILEGES` in `packages/driver-proxmox/src/role.ts` ([host-agent.md](docs/host-agent.md#proxmox-role)). It includes the read-only `Pool.Audit`, without which Proxmox hides pool membership and the pool fence refuses every VM. The agent sends it only as `Authorization: PVEAPIToken=…`, only to the local API, and never logs it.
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
  It is recorded as a security event in the same transaction as the change; every fleet write is, so a change without its audit record never commits. The switch holds under concurrency: disable, drain, enable and every job outcome lock the host row, and agent requests only record `last_seen_at` (and promote an `enrolled` host), so no request in flight can write the host back to `active` or bring an instance up unseen. On the host, `systemctl stop softqraft-compute-agent` stops the agent, and the runbook's kill-switch command stops every pilot VM.
- Agents sign every request with their host key: body hash, a 300 s timestamp window and a single-use nonce. Agents verify every job's signature, target host and expiry before running it.
- The host agent pulls jobs over outbound HTTPS. No management port is opened on a host.
- **Agent allow-list (founder decision F3).** Enrolment and every `/v1/agent/` route first check the client IP against `COMPUTE_AGENT_ALLOWED_IPS` (sq-node-01's public IPv4 and IPv6 addresses in the pilot; the host reaches Cloudflare over IPv6 by default), before the body is read. Anything else gets 403 `agent_ip_not_allowed`, recorded as the security event `agent.ip_not_allowed` with the IP only (at most 10 per IP per minute; every request is still refused). Production with federation on refuses to start without the list. The client IP comes from the trusted-proxy rules: `X-Forwarded-For` counts only from `COMPUTE_TRUSTED_PROXY_CIDRS` (the `softqraft-edge` Docker network). That subnet includes its gateway, which is the VM itself: a process on SQ-CLOUD-01 calling `127.0.0.1:8080` could set the header. That is accepted because the VM is already the trust boundary (its deploy user controls Docker). In front of it, a Cloudflare rule blocks these routes from every other source. Neither check tells the host from its guests: every VM on sq-node-01 (pilot VMs included) leaves through the same public address. The allow-list narrows who can try; host signatures and one-time enrolment tokens remain the authentication.
- Only projects in `COMPUTE_ALLOWED_PROJECTS` may create instances (none by default). Pool caps hold under concurrency.
- The pilot network may never overlap `10.20.0.0/24` (production); startup refuses such a range.
- **Abuse controls.** The host's iptables rules (runbook section 3) block outbound SMTP and forwarding to production and rate-limit new connections. The agent checks at every start that the SMTP and production blocks are present and runs no job otherwise (`network_guard_missing`). Every VM gets the Proxmox firewall with IP and MAC filtering, inbound DROP except one rule for SSH from the host's pilot-network address (the jump host), and the `ipfilter-net0` ipset pinned to its assigned address.
- The API never holds hypervisor credentials: console tickets come from the host agent. The Proxmox driver offers no console in C1.

## Image and container

- **Release gate.** The image build runs `pnpm run test:image` (build, typecheck, unit tests, the §9 conformance runner, boundaries, the vendored kit and the console checks) and fails without an image if anything fails. The Postgres tests run in CI. `build-compute-image.sh` refuses a dirty tree, tags the full commit SHA and checks the entry point, the migrations, the console and the non-root user.
- **Base.** The same pinned Node 24 slim image (by digest) as Cloud. The runtime stage holds only the API's production dependencies, its `dist`, the migrations and the console assets, root-owned, run as `node`.
- **Container** (`deploy/compose/compute.compose.yml`): read-only root file system, `tmpfs` `/tmp` (`noexec`, `nosuid`, `nodev`), every capability dropped, `no-new-privileges`, a PID limit, 1 CPU and 1 GB (F1), log rotation, and a health check. The port is bound to `127.0.0.1:8080` only; the public path is Cloud's `cloudflared` over the `softqraft-edge` network. No state on the VM (F2).

## Host agent and Proxmox

- **TLS pinning.** The agent talks only to `https://127.0.0.1:<port>` (the local Proxmox API). The connection is checked against the certificate's SHA-256 fingerprint (`PROXMOX_TLS_FINGERPRINT`) before any request byte is sent, so the token never reaches a server that does not match. CA verification is skipped only for that pinned socket; it is never disabled globally.
- **Fences**, checked by the client before every call, so a refused call is never sent (`proxmox_fence_refused`):
  - VMIDs: instances only in `COMPUTE_VMID_RANGE` (2000-2999), templates only in 9000-9099, and templates are only read, cloned or converted;
  - pool: a VM is touched only after a read showed it in `PROXMOX_POOL`, and everything is created there;
  - storage: disks only on `PROXMOX_STORAGE`; vendor downloads only to `PROXMOX_IMPORT_STORAGE`, over https and with a checksum;
  - bridge: every NIC on `PROXMOX_BRIDGE` (`vmbr10`);
  - endpoints and parameters: a fixed list, on `PROXMOX_NODE` only.
- **Re-pin (F9).** A certificate that no longer matches the pin is logged as one plain line with the pinned and presented fingerprints (public data) and the procedure in [`docs/host-agent.md`](docs/host-agent.md#re-pin-after-a-certificate-change). The agent never trusts the new certificate by itself.
- **Pilot VM limits (F7).** Every pilot VM's disk gets read and write limits (`COMPUTE_VM_DISK_MBPS`, default 100 MB/s, and `COMPUTE_VM_DISK_IOPS`, default 2000), and `onboot=0`, so a pilot VM cannot starve production's disks and never starts with the host.
- **Templates by hand (F4).** The pilot runs with `COMPUTE_AGENT_ENSURE_IMAGES=false`, so the token keeps rights only on the pool, the pilot storage and `vmbr10`. The agent only checks that the templates exist, and refuses creates while one is missing (`templates_missing`).
- **Node on the host (F6).** `install.sh` installs Node 24 only from the official tarball, after checking its SHA-256 against the digest the operator took from nodejs.org's `SHASUMS256.txt`, into `/opt`. No apt source is added, and the script never downloads.
- **Dry run** (`COMPUTE_AGENT_DRY_RUN=true`) sends no Proxmox write at all: writes are logged with secrets replaced and SSH keys counted, and every job is failed with `dry_run`.
- **Jobs** run only after `verifyJob` accepts them (signature by a key received at enrolment, this host, not expired). A refused job never reaches the driver.
- **Images**, when the agent builds them (`COMPUTE_AGENT_ENSURE_IMAGES=true`), are downloaded by Proxmox with the hash from the vendor's published checksum list; a mismatch is discarded before import. The lists' GPG signatures are not verified yet.
- **The unit** runs as `softqraft-compute` with `NoNewPrivileges`, `ProtectSystem=strict`, write access only to the state directory, `PrivateTmp`, no capabilities and only IP and Unix sockets. Only its `ExecStartPre` runs privileged, to snapshot the FORWARD rules read-only.
- **Logs** are structured and redacted: no tokens, keys, signatures, envelopes or payloads.
