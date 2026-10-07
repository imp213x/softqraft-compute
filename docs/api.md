# Compute API reference

Version `0.1.0` (C1e). All bodies are JSON. Shapes are defined once, as zod schemas, in [`packages/contracts`](../packages/contracts/src).

Errors always use one envelope:

```json
{ "error": { "code": "quota_exceeded", "message": "…", "requestId": "uuid" } }
```

Unknown paths return **404 `not_found`**. Request bodies are limited to 64 KiB (**413**). A malformed body is **400 `validation_failed`** (the message names fields, never values) or **400 `invalid_json`**.

## Who calls what

| Prefix | Caller | Authentication |
|---|---|---|
| `/cloud/v1/…` | SoftQraft Cloud (server) | Cloud-signed request, [cloud-federation-v1](https://github.com/imp213x/softqraft-federation/blob/main/docs/cloud-federation-v1.md) §2, audience **`compute`** |
| `/console/v1/…` | Customer browser, same origin | Console session cookie from a §3.2 launch |
| `/admin/v1/…` | Staff browser, same origin | Operator session cookie from a §8.2 launch |
| `/v1/agent/…` | Host agent | Host-signed (`enrol` uses a one-time token) |
| `/health`, `/ready` | Monitoring | None |

- `/cloud/v1/*` and `/console/v1/*` exist only when `CLOUD_FEDERATION_ENABLED=true`.
- `/cloud/v1/operator-launches` and `/admin/v1/*` exist only when `CLOUD_OPERATOR_LAUNCH_ENABLED=true` as well.
- Anything switched off answers **404 `not_found`**, exactly as if unrouted.

Cloud signature failures return the contract's codes, in its order: **400 `federation_malformed`**, **401 `federation_unknown_key`**, **401 `federation_stale`**, **401 `federation_signature`** (also for a signature made for another audience) and **401 `federation_replay`**.

## Cloud routes (`/cloud/v1`, Cloud-signed)

`:serviceInstanceId` is Cloud's service instance id: 1 to 128 characters of `A-Z a-z 0-9 . _ : -` (otherwise **400 `validation_failed`**).

### `PUT /cloud/v1/service-instances/:serviceInstanceId` (§3.1)

```json
{ "cloudOrganisationId": "uuid", "cloudProjectId": "uuid", "displayName": "string ≤120", "regionId": "eu-central" }
```

- **201** the first time, **200** with the same body when the id is already linked to the same organisation and project.
- **409 `federation_link_conflict`** when it is linked to a different organisation or project.
- `regionId` must be the region this deployment serves, `COMPUTE_REGION_ID` (default **`eu-central`**). It is stored on the service instance. Any other value is **400 `validation_failed`** with the message `regionId must be eu-central`.

```json
{ "serviceInstanceId": "…", "mediaTenantId": "cld_3f9a1b2c4d5e", "status": "active",
  "connection": { "gatewayUrl": "https://compute.softqraftlabs.com", "regionId": "eu-central" } }
```

`mediaTenantId` keeps the contract's field name. Compute puts its own tenant id there, built with the contract's §3.1 rule for new tenants: `cld_` plus the first 12 hex characters of sha256(serviceInstanceId).

Instances, usage and quotas are keyed by the service instance. Its `cloudProjectId` is what `COMPUTE_ALLOWED_PROJECTS` (decision D4) is checked against when an instance is created.

### `GET /cloud/v1/service-instances/:serviceInstanceId` (§7.1)

**200**, or **404 `federation_unknown_instance`**. Never creates anything.

```json
{ "serviceInstanceId": "…", "mediaTenantId": "cld_…", "status": "active", "origin": "cloud",
  "cloudOrganisationId": "uuid", "cloudProjectId": "uuid", "displayName": "…", "regionId": "eu-central",
  "createdAt": "ISO-8601" }
```

### `GET /cloud/v1/service-instances/:serviceInstanceId/health` (§3.4)

**200** `{ "status", "checkedAt" }`:
- `operational`: an `active` host was seen in the last 5 minutes;
- `degraded`: no such host;
- `unavailable`: the service instance is disabled.

### `POST /cloud/v1/service-instances/:serviceInstanceId/console-launches` (§3.2)

```json
{ "principal": { "subject": "user_…", "displayName": "≤120", "email": "≤254" },
  "role": "admin" | "developer" | "viewer", "returnPath": "/console/…" }
```

The response is **201** `{ "launchUrl": "<COMPUTE_PUBLIC_URL>/console/launch#grant=sqlg_…", "expiresAt" }`.

- The grant is single use and expires after 60 s.
- Errors:
  - **404 `federation_unknown_instance`**;
  - **409 `federation_instance_disabled`**;
  - **400 `federation_return_path`**: `returnPath` must start with `/console/` and contain no `//`, `\`, scheme, host, dot segments or encoded separators.
- The principal is recorded by `subject`. Display name and email are display data only.

### `POST /cloud/v1/principals/:subject/revocations` (§3.3)

The body is empty. Compute sets the principal's `revoked_after` to now and ends every Console **and operator** session of that subject.

It returns **200** `{ "revokedSessions": n }`. Repeating it, or naming an unknown subject, returns `0`.

### `POST /cloud/v1/operator-launches` (§8.2)

```json
{ "principal": { … }, "role": "owner" | "admin" | "viewer", "returnPath": "/admin/…" }
```

The response is **201** `{ "launchUrl": "<COMPUTE_PUBLIC_URL>/admin/launch#grant=sqog_…", "expiresAt" }`.

- The grant expires after 60 s, is single use, and is stored apart from Console grants.
- `returnPath` must be under `/admin/` and never under `/admin/v1/`. Otherwise **400 `federation_return_path`**.

### `GET /cloud/v1/service-instances/:serviceInstanceId/instances`

Read-only, for the Cloud summary and Copilot. **200** `{ "instances": Instance[] }` (deleted ones left out), or **404 `federation_unknown_instance`**.

### `GET /cloud/v1/service-instances/:serviceInstanceId/usage?from=ISO&to=ISO`

Read-only. **200**:

```json
{ "serviceInstanceId": "…", "from": "ISO-8601", "to": "ISO-8601", "usage": [ UsageRecord, … ] }
```

The records are in **`usage`**. The range defaults to the last 24 hours and may cover at most 31 days (**400 `invalid_range`**).

## Browser sessions

The Console shell at `/console/launch` and the Admin shell at `/admin/launch` arrive with the Console UI in C1d. The grant travels only in the URL fragment. The page removes it, then redeems it.

| | Console | Admin (operator) |
|---|---|---|
| Redeem | `POST /console/v1/auth/cloud-launch/redeem` `{ "grant": "sqlg_…" }` | `POST /admin/v1/auth/cloud-launch/redeem` `{ "grant": "sqog_…" }` |
| Response | `{ "returnPath" }` | `{ "returnPath", "sessionExpiresAt" }` |
| Cookie | `sq_console_session` (`sqcs_…`), `Path=/console` | `sq_admin_session` (`sqos_…`), `Path=/admin` |
| Lifetime | 8 hours, absolute | 1 hour, absolute |
| Roles | `admin`, `developer`, `viewer` | `owner`, `admin`, `viewer` |
| Writes | `admin`, `developer` | `owner`, `admin`, and the session must be younger than 15 minutes |

Rules for both:
- **Cookies** are `HttpOnly; SameSite=Strict` and `Secure` when `COMPUTE_PUBLIC_URL` is https. `Max-Age` is the session lifetime.
- Sessions do not slide and have no idle timeout. A redeem ends the session the browser held before.
- **Redeem** must carry this service's `Origin` (otherwise **403 `cross_origin`**). It is limited to 20 per minute per IP (**429 `rate_limited`**).
- Any unknown, used, expired, malformed or wrong-kind grant is **401 `launch_invalid`**. A Console grant never opens Admin, and an operator grant never opens the Console.
- **A session is valid** while all of these hold:
  - it is unexpired;
  - it was created after its principal's `revoked_after`;
  - for the Console, its service instance is `active`.
  Otherwise the response is **401 `unauthorized`**.
- **Writes** are every method except GET and HEAD. They must carry this service's `Origin` (**403 `cross_origin`**) and a role that may write (**403 `forbidden`**).
- An operator write on a session older than 15 minutes is **403 `reauth_required`**, recorded as `auth.operator_reauth_required`.
- `POST …/auth/logout` (same origin) ends the session and clears the cookie.
- `GET …/auth/me` returns the principal, role, session times and `freshUntil`; the Console version adds the service instance.
- Security events are recorded without secrets: `auth.cloud_launch`, `auth.operator_launch`, `auth.operator_reauth_required`, and one `fleet.*` event per fleet write.

## Console routes (`/console/v1`, Console session)

Every route acts on the session's own service instance. Another service instance's instance reads as **404 `instance_not_found`**.

### `POST /console/v1/instances`

Requires the header `Idempotency-Key` (8 to 128 characters of `A-Z a-z 0-9 _ -`).

```json
{ "name": "web-1", "imageId": "debian-12", "vcpu": 1, "memoryMb": 1024, "diskGb": 16,
  "sshPublicKeys": ["ssh-ed25519 AAAA… me@laptop"] }
```

| Field | Rule |
|---|---|
| `name` | Lowercase DNS label: `a-z`, `0-9`, `-`, starts with a letter, 1 to 63 characters. Unique among the service instance's live instances. |
| `imageId` | An available id from `GET /console/v1/images` |
| `vcpu` | 1 to 4 |
| `memoryMb` | 512 to 8192, in steps of 512 |
| `diskGb` | 10 to 120, and at least the image's `minDiskGb`. **Optional: defaults to `COMPUTE_DEFAULT_DISK_GB` (16).** |
| `sshPublicKeys` | Up to 10 OpenSSH public keys. Optional. |

Responses:
- **201** `{ "instance": Instance }`; **200** with `Idempotent-Replayed: true` for a repeat with the same key and body.
- **400**: `idempotency_key_required`, `idempotency_key_invalid`, `validation_failed`, `invalid_json`, `unknown_image`, `disk_too_small`.
- **403**: `project_not_allowed` (the service instance's Cloud project is not in `COMPUTE_ALLOWED_PROJECTS`).
- **409**: `idempotency_key_reused`, `quota_exceeded` (the message names `instances`, `vcpu`, `memoryMb` or `diskGb`), `name_taken`, `address_pool_exhausted`.

The pilot pool caps (`COMPUTE_POOL_MAX_*`) cover every live instance together, and the disk cap also covers every live snapshot. Capacity is reserved atomically.

```json
{ "id": "uuid", "serviceInstanceId": "…", "spec": { … }, "pendingSize": null, "state": "provisioning",
  "pendingReason": null, "hostId": "uuid", "privateIp": "10.30.0.2",
  "capabilities": { "console": false, "resize": true, "snapshot": true },
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601" }
```

`capabilities` says what the driver on the instance's host supports, so the console can hide the rest. All three are `false` while the instance has no host.

| Driver | `console` | `resize` | `snapshot` |
|---|---|---|---|
| `fake` (tests) | true | true | true |
| `proxmox` (C1) | **false**: the browser console needs a relay that comes after C1 | true | true |

A resize, snapshot or console request for an instance whose driver lacks the capability is **409 `not_supported`**.

`spec` is the size the instance has now. `pendingSize` is `{ "vcpu", "memoryMb", "diskGb" }` while a resize is in progress, otherwise `null`.

`pendingReason` is `no_active_host` or `no_host_capacity` while an instance is `pending`. Pending instances are placed automatically when a host becomes active or frees room.

### `GET /console/v1/instances`, `GET /console/v1/instances/:id`

`{ "instances": Instance[] }`, oldest first, without deleted ones; `{ "instance": Instance }`, including a deleted one.

### `DELETE /console/v1/instances/:id`

**202** `{ "instance" }` in `deleting` (or `deleted` at once if it was never placed). Allowed from `pending`, `running`, `stopped` and `error`; otherwise **409 `invalid_state`**. Its snapshots go with it.

### `POST /console/v1/instances/:id/actions`

**202** `{ "instance" }`.

| Body | Needs | Becomes |
|---|---|---|
| `{ "action": "start" }` | `stopped` | `starting` |
| `{ "action": "stop" }` | `running` | `stopping` |
| `{ "action": "resize", "vcpu"?, "memoryMb"?, "diskGb"? }` | `stopped` | `resizing`, then `stopped` |

Resize rules:
- At least one size must be given. vCPU and memory may go up or down; the disk may only grow (**400 `invalid_resize`**, also when nothing changes).
- Growth must fit the pool caps (**409 `quota_exceeded`**) and the host (**409 `no_host_capacity`**).
- The request records the target in `pendingSize` and reserves it: while pending, the instance holds the larger of its size and the target in each dimension.
- `spec` changes only when the resize job succeeds; that size then applies from that moment for metering.
- If the resize fails, the instance goes to `error` with its `spec` unchanged, and the reservation is released.

Other errors: **409 `invalid_state`**, and **409 `host_disabled`** for start or resize on a disabled host.

### Snapshots

- `GET /console/v1/instances/:id/snapshots` returns **200** `{ "snapshots": Snapshot[] }` (deleted ones left out).
- `POST /console/v1/instances/:id/snapshots` `{ "name": "before-upgrade" }` returns **202** `{ "snapshot" }` in `creating`.
  - The name is a lowercase label of 1 to 40 characters, unique among the instance's live snapshots (**409 `snapshot_name_taken`**).
  - The instance must be `running` or `stopped` (**409 `invalid_state`**).
  - A snapshot holds the instance's disk size against the pool's disk cap (**409 `quota_exceeded`**) and the host's disk (**409 `no_host_capacity`**) until it is deleted.
- `DELETE /console/v1/instances/:id/snapshots/:snapshotId` returns **202** `{ "snapshot" }` in `deleting`.
  - It is allowed from `available` and `error`.
  - An unknown snapshot is **404 `snapshot_not_found`**.

`Snapshot`: `{ "id", "instanceId", "name", "state": "creating|available|deleting|deleted|error", "sizeGb", "createdAt", "updatedAt" }`. A failed snapshot becomes `error` and never changes its instance.

### `POST /console/v1/instances/:id/console`

Asks the host agent for a short-lived console ticket and waits for it, for up to `COMPUTE_CONSOLE_WAIT_SECONDS` (15).

**200** `{ "console": { "protocol": "vnc", "ticket": "…", "expiresAt": "ISO-8601" } }` with `Cache-Control: no-store`.

- The ticket is handed over once and never stored afterwards.
- The instance must be `running` (**409 `invalid_state`**), on a host that is not disabled (**409 `host_disabled`**).
- **502 `console_unavailable`** when the agent fails the job.
- **504 `console_timeout`** when it does not answer in time; the job is then cancelled and the ticket is never issued.
- The API never holds hypervisor credentials.
- The Proxmox driver offers no console in C1 (`capabilities.console` is false, so the request is **409 `not_supported`**); a console relay comes later.

### `GET /console/v1/images`

**200** `{ "images": Image[] }`. C1 offers `debian-12` and `ubuntu-24.04`.

### `GET /console/v1/usage?from=ISO&to=ISO`

**200** `{ "serviceInstanceId", "from", "to", "records": UsageRecord[] }`, with the same range rules as the Cloud route.

```json
{ "serviceInstanceId": "…", "hourStart": "2026-10-07T10:00:00.000Z",
  "vcpuHours": 1.5, "memoryGbHours": 1.5, "diskGbHours": 20 }
```

vCPU and memory count while an instance runs; disk counts while it exists. Each sample is metered at the size the instance had at its `sampledAt`, so a sample reported after a resize, about a time before it, uses the old size. Usage is metered, not priced.

### `GET /console/v1/auth/me`

```json
{ "principal": { "subject", "displayName", "email" }, "role": "developer",
  "serviceInstance": { "id", "displayName", "regionId" },
  "session": { "createdAt", "expiresAt", "freshUntil" } }
```

### Instance states

| From | To |
|---|---|
| `pending` | `provisioning`, `deleting` |
| `provisioning` | `running`, `error` |
| `running` | `stopping`, `deleting`, `error` |
| `stopping` | `stopped`, `error` |
| `stopped` | `starting`, `resizing`, `deleting`, `error` |
| `starting` | `running`, `error` |
| `resizing` | `stopped`, `error` |
| `deleting` | `deleted`, `error` |
| `error` | `deleting` |
| `deleted` | none (terminal) |

An instance goes to `error` when its create, start, stop, resize or delete job fails after the last attempt.

## Fleet routes (`/admin/v1/fleet`, operator session)

Viewers may read. Owners and admins may write, with a session younger than 15 minutes. Every write is recorded as a `fleet.*` security event, in the same transaction as the change.

| Route | Result |
|---|---|
| `GET hosts` | `{ "hosts": [Host + "allocated"] }`. `allocated` includes snapshot disk. |
| `POST hosts/:id/drain` | `{ "host" }` in `draining`. Draining hosts get no new instances. **409 `host_disabled`** on a disabled host. |
| `POST hosts/:id/disable` | **The kill switch.** See below. |
| `POST hosts/:id/enable` | `{ "host" }` back to `active` (or `enrolled` if it was never seen). Stopped instances stay stopped. |
| `POST enrolment-tokens` | Body `{ "hostName"? }`. **201** `{ "token", "hostName", "expiresAt" }`, with `Cache-Control: no-store`. |
| `GET instances` | `{ "instances": Instance[] }`: every service instance's live instances, for support. Add `?include=deleted` for deleted ones. |

The kill switch (`POST hosts/:id/disable`) returns `{ "host", "stopsQueued" }`:
- the host becomes `disabled` and gets no new work;
- its agent can claim only `stop` and `delete` jobs, so pending stops and deletes still run;
- a stop is queued for every running instance on it;
- an instance that comes up on it later is stopped as soon as it does.

Enrolment tokens:
- are shown once and stored only as SHA-256 hashes;
- work once and expire after **30 minutes**;
- when created with a `hostName`, enrol only that name.

## Agent routes

### Agent request signatures

Every agent route except `enrol` carries four headers:

| Header | Value |
|---|---|
| `X-SQ-Host-Id` | The host id returned by `enrol` |
| `X-SQ-Host-Timestamp` | Unix seconds |
| `X-SQ-Host-Nonce` | 32 lowercase hex characters, new per request |
| `X-SQ-Host-Signature` | base64url (no padding) Ed25519 signature over the canonical string |

```text
SQCA1
<host id>
<HTTP METHOD, uppercase>
<request path including query string, exactly as sent>
<timestamp>
<nonce>
<lowercase hex SHA-256 of the raw body bytes>
```

The API checks these in order; the first failure decides:

1. Headers are well formed. Otherwise **400 `agent_malformed`**.
2. The host is known. Otherwise **401 `agent_unknown_host`**.
3. `|now − timestamp| ≤ 300 s`. Otherwise **401 `agent_stale`**.
4. The signature is valid. Otherwise **401 `agent_signature`**.
5. The nonce is unused in the last 600 s. Otherwise **401 `agent_replay`**.

A disabled host still authenticates, so that it can run the kill switch's stops and any pending deletes. `signAgentRequest` in [`packages/jobs`](../packages/jobs/src/agent-request.ts) builds the headers. A host starts as `enrolled`; its first verified signed request makes it `active`.

### `POST /v1/agent/enrol` (unsigned)

```json
{ "token": "sqet_…", "name": "sq-node-01", "driver": "fake",
  "publicKey": "-----BEGIN PUBLIC KEY-----…", "capacity": { "vcpu": 4, "memoryMb": 8192, "diskGb": 120 } }
```

**201** `{ "hostId", "state": "enrolled", "jobSigningKeys": { "<keyId>": "<SPKI PEM>" } }`.

Errors:
- **401 `enrolment_invalid`**;
- **400 `unknown_driver`** (the API knows `fake` and `proxmox`) or **400 `invalid_public_key`**;
- **409 `host_name_taken`**.

### `POST /v1/agent/jobs/claim`

**200** `{ "job": SignedJob | null }`. Leases the host's oldest queued job (only `stop` and `delete` jobs on a disabled host) and counts an attempt.

```json
{ "keyId": "job-1", "signature": "base64url",
  "envelope": { "id", "hostId", "type", "payload": { … }, "instanceId", "attempt": 1,
                "issuedAt": "ISO-8601", "expiresAt": "ISO-8601" } }
```

| `type` | `payload` |
|---|---|
| `create` | `{ "spec", "privateIp", "network": { "cidr", "gateway" } }` |
| `start`, `stop`, `delete`, `console` | `{ "name" }` |
| `resize` | `{ "name", "vcpu", "memoryMb", "diskGb" }` (the full new size) |
| `snapshot`, `snapshot_delete` | `{ "snapshotName" }` |

`JOB_PAYLOADS` in `packages/contracts` has the schema for each type.

The signature is Ed25519 over the canonical JSON of `envelope`. Agents verify it with `verifyJob` from [`packages/jobs`](../packages/jobs/src/envelope.ts), which refuses a bad signature, a job for another host, and an expired or tampered envelope.

### `POST /v1/agent/jobs/:id/heartbeat`, `/complete`, `/fail`

Bodies:
- `heartbeat` and `complete`: `{ "attempt": n }`;
- `fail`: `{ "attempt": n, "error": "short reason" }`;
- a `console` job's `complete` also needs `"result": { "protocol": "vnc", "ticket", "expiresAt" }`, expiring within 5 minutes. Any other job type with a `result` is **400 `invalid_result`**.

Responses and errors:
- `heartbeat` returns `{ "leaseExpiresAt" }`.
- **404 `job_not_found`**: the job is not this host's.
- **409 `lease_lost`**: the attempt no longer holds the lease.
- **409 `lease_expired`**: a heartbeat came after the lease ended.

A failed or expired attempt returns the job to the queue until `COMPUTE_JOB_MAX_ATTEMPTS` (3); console jobs get one attempt.

### `POST /v1/agent/usage`

```json
{ "samples": [ { "instanceId": "uuid", "sampledAt": "ISO-8601", "intervalSeconds": 60, "powerState": "running" } ] }
```

**202** `{ "accepted", "duplicates" }`. A repeat of the same `instanceId` and `sampledAt` is ignored.

Errors:
- **400 `unknown_instance`**: the instance is not on this host;
- **400 `sample_out_of_range`**: `sampledAt` is more than 5 minutes ahead or 7 days old.

## Probes

- `GET /health`: **200** `{ "status": "ok" }` while the process runs.
- `GET /ready`: **200** `{ "status": "ready", "store" }` when the database answers, otherwise **503** `{ "status": "not_ready" }`.
