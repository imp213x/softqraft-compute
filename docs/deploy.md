# Deploy Compute

The one procedure for every Compute API release, shaped like Cloud's ("Deploy Cloud" in softqraft_labs [`myDocs/infrastructure/runbook.md`](https://github.com/imp213x/softqraft_labs/blob/main/myDocs/infrastructure/runbook.md)). The pilot day's order (Neon, Cloudflare, the edge network, then this page, then Cloud and the host) is the Compute runbook in softqraft_labs [`myDocs/compute/runbook.md`](https://github.com/imp213x/softqraft_labs/blob/main/myDocs/compute/runbook.md).

**Where it runs (founder decisions F1 to F3, 2026-10-08):** SQ-CLOUD-01 (VM 103), as its own Compose project `softqraft-compute`, with its checkout in `/srv/softqraft/compute` and its env files in `/etc/softqraft/compute`, capped at 1 vCPU and 1 GB. The database is Neon; nothing is kept on the VM. The public origin is `https://compute.softqraftlabs.com`, through Cloud's existing `cloudflared`, which reaches `http://compute-api:8080` over the Docker network `softqraft-edge`.

**Who runs what:** the founder runs every command and types every secret. No step prints a secret. Send the CTO only names, codes and health output. Never run `docker compose … config` without `--quiet`: it prints the env file's values.

**Inputs:** the merged `main` commit to release, as a full 40-character SHA. Below it is `<RELEASE>`.

## First time only

Do this once, before the first release. Each step can be undone by deleting what it created; none touches Cloud.

1. **Directories**, with the same owner, group and modes as Cloud's:

   ```bash
   sudo install -d -o "$(stat -c %U /srv/softqraft/cloud)" -g "$(stat -c %G /srv/softqraft/cloud)" /srv/softqraft/compute
   sudo install -d -o root -g "$(stat -c %G /etc/softqraft/cloud)" -m "$(stat -c %a /etc/softqraft/cloud)" /etc/softqraft/compute
   git init /srv/softqraft/compute
   ```

2. **The edge network** exists (`docker network ls --filter name=softqraft-edge`). If not, create it as the Compute runbook says: `docker network create softqraft-edge`. Write down its subnet for `COMPUTE_TRUSTED_PROXY_CIDRS`:

   ```bash
   docker network inspect softqraft-edge -f '{{(index .IPAM.Config 0).Subnet}}'
   ```

3. **`deployment.env`** (no secrets): right after the first checkout in release step 2, `sudo cp /srv/softqraft/compute/deploy/compose/deployment.env.example /etc/softqraft/compute/deployment.env`. Release step 3 sets the tag.

4. **`runtime.env`**, with the same owner, group and mode as Cloud's. Start from the names in [`.env.example`](../.env.example), and delete its `NODE_ENV`, `HOST` and `PORT` lines (Compose sets them). Use an editor, never `echo` a secret:

   ```bash
   sudo install -m 0600 /dev/null /etc/softqraft/compute/runtime.env
   sudo chown --reference=/etc/softqraft/cloud/runtime.env /etc/softqraft/compute/runtime.env
   sudo chmod --reference=/etc/softqraft/cloud/runtime.env /etc/softqraft/compute/runtime.env
   sudo nano /etc/softqraft/compute/runtime.env
   ```

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | The Neon connection string for the Compute database and its login, as Neon shows it (with `sslmode=require`). The founder types it. |
   | `COMPUTE_PUBLIC_URL` | `https://compute.softqraftlabs.com` |
   | `CLOUD_ORIGIN` | `https://www.softqraftlabs.com` |
   | `CLOUD_FEDERATION_ENABLED` | `true` |
   | `CLOUD_FEDERATION_PUBLIC_KEYS` | Cloud's public key line (public, see below) |
   | `CLOUD_OPERATOR_LAUNCH_ENABLED` | `true` |
   | `COMPUTE_ALLOWED_PROJECTS` | The internal pilot project's Cloud id |
   | `COMPUTE_AGENT_ALLOWED_IPS` | `195.201.167.183` (sq-node-01) |
   | `COMPUTE_TRUSTED_PROXY_CIDRS` | The `softqraft-edge` subnet from step 2 |
   | `COMPUTE_JOB_SIGNING_KEY_ID`, `COMPUTE_JOB_SIGNING_KEY_PEM` | Generated on the VM, below |

   Everything else in `.env.example` has a pilot default; leave it blank. Check names only: `sudo grep -oE '^[A-Z_]+=' /etc/softqraft/compute/runtime.env`.

5. **The job signing key**, generated on the VM so the private key never leaves it:

   ```bash
   sudo sh -c '
   set -eu; umask 077
   ENV=/etc/softqraft/compute/runtime.env; TMP=$(mktemp -d)
   openssl genpkey -algorithm ed25519 -out "$TMP/job.key"
   PRIV=$(awk "{printf \"%s\\\\n\", \$0}" "$TMP/job.key")
   cp -p "$ENV" "$ENV.bak-$(date -u +%Y%m%dT%H%M%SZ)"
   sed -i "/^COMPUTE_JOB_SIGNING_KEY_ID=/d;/^COMPUTE_JOB_SIGNING_KEY_PEM=/d" "$ENV"
   printf "%s\n" "COMPUTE_JOB_SIGNING_KEY_ID=job-1" "COMPUTE_JOB_SIGNING_KEY_PEM=\"$PRIV\"" >> "$ENV"
   shred -u "$TMP/job.key"; rmdir "$TMP"
   '
   ```

   Host agents receive the public key at enrolment. A new key means re-enrolling every host (rotation is C2 work).

6. **Cloud's public key line.** It prints the public key only, derived from Cloud's signing key on this VM:

   ```bash
   sudo sh -c '
   set -eu; ENV=/etc/softqraft/cloud/runtime.env
   KEY_ID=$(sed -n "s/^CLOUD_FEDERATION_KEY_ID=//p" "$ENV")
   PUB=$(sed -n "s/^CLOUD_FEDERATION_PRIVATE_KEY_PEM=\"\(.*\)\"$/\1/p" "$ENV" | sed "s/\\\\n/\n/g" | openssl pkey -pubout | awk "{printf \"%s\\\\n\", \$0}")
   printf "CLOUD_FEDERATION_PUBLIC_KEYS=\047{\"%s\":\"%s\"}\047\n" "$KEY_ID" "$PUB"
   '
   ```

   Paste the printed line into Compute's `runtime.env`. It is not secret.

Then run the release steps below with the first `<RELEASE>`. In step 2 there is no rollback tag or commit yet.

## 0. Before you start

- The PR is merged with founder approval. `pnpm run test:ci` passed in CI, and the image gate (`pnpm run test:image`) passed in a Docker-context-shaped copy (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- Any new `runtime.env` names are ready. Back up before editing: `sudo cp -p /etc/softqraft/compute/runtime.env /etc/softqraft/compute/runtime.env.bak-$(date -u +%Y%m%dT%H%M%SZ)`.

## 1. Copy the release to the VM (Windows)

```powershell
cd C:\Projects\softqraft-compute
git fetch origin main
git bundle create "$env:TEMP\softqraft-compute.bundle" origin/main
scp -o ProxyJump=sq-node-01 "$env:TEMP\softqraft-compute.bundle" sq-cloud-01:/tmp/softqraft-compute.bundle
```

## 2. Build (on the VM, `ssh sq-cloud-01`)

Nothing changes for users in this step.

```bash
cd /srv/softqraft/compute
git status --short                                   # must print nothing
grep '^SOFTQRAFT_COMPUTE_IMAGE_TAG=' /etc/softqraft/compute/deployment.env   # write down: the rollback tag
git rev-parse HEAD                                   # write down: the rollback commit
git fetch /tmp/softqraft-compute.bundle refs/remotes/origin/main:refs/remotes/bundle/main \
  && git checkout --detach <RELEASE> \
  && sh ./deploy/scripts/build-compute-image.sh \
  && docker image inspect softqraft/compute:<RELEASE> >/dev/null \
  && echo "BUILD OK: continue" || echo "BUILD FAILED: stop here and send the output to the CTO"
```

`build-compute-image.sh` refuses a dirty tree. The image build runs the test gate (build, typecheck, unit tests, the §9 conformance runner, boundaries, the vendored kit and the console checks; the Postgres tests run in CI), then the script checks that the API entry point, the migrations and the console are in the image, that the API loads, and that it runs as `node`. **Go on only after `BUILD OK`.** A failed build leaves the running container untouched.

To also get the host agent bundle for a host install, add `--agent-bundle /tmp/softqraft-compute-agent-<RELEASE>.tar.gz`. It prints the bundle's SHA-256 (see [host-agent.md](host-agent.md#install)).

## 3. Switch, migrate, start

```bash
cd /srv/softqraft/compute
sudo sed -i 's/^SOFTQRAFT_COMPUTE_IMAGE_TAG=.*/SOFTQRAFT_COMPUTE_IMAGE_TAG=<RELEASE>/' /etc/softqraft/compute/deployment.env
C="docker compose --env-file /etc/softqraft/compute/deployment.env -f deploy/compose/compute.compose.yml"
$C config --quiet \
  && $C config --services \
  && $C run --rm --no-deps compute-api node dist/migrate.js \
  && $C up -d \
  && sleep 15 && curl -fsS http://127.0.0.1:8080/health && curl -fsS http://127.0.0.1:8080/ready; echo
$C ps
rm -f /tmp/softqraft-compute.bundle
```

- **Services:** `compute-api` only.
- **Migrations:** one line, `migrate: applied N (…), already applied M`. It names migration ids only. `migrate: failed: …` means stop and send it to the CTO.
- **Health:** `{"status":"ok"}`, then `{"status":"ready","store":"postgres"}`. Wait before the first check.

## 4. Check

```bash
$C ps                                          # compute-api "(healthy)"
$C logs --since 5m compute-api | grep '"level":50' || echo "no errors"
curl -fsS https://compute.softqraftlabs.com/health; echo                     # {"status":"ok"} through the tunnel
curl -sS -o /dev/null -w '%{http_code}\n' -X PUT https://compute.softqraftlabs.com/cloud/v1/service-instances/x   # 400: unsigned
```

From your own computer (not the VM, whose traffic leaves through sq-node-01's address): `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://compute.softqraftlabs.com/v1/agent/enrol` prints `403` (Cloudflare's rule). Then the checks in the PR. Record the outcome in `CHANGELOG.md` with the release commit.

## Rollback

```bash
cd /srv/softqraft/compute
C="docker compose --env-file /etc/softqraft/compute/deployment.env -f deploy/compose/compute.compose.yml"
sudo sed -i 's/^SOFTQRAFT_COMPUTE_IMAGE_TAG=.*/SOFTQRAFT_COMPUTE_IMAGE_TAG=<rollback tag>/' /etc/softqraft/compute/deployment.env
git checkout --detach <rollback commit>          # the old Compose file matches the old image
$C up -d --remove-orphans
$C ps
```

- Migrations are additive, so the old version runs on the new schema. Never make a destructive schema change during recovery.
- On the first release there is nothing to roll back to: `$C down` stops Compute. Cloud keeps working; switch Compute off in Cloud first (federation runbook section 5, "Off").
- Keep the Cloudflare hostname and the edge network unchanged during an image rollback.

## Common operations

- **Recreate after a `runtime.env` change:** `$C up -d --force-recreate compute-api`, wait 15 s, then the health checks.
- **Stop Compute:** `$C stop compute-api`. Host agents back off and retry; Cloud shows Compute as unavailable.
