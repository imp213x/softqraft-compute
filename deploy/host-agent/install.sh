#!/bin/sh
# Install the SoftQraft Compute host agent on a Proxmox host.
#
#   sudo deploy/host-agent/install.sh            # build from this checkout (needs pnpm and Node 24)
#   sudo deploy/host-agent/install.sh --from DIR # copy a bundle made by `pnpm --filter @softqraft/compute-host-agent deploy --prod DIR`
#
# What it does, and nothing else:
#   - creates the system user and group softqraft-compute (no shell, no home);
#   - creates /var/lib/softqraft-compute-agent (0700, owned by the agent) and /etc/softqraft (0755);
#   - installs the agent into a new /opt/softqraft-compute-agent/releases/<time> and points
#     /opt/softqraft-compute-agent/current at it (earlier releases are kept);
#   - writes /etc/softqraft/compute-agent.env.example (names only); never touches an existing
#     /etc/softqraft/compute-agent.env;
#   - installs the systemd unit and reloads systemd. It does NOT enable or start the agent.
# It deletes nothing, changes no firewall rule and never calls Proxmox.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$HERE/../.." && pwd)
USER_NAME=softqraft-compute
PREFIX=/opt/softqraft-compute-agent
STATE_DIR=/var/lib/softqraft-compute-agent
ETC_DIR=/etc/softqraft
UNIT=/etc/systemd/system/softqraft-compute-agent.service
NODE=/usr/bin/node
FROM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=${2:?--from needs a directory}; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh: run as root" >&2
  exit 1
fi

if [ ! -x "$NODE" ]; then
  echo "install.sh: $NODE not found. Install Node.js 24 first." >&2
  exit 1
fi
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "install.sh: Node.js 24 or newer is required at $NODE (found $NODE_MAJOR)" >&2
  exit 1
fi

# 1. User and directories.
if ! getent group "$USER_NAME" >/dev/null; then
  groupadd --system "$USER_NAME"
fi
if ! getent passwd "$USER_NAME" >/dev/null; then
  useradd --system --gid "$USER_NAME" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_NAME"
fi
install -d -m 0755 -o root -g root "$PREFIX" "$PREFIX/releases" "$ETC_DIR"
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$STATE_DIR"

# 2. The agent bundle.
RELEASE="$PREFIX/releases/$(date -u +%Y%m%dT%H%M%SZ)"
if [ -e "$RELEASE" ]; then
  echo "install.sh: $RELEASE already exists; wait a second and run again" >&2
  exit 1
fi
if [ -n "$FROM" ]; then
  [ -f "$FROM/dist/main.js" ] || { echo "install.sh: $FROM has no dist/main.js" >&2; exit 1; }
  install -d -m 0755 "$RELEASE"
  cp -R "$FROM"/. "$RELEASE"/
else
  command -v pnpm >/dev/null || { echo "install.sh: pnpm not found; build elsewhere and use --from" >&2; exit 1; }
  (cd "$REPO" && pnpm install --frozen-lockfile && pnpm --filter "@softqraft/compute-host-agent..." run build \
    && pnpm --filter @softqraft/compute-host-agent deploy --prod "$RELEASE")
fi
chown -R root:root "$RELEASE"
chmod -R go-w "$RELEASE"
ln -sfn "$RELEASE" "$PREFIX/current.new"
mv -T "$PREFIX/current.new" "$PREFIX/current"

# 3. Env example (names only). The real env file is written by the operator.
install -m 0644 -o root -g root "$HERE/compute-agent.env.example" "$ETC_DIR/compute-agent.env.example"
if [ -f "$ETC_DIR/compute-agent.env" ]; then
  PERM=$(stat -c %a "$ETC_DIR/compute-agent.env")
  case "$PERM" in
    600|640) ;;
    *) echo "install.sh: warning: $ETC_DIR/compute-agent.env has mode $PERM; make it 0600 (root)" >&2 ;;
  esac
fi

# 4. systemd unit (not enabled, not started).
install -m 0644 -o root -g root "$HERE/softqraft-compute-agent.service" "$UNIT"
systemctl daemon-reload

echo "Installed $RELEASE"
echo "Next (runbook section 6): fill $ETC_DIR/compute-agent.env (mode 0600, start with COMPUTE_AGENT_DRY_RUN=true),"
echo "then: systemctl enable --now softqraft-compute-agent && journalctl -u softqraft-compute-agent -f"
