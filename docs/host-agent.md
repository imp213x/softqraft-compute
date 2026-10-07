# Host agent and Proxmox driver

Version `0.1.0` (C1e). The host agent runs on each Proxmox host. It pulls signed jobs from the Compute API over outbound HTTPS and runs them on Proxmox VE 8 through its local HTTP API. No port is opened on the host. Host setup is in softqraft_labs [`myDocs/compute/runbook.md`](https://github.com/imp213x/softqraft_labs/blob/main/myDocs/compute/runbook.md).

| Part | Path |
|---|---|
| Agent (Node 24) | [`apps/host-agent`](../apps/host-agent/src) |
| Proxmox client and driver | [`packages/driver-proxmox`](../packages/driver-proxmox/src) |
| Fake Proxmox for tests | [`packages/proxmox-fake`](../packages/proxmox-fake/src) (never deployed) |
| systemd unit, installer, env example | [`deploy/host-agent`](../deploy/host-agent) |

## What the agent does

1. **Enrols once.** On first start it creates an Ed25519 host key (`host-key.pem`, mode 0600) in the state directory `/var/lib/softqraft-compute-agent` (mode 0700), then calls `POST /v1/agent/enrol` with the one-time token, the host name, driver `proxmox`, its public key and its capacity. It saves the host id and the job signing public keys in `enrolment.json` (0600). It then blanks `COMPUTE_ENROLMENT_TOKEN` in the env file if it can write it. Under the hardened unit it cannot, so it logs `enrolment_token_not_removed`: remove the line by hand. A token left in place after enrolment is ignored, with a warning.
2. **Checks the network guard** (below). While the guard is missing it runs no job.
3. **Builds the image templates** (`ensureImages`, below) when `COMPUTE_AGENT_ENSURE_IMAGES=true`.
4. **Runs jobs.** It claims one job at a time, verifies it with `verifyJob` (signature, this host, not expired), checks the payload, runs it on the driver while heartbeating every 30 s (the lease is 120 s), then completes or fails it. A job that fails verification is never run; it is failed with `job_refused_<reason>`. Driver failures are reported with their stable code. While the API cannot be reached the agent backs off exponentially, up to 60 s.
5. **Reports usage** every 60 s: one sample per managed VM, with the interval since the last report and its power state (`running` or `stopped`; disk is metered while a VM exists). If the API does not know one of the VMs, the others are sent one by one.
6. **Stops gracefully** on SIGTERM: it stops claiming, lets the current job finish (up to 90 s), and exits. A job it could not report is retried by the API after its lease ends; every driver operation is idempotent.

Logs are JSON lines on stdout (journald). They never contain the Proxmox token, the enrolment token, keys, signatures, job envelopes or payloads.

### Dry run

`COMPUTE_AGENT_DRY_RUN=true` (C1f runs this first):

- the agent enrols, checks the guard and verifies every job as usual;
- the driver's reads go to Proxmox, so the plan reflects the real host;
- every Proxmox **write** is logged as `proxmox_dry_run` with its method, path and parameters (secrets replaced, SSH keys counted) and never sent;
- each job is then failed with `dry_run`, because nothing was done. The API retries it up to `COMPUTE_JOB_MAX_ATTEMPTS`, then the instance goes to `error`;
- `ensureImages` logs the downloads and templates it would create.

### Network guard

The runbook's iptables rules belong to the host. At every start the unit's privileged `ExecStartPre` writes `iptables -S FORWARD` to `/run/softqraft-compute-agent/iptables-forward.rules`, and the agent checks it for:

- outbound SMTP blocked from the tenant network: DROP or REJECT for TCP 25, 465 and 587, from `COMPUTE_PILOT_CIDR` or in on the tenant bridge;
- no forwarding to production: DROP or REJECT from the tenant network to `COMPUTE_PRODUCTION_CIDR` (`10.20.0.0/24`), or from the tenant bridge out of `COMPUTE_PRODUCTION_BRIDGE` (`vmbr0`).

If anything is missing (or the file is), the agent logs `network_guard_missing` with what is missing and claims no job; jobs queued for the host wait. Fix the rules and restart the agent (the snapshot is taken at start).

## Configuration

`/etc/softqraft/compute-agent.env`, owner root, mode 0600. systemd reads it (`EnvironmentFile=`); the agent also reads it directly when it may. [`deploy/host-agent/compute-agent.env.example`](../deploy/host-agent/compute-agent.env.example) lists every name. Bad values stop the agent with exit code 78 and a message naming the variable, and systemd does not restart it.

| Variable | Default | Meaning |
|---|---|---|
| `COMPUTE_API_URL` | required | The Compute API, https (plain http only to 127.0.0.1) |
| `COMPUTE_HOST_NAME` | required | Lowercase DNS label; must match the enrolment token's host name |
| `COMPUTE_ENROLMENT_TOKEN` | | One-time `sqet_` token, needed on the first start only |
| `COMPUTE_HOST_CAPACITY_VCPU`, `_MEMORY_MB`, `_DISK_GB` | 4, 8192, 120 | What the API may place here (pilot caps) |
| `COMPUTE_AGENT_DRY_RUN` | `false` | See above |
| `COMPUTE_AGENT_ENSURE_IMAGES` | `true` | Build missing image templates at start |
| `COMPUTE_AGENT_STATE_DIR` | `/var/lib/softqraft-compute-agent` | Host key and enrolment record |
| `COMPUTE_AGENT_NETWORK_GUARD_FILE` | `/run/softqraft-compute-agent/iptables-forward.rules` | Rules snapshot |
| `COMPUTE_PILOT_CIDR`, `COMPUTE_PRODUCTION_CIDR`, `COMPUTE_PRODUCTION_BRIDGE` | `10.30.0.0/24`, `10.20.0.0/24`, `vmbr0` | For the guard check |
| `COMPUTE_AGENT_POLL_SECONDS`, `_HEARTBEAT_SECONDS`, `_USAGE_SECONDS` | 5, 30, 60 | The heartbeat must be at most 60 |
| `PROXMOX_URL` | `https://127.0.0.1:8006` | Loopback only |
| `PROXMOX_NODE` | required | The node name |
| `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` | required | `compute-agent@pve!agent` and its secret (runbook section 4) |
| `PROXMOX_TLS_FINGERPRINT` | required | SHA-256 fingerprint of the API certificate, with or without colons |
| `PROXMOX_POOL`, `PROXMOX_STORAGE` | required | `compute-pilot` in the pilot |
| `PROXMOX_IMPORT_STORAGE` | `local` | File storage that receives vendor image downloads (`import` content) |
| `PROXMOX_BRIDGE` | `vmbr10` | The only bridge a NIC may use |
| `COMPUTE_VMID_RANGE` | `2000-2999` | Instance VMIDs; must not touch 9000-9099 |
| `PROXMOX_NAMESERVERS`, `PROXMOX_CI_USER` | `1.1.1.1 9.9.9.9`, `sq` | cloud-init |
| `PROXMOX_SHUTDOWN_TIMEOUT_SECONDS` | 60 | Graceful shutdown before a stop |

## The Proxmox driver

### Fences

The client checks every call before it is sent; a call outside the fences is refused with `proxmox_fence_refused` and nothing reaches Proxmox:

- only the endpoints listed below, only on `PROXMOX_NODE`, and only the parameters each one needs;
- instance VMIDs only in `COMPUTE_VMID_RANGE`, template VMIDs only in 9000-9099, and a template is only read, cloned or converted;
- a VM is touched only after a read showed it in `PROXMOX_POOL` (or the driver just created it there);
- `pool` is always `PROXMOX_POOL`; `storage` and every disk are on `PROXMOX_STORAGE`; vendor downloads go only to `PROXMOX_IMPORT_STORAGE`, over https and with a checksum; every NIC is on `PROXMOX_BRIDGE` and the driver configures only `net0`; clones are full clones.

A VM belongs to an instance by its tag `sqc-<instance id>`. A VM carrying that tag outside the pool, the node or the range is refused, never touched.

### TLS and the token

Requests carry `Authorization: PVEAPIToken=<id>=<secret>`. The connection is pinned: the agent connects, compares the server certificate's SHA-256 fingerprint with `PROXMOX_TLS_FINGERPRINT`, and only then hands the socket to the HTTP client, so the token is never sent to a server that does not match. CA verification is skipped only for that pinned socket; nothing is changed globally.

### Calls per operation

Paths are under `/api2/json/nodes/<node>`. Every operation first reads `GET /cluster/resources?type=vm` to find the VM. Calls that return a task are followed by `GET tasks/<upid>/status` until it ends.

| Operation | Writes, in order (skipped when already done) |
|---|---|
| create | `GET /cluster/nextid?vmid=N` for the lowest free VMID; `POST qemu/<template>/clone` (`newid`, `name=sqc-<id>`, `pool`, `storage`, `full=1`); `PUT qemu/N/config` (`name`, `tags=sqc-<id>`, `cores`, `sockets=1`, `memory`, `net0=virtio,bridge=vmbr10,firewall=1`, `ciuser`, `sshkeys`, `ipconfig0=ip=<ip>/24,gw=10.30.0.1`, `nameserver`); `PUT qemu/N/firewall/options` (`enable=1`, `ipfilter=1`, `macfilter=1`, `dhcp=0`, `ndp=0`, `radv=0`, `policy_in=DROP`, `policy_out=ACCEPT`); `POST qemu/N/firewall/ipset` (`name=ipfilter-net0`); `POST qemu/N/firewall/ipset/ipfilter-net0` (`cidr=<ip>`); `PUT qemu/N/resize` (`disk=scsi0`, `size=<GB>G`); `POST qemu/N/status/start` |
| start | `POST qemu/N/status/start` unless running |
| stop | `POST qemu/N/status/shutdown` (`timeout=60`); if still running, `POST qemu/N/status/stop` |
| delete | `POST qemu/N/status/stop` if running; `DELETE qemu/N?purge=1&destroy-unreferenced-disks=1` |
| resize (stopped) | `PUT qemu/N/config` (`cores`, `memory`) if changed; `PUT qemu/N/resize` (`scsi0`) if the disk grows |
| snapshot | `POST qemu/N/snapshot` (`snapname`) unless it exists |
| snapshot delete | `DELETE qemu/N/snapshot/<name>` if it exists |
| status, list | reads only |

A create retried after a partial run finds the VM by its name or tag and finishes the remaining steps. The ipset is then made to hold exactly the assigned address (other entries are removed).

### Capabilities and limits in C1

`capabilities` is `{ console: false, resize: true, snapshot: true }`. There is **no browser console in C1**: the agent connects out only, and a console needs a relay between the browser and the host, which comes after C1. The API reports this per instance and refuses console requests with `not_supported`.

Proxmox needs snapshot names of at least two characters and reserves `current`; the driver refuses those with `snapshot_name_unsupported`.

### Images

`ensureImages` builds a template for each catalogue image:

| Image | Template VMID | Vendor image | Checksum list |
|---|---|---|---|
| `debian-12` | 9000 | `cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2` | `SHA512SUMS` (Debian publishes no SHA256SUMS) |
| `ubuntu-24.04` | 9001 | `cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img` | `SHA256SUMS` |

For each: if the template exists in the pool, nothing happens. Otherwise the agent fetches the vendor's checksum list over https, takes the image's hash, and has Proxmox download the image into `PROXMOX_IMPORT_STORAGE` with `download-url` and that checksum (Proxmox verifies it and discards a mismatch). Then it creates the template VM in the pool (`scsi0` imported into `PROXMOX_STORAGE`, a cloud-init drive, serial console, `net0` on the bridge, tag `sqc-template`) and converts it to a template. The checksum lists' GPG signatures are not checked yet.

### Error codes

Shared: `vm_not_found`, `vm_running`, `vm_not_running`, `disk_shrink`, `host_full`, `unsupported`. Proxmox: `proxmox_unreachable`*, `proxmox_tls_pin_mismatch`, `proxmox_auth`, `proxmox_forbidden`, `proxmox_rejected`, `proxmox_server_error`*, `proxmox_bad_response`, `proxmox_task_failed`, `proxmox_task_timeout`*, `proxmox_fence_refused`, `proxmox_vmid_exhausted`, `image_unavailable`*, `unknown_image`, `image_checksum_unavailable`, `snapshot_name_unsupported`, `network_refused`. Agent: `job_refused_<reason>`, `invalid_payload`, `dry_run`. `*` marks retryable conditions. Messages never contain the token, headers, bodies or parameter values.

## Install

On the host, as root, from a checkout (needs Node 24 at `/usr/bin/node` and pnpm), or with a bundle built elsewhere by `pnpm --filter @softqraft/compute-host-agent deploy --prod <dir>`:

```sh
deploy/host-agent/install.sh              # or: install.sh --from <dir>
```

It creates the `softqraft-compute` user, the state directory, `/opt/softqraft-compute-agent/releases/<time>` with a `current` link, `/etc/softqraft/compute-agent.env.example`, and the systemd unit. It deletes nothing, does not start the agent and never calls Proxmox. Then follow runbook section 6, with `COMPUTE_AGENT_DRY_RUN=true` first.

The unit runs as `softqraft-compute` with `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/softqraft-compute-agent`, `PrivateTmp`, no capabilities and only IP and Unix sockets.

## Kill switch

From Fleet, disable the host: its agent then claims only stop and delete jobs, and the API queues a stop for every running instance. On the host: `systemctl stop softqraft-compute-agent`, then the runbook's kill-switch command.

## Tests

`pnpm run test` covers the driver against the fake Proxmox (exact calls and parameters, refusals before sending, idempotency, TLS pinning, the token, dry run, `ensureImages`) and the agent (job verification, tampered, expired and misaddressed jobs, dry run, the network guard, usage, backoff, state file modes). The end-to-end test starts the built API (`apps/api/dist`) with the memory store, so run `pnpm run build` first.
