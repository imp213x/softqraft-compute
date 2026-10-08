#!/bin/sh
# Install the SoftQraft Compute host agent on a Proxmox host.
#
#   sudo deploy/host-agent/install.sh            # build from this checkout (needs pnpm and Node 24)
#   sudo deploy/host-agent/install.sh --from DIR # copy a bundle made by `pnpm --filter @softqraft/compute-host-agent deploy --prod DIR`
#   ... --node-tarball FILE --node-sha256 HEX   # also install Node 24 from the official nodejs.org tarball
#
# --node-tarball takes node-v24.x.y-linux-x64.tar.xz (or .tar.gz) that the operator downloaded
# from nodejs.org, and --node-sha256 the digest SHASUMS256.txt lists for it. The script checks
# the digest BEFORE extracting anything, extracts into /opt/node-v24.x.y-linux-x64 (kept if it
# already exists) and points the unit at that node. It never downloads anything and never adds
# an apt source. docs/host-agent.md ("Node 24 from the official tarball") has the steps.
#
# What it does, and nothing else:
#   - creates the system user and group softqraft-compute (no shell, no home);
#   - creates /var/lib/softqraft-compute-agent (0700, owned by the agent) and /etc/softqraft (0755);
#   - installs the agent into a new /opt/softqraft-compute-agent/releases/<time> and points
#     /opt/softqraft-compute-agent/current at it (earlier releases are kept);
#   - writes /etc/softqraft/compute-agent.env.example (names only); never touches an existing
#     /etc/softqraft/compute-agent.env;
#   - installs the systemd unit (pointed at the Node it checked) and reloads systemd.
#     It does NOT enable or start the agent.
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
NODE_TARBALL=""
NODE_SHA256=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=${2:?--from needs a directory}; shift 2 ;;
    --node-tarball) NODE_TARBALL=${2:?--node-tarball needs a file}; shift 2 ;;
    --node-sha256) NODE_SHA256=${2:?--node-sha256 needs a SHA-256 digest}; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh: run as root" >&2
  exit 1
fi

# 0. Node 24 from the official tarball (decision F6), checked before anything is extracted.
if [ -n "$NODE_TARBALL" ] || [ -n "$NODE_SHA256" ]; then
  if [ -z "$NODE_TARBALL" ] || [ -z "$NODE_SHA256" ]; then
    echo "install.sh: --node-tarball and --node-sha256 go together" >&2
    exit 2
  fi
  if [ ! -f "$NODE_TARBALL" ]; then
    echo "install.sh: $NODE_TARBALL is not a file" >&2
    exit 1
  fi
  NODE_FILE=$(basename -- "$NODE_TARBALL")
  case "$NODE_FILE" in
    *.tar.xz) NODE_DIR_NAME=${NODE_FILE%.tar.xz} ;;
    *.tar.gz) NODE_DIR_NAME=${NODE_FILE%.tar.gz} ;;
    *) NODE_DIR_NAME="" ;;
  esac
  if ! printf '%s\n' "$NODE_DIR_NAME" | grep -Eq '^node-v24\.[0-9]+\.[0-9]+-linux-x64$'; then
    echo "install.sh: expected node-v24.x.y-linux-x64.tar.xz from nodejs.org, got $NODE_FILE" >&2
    exit 1
  fi
  EXPECTED=$(printf '%s' "$NODE_SHA256" | tr 'A-F' 'a-f')
  if ! printf '%s\n' "$EXPECTED" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "install.sh: --node-sha256 must be 64 hexadecimal digits" >&2
    exit 2
  fi
  ACTUAL=$(sha256sum -- "$NODE_TARBALL" | cut -d ' ' -f 1)
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "install.sh: SHA-256 mismatch for $NODE_FILE (expected $EXPECTED, got $ACTUAL). Nothing was extracted." >&2
    exit 1
  fi
  echo "install.sh: $NODE_FILE matches its SHA-256"
  NODE_HOME="/opt/$NODE_DIR_NAME"
  if [ -e "$NODE_HOME" ]; then
    if [ ! -x "$NODE_HOME/bin/node" ]; then
      echo "install.sh: $NODE_HOME exists but has no bin/node; move it aside and run again" >&2
      exit 1
    fi
    echo "install.sh: $NODE_HOME already exists; keeping it"
  else
    case "$NODE_FILE" in
      *.tar.xz)
        if ! command -v xz >/dev/null 2>&1; then
          echo "install.sh: xz is needed to unpack $NODE_FILE (Debian package xz-utils), or use the .tar.gz tarball" >&2
          exit 1
        fi ;;
    esac
    # Every entry must sit inside the one expected directory. The listing
    # goes to a file first, so a listing that fails stops the script.
    NODE_LIST=$(mktemp)
    if ! tar -tf "$NODE_TARBALL" > "$NODE_LIST"; then
      rm -f "$NODE_LIST"
      echo "install.sh: cannot read $NODE_FILE as a tar archive" >&2
      exit 1
    fi
    if [ ! -s "$NODE_LIST" ] || grep -Ev "^$NODE_DIR_NAME/" "$NODE_LIST" | grep -q . || grep -Eq '(^|/)\.\.(/|$)' "$NODE_LIST"; then
      rm -f "$NODE_LIST"
      echo "install.sh: $NODE_FILE has entries outside $NODE_DIR_NAME/; refusing it" >&2
      exit 1
    fi
    rm -f "$NODE_LIST"
    NODE_TMP=$(mktemp -d /opt/.softqraft-node.XXXXXX)
    tar -xf "$NODE_TARBALL" -C "$NODE_TMP" --no-same-owner
    chown -R root:root "$NODE_TMP/$NODE_DIR_NAME"
    chmod -R go-w "$NODE_TMP/$NODE_DIR_NAME"
    chmod 0755 "$NODE_TMP/$NODE_DIR_NAME"
    mv -T "$NODE_TMP/$NODE_DIR_NAME" "$NODE_HOME"
    rmdir "$NODE_TMP"
    echo "install.sh: Node installed in $NODE_HOME"
  fi
  NODE="$NODE_HOME/bin/node"
  WANT_VERSION=${NODE_DIR_NAME#node-}
  WANT_VERSION=${WANT_VERSION%-linux-x64}
  GOT_VERSION=$("$NODE" -v)
  if [ "$GOT_VERSION" != "$WANT_VERSION" ]; then
    echo "install.sh: $NODE reports $GOT_VERSION, expected $WANT_VERSION" >&2
    exit 1
  fi
fi

if [ ! -x "$NODE" ]; then
  echo "install.sh: $NODE not found. Install Node.js 24 first (--node-tarball and --node-sha256)." >&2
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
  NODE_BIN_DIR=$(dirname -- "$NODE")
  (cd "$REPO" && PATH="$NODE_BIN_DIR:$PATH" && export PATH && pnpm install --frozen-lockfile \
    && pnpm --filter "@softqraft/compute-host-agent..." run build \
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

# 4. systemd unit (not enabled, not started), pointed at the Node checked above.
case "$NODE" in
  *[!A-Za-z0-9/._-]*) echo "install.sh: unexpected characters in $NODE" >&2; exit 1 ;;
esac
UNIT_TMP=$(mktemp)
sed "s#^ExecStart=/usr/bin/node #ExecStart=$NODE #" "$HERE/softqraft-compute-agent.service" > "$UNIT_TMP"
if ! grep -q "^ExecStart=$NODE /opt/softqraft-compute-agent/current/dist/main.js\$" "$UNIT_TMP"; then
  rm -f "$UNIT_TMP"
  echo "install.sh: could not point the unit at $NODE" >&2
  exit 1
fi
install -m 0644 -o root -g root "$UNIT_TMP" "$UNIT"
rm -f "$UNIT_TMP"
systemctl daemon-reload

echo "Installed $RELEASE (Node: $NODE)"
echo "Next (Compute runbook, agent install step): fill $ETC_DIR/compute-agent.env (mode 0600, COMPUTE_AGENT_DRY_RUN=true first),"
echo "then: systemctl enable --now softqraft-compute-agent && journalctl -u softqraft-compute-agent -f"
