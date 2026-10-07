# Compute API reference

Version `0.1.0` (C1a). All bodies are JSON. Shapes are defined once, as zod schemas, in [`packages/contracts`](../packages/contracts/src).

Errors always use one envelope:

```json
{ "error": { "code": "quota_exceeded", "message": "…", "requestId": "uuid" } }
```

Unknown paths return **404 `not_found`**. Request bodies are limited to 64 KiB (**413**).

## Authentication

| Route group | Who calls it | How it is authenticated |
|---|---|---|
| Cloud-facing (`/v1/projects/…`, `/v1/images`) | SoftQraft Cloud | Cloud-signed request, [cloud-federation-v1](https://github.com/imp213x/softqraft-federation/blob/main/docs/cloud-federation-v1.md) §2, audience **`compute`** |
| Fleet (`/v1/fleet/…`) | SoftQraft Cloud for staff | Cloud-signed, then an operator role check (denied by default, see below) |
| Agent (`/v1/agent/…`) | The host agent | Signed with the host's own enrolled Ed25519 key; `enrol` uses a one-time token |
| Probes (`/health`, `/ready`) | Monitoring | None |

**Cloud-facing and fleet routes exist only when `CLOUD_FEDERATION_ENABLED=true`.** Otherwise they return 404, exactly as if unrouted. Signature failures return the contract's codes: **400 `federation_malformed`**, **401 `federation_unknown_key`**, **401 `federation_stale`**, **401 `federation_signature`** (also for a signature made for another audience) and **401 `federation_replay`**.

**Fleet routes** need an operator role after the signature check. cloud-federation-v1 carries operator roles only inside operator-launch bodies (§8.2), not on signed requests, so in C1a every fleet request is refused with **403 `operator_role_required`**. This is an open question for C1c.

### Agent request signatures

Every agent route except `enrol` carries four headers:

| Header | Value |
|---|---|
| `X-SQ-Host-Id` | The host id returned by `enrol` |
| `X-SQ-Host-Timestamp` | Unix seconds |
| `X-SQ-Host-Nonce` | 32 lowercase hex characters, new per request |
| `X-SQ-Host-Signature` | base64url (no padding) Ed25519 signature over the canonical string |

The canonical string is UTF-8, lines joined by `\n`, no trailing newline:

```text
SQCA1
<host id>
<HTTP METHOD, uppercase>
<request path including query string, exactly as sent>
<timestamp>
<nonce>
<lowercase hex SHA-256 of the raw body bytes>
```

The API checks, in order: headers well formed (**400 `agent_malformed`**), host known (**401 `agent_unknown_host`**), host not disabled (**403 `host_disabled`**), `|now − timestamp| ≤ 300 s` (**401 `agent_stale`**), signature (**401 `agent_signature`**), nonce unused in the last 600 s (**401 `agent_replay`**). `signAgentRequest` in [`packages/jobs`](../packages/jobs/src/agent-request.ts) builds the headers.

A host starts as `enrolled`. Its first verified signed request makes it `active`.

## Cloud-facing routes

`projectId` is the Cloud project UUID. Only projects listed in `COMPUTE_ALLOWED_PROJECTS` may create instances (the list is empty by default).

### `POST /v1/projects/:projectId/instances`

Requires the header `Idempotency-Key` (8 to 128 characters of `A-Z a-z 0-9 _ -`).

```json
{ "name": "web-1", "imageId": "debian-12", "vcpu": 1, "memoryMb": 1024, "diskGb": 20,
  "sshPublicKeys": ["ssh-ed25519 AAAA… me@laptop"] }
```

| Field | Rule |
|---|---|
| `name` | Lowercase DNS label: `a-z`, `0-9`, `-`, starts with a letter, 1 to 63 characters. Unique among the project's live instances. |
| `imageId` | An available id from `GET /v1/images` |
| `vcpu` | 1 to 4 |
| `memoryMb` | 512 to 8192, in steps of 512 |
| `diskGb` | 10 to 120, and at least the image's `minDiskGb` |
| `sshPublicKeys` | Up to 10 OpenSSH public keys. Optional. |

Responses:
- **201** `{ "instance": Instance }` for a new instance.
- **200** with the same body and the header `Idempotent-Replayed: true` when the key was used before with the same body.
- **400** `idempotency_key_required`, `idempotency_key_invalid`, `validation_failed`, `invalid_json`, `unknown_image`, `disk_too_small`.
- **403** `project_not_allowed`.
- **409** `idempotency_key_reused` (same key, different body), `quota_exceeded` (the message names the cap: `instances`, `vcpu`, `memoryMb` or `diskGb`), `name_taken`, `address_pool_exhausted`.

The pilot pool caps (`COMPUTE_POOL_MAX_*`) cover every live instance together. Capacity is reserved atomically: concurrent creates never exceed the caps.

An `Instance`:

```json
{ "id": "uuid", "projectId": "uuid", "spec": { … }, "state": "provisioning",
  "pendingReason": null, "hostId": "uuid", "privateIp": "10.30.0.2",
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601" }
```

When no host can take the instance, it is created in `pending` with `pendingReason`:

| `pendingReason` | Meaning |
|---|---|
| `no_active_host` | No host is `active` (none enrolled yet, or all draining or disabled). |
| `no_host_capacity` | Active hosts exist, but none has room for this size. |

Pending instances are placed automatically when a host becomes active or frees room.

### `GET /v1/projects/:projectId/instances`

**200** `{ "instances": Instance[] }`, oldest first. Deleted instances are left out.

### `GET /v1/projects/:projectId/instances/:id`

**200** `{ "instance": Instance }`, including a `deleted` one. **404** `instance_not_found` for an unknown id or another project's instance.

### `DELETE /v1/projects/:projectId/instances/:id`

**202** `{ "instance": Instance }` in `deleting` (or `deleted` at once if it was never placed). Allowed from `pending`, `running`, `stopped` and `error`; otherwise **409** `invalid_state`.

### `POST /v1/projects/:projectId/instances/:id/actions`

Body `{ "action": "start" }` or `{ "action": "stop" }`. **202** `{ "instance": Instance }` in `starting` or `stopping`. `start` needs `stopped` and `stop` needs `running`; otherwise **409** `invalid_state`.

### Instance states

| From | To |
|---|---|
| `pending` | `provisioning`, `deleting` |
| `provisioning` | `running`, `error` |
| `running` | `stopping`, `deleting`, `error` |
| `stopping` | `stopped`, `error` |
| `stopped` | `starting`, `deleting`, `error` |
| `starting` | `running`, `error` |
| `deleting` | `deleted`, `error` |
| `error` | `deleting` |
| `deleted` | none (terminal) |

An instance goes to `error` when its job fails after the last attempt.

### `GET /v1/images`

**200** `{ "images": Image[] }`. C1 offers `debian-12` and `ubuntu-24.04`.

### `GET /v1/projects/:projectId/usage?from=ISO&to=ISO`

**200** `{ "projectId", "from", "to", "records": UsageRecord[] }`. Defaults to the last 24 hours; the range is at most 31 days (**400** `invalid_range`).

```json
{ "projectId": "uuid", "hourStart": "2026-10-07T10:00:00.000Z",
  "vcpuHours": 1.5, "memoryGbHours": 1.5, "diskGbHours": 20 }
```

vCPU and memory count while an instance runs; disk counts while it exists. Usage is metered, not priced.

## Agent routes

### `POST /v1/agent/enrol` (unsigned)

```json
{ "token": "sqet_…", "name": "sq-node-01", "driver": "fake",
  "publicKey": "-----BEGIN PUBLIC KEY-----…", "capacity": { "vcpu": 4, "memoryMb": 8192, "diskGb": 120 } }
```

**201** `{ "hostId", "state": "enrolled", "jobSigningKeys": { "<keyId>": "<SPKI PEM>" } }`. The token works once, expires, and, when it was created for a host name, only for that name. **401** `enrolment_invalid`, **400** `unknown_driver` (C1a knows only `fake`) or `invalid_public_key`, **409** `host_name_taken`.

### `POST /v1/agent/jobs/claim`

**200** `{ "job": SignedJob | null }`. Leases the host's oldest queued job and counts an attempt.

```json
{ "keyId": "job-1", "signature": "base64url",
  "envelope": { "id", "hostId", "type": "create|start|stop|delete|snapshot", "payload": { … },
                "instanceId", "attempt": 1, "issuedAt": "ISO-8601", "expiresAt": "ISO-8601" } }
```

The signature is Ed25519 over the canonical JSON of `envelope` (keys sorted, no whitespace). Agents verify with `verifyJob` from [`packages/jobs`](../packages/jobs/src/envelope.ts), which refuses a bad signature, a job for another host, and an expired or tampered envelope.

### `POST /v1/agent/jobs/:id/heartbeat`, `/complete`, `/fail`

Body `{ "attempt": n }` (and `"error": "short reason"` for `fail`). `heartbeat` returns `{ "leaseExpiresAt" }`. A job that is not this host's is **404** `job_not_found`; an attempt that no longer holds the lease is **409** `lease_lost`; a heartbeat after the lease ended is **409** `lease_expired`.

A failed or expired attempt returns the job to the queue until `COMPUTE_JOB_MAX_ATTEMPTS` (default 3). After the last attempt the job is `failed` and its instance goes to `error`.

### `POST /v1/agent/usage`

```json
{ "samples": [ { "instanceId": "uuid", "sampledAt": "ISO-8601", "intervalSeconds": 60, "powerState": "running" } ] }
```

**202** `{ "accepted", "duplicates" }`. A sample repeated with the same `instanceId` and `sampledAt` is ignored. **400** `unknown_instance` for an instance not on this host, `sample_out_of_range` for a time more than 5 minutes ahead or 7 days old.

## Fleet routes

All need a Cloud signature and an operator role (refused in C1a, see above).

| Route | Result |
|---|---|
| `GET /v1/fleet/hosts` | `{ "hosts": [Host + "allocated"] }` |
| `POST /v1/fleet/hosts/:id/drain` | `{ "host" }` in `draining`; draining hosts get no new instances |
| `POST /v1/fleet/enrolment-tokens` | Body `{ "hostName"?, "ttlSeconds"? }` (60 to 86400). **201** `{ "token", "hostName", "expiresAt" }`. The token is shown once and stored only as its SHA-256 hash. |

## Probes

- `GET /health`: **200** `{ "status": "ok" }` while the process runs.
- `GET /ready`: **200** `{ "status": "ready", "store" }` when the database answers, otherwise **503** `{ "status": "not_ready" }`.
