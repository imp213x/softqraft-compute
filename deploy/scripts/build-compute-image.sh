#!/usr/bin/env sh
# Build the SoftQraft Compute API image from a clean checkout, tagged with the
# full commit SHA. The image build runs the test gate (pnpm run test:image).
#
#   sh ./deploy/scripts/build-compute-image.sh
#   sh ./deploy/scripts/build-compute-image.sh --agent-bundle /tmp/softqraft-compute-agent.tar.gz
#
# --agent-bundle also exports the host agent bundle built and gated in the same
# build, as one tarball with bundle/ (for install.sh --from) and install/ (this
# commit's deploy/host-agent: install.sh, the unit, the env example), and prints
# its SHA-256 (docs/host-agent.md, "Install").
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "${script_directory}/../.." && pwd)
cd "$repository_root"

agent_bundle=""
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-bundle) agent_bundle=${2:?--agent-bundle needs a file name ending in .tar.gz}; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -n "$(git status --porcelain)" ]; then
  printf '%s\n' 'Refusing to build from a dirty worktree.' >&2
  exit 1
fi

if [ -n "$agent_bundle" ]; then
  case "$agent_bundle" in
    *.tar.gz) ;;
    *) printf '%s\n' '--agent-bundle needs a file name ending in .tar.gz' >&2; exit 2 ;;
  esac
  if [ -e "$agent_bundle" ]; then
    printf 'Refusing to overwrite %s\n' "$agent_bundle" >&2
    exit 1
  fi
fi

revision=$(git rev-parse --verify HEAD)
image_repository=${SOFTQRAFT_COMPUTE_IMAGE_REPOSITORY:-softqraft/compute}
image_reference="${image_repository}:${revision}"
source_url=$(git config --get remote.origin.url || true)

case "$source_url" in
  https://*@*|http://*@*) source_url=unknown ;;
esac

docker build \
  --pull \
  --build-arg BUILD_REVISION="$revision" \
  --build-arg BUILD_SOURCE="${source_url:-unknown}" \
  --tag "$image_reference" \
  .

# The built entry points exist and their imports resolve, without a database,
# a network or a writable file system.
docker run --rm --network none --read-only --entrypoint sh "$image_reference" -c \
  'test -f dist/index.js && test -f dist/migrate.js && test -f ../console/console.html && test -d migrations' \
  || { printf '%s\n' 'The image has no API entry point, migrations or console.' >&2; exit 1; }
docker run --rm --network none --read-only --entrypoint node "$image_reference" \
  --input-type=module -e "await import('/app/apps/api/dist/app.js')" \
  || { printf '%s\n' 'The API entry point does not load in the image.' >&2; exit 1; }
if [ "$(docker image inspect --format '{{.Config.User}}' "$image_reference")" != "node" ]; then
  printf '%s\n' 'The image does not run as the non-root node user.' >&2
  exit 1
fi

printf 'Built %s\n' "$image_reference"

if [ -n "$agent_bundle" ]; then
  bundle_directory=$(mktemp -d)
  docker build \
    --build-arg BUILD_REVISION="$revision" \
    --build-arg BUILD_SOURCE="${source_url:-unknown}" \
    --target host-agent-bundle \
    --output "type=local,dest=${bundle_directory}/bundle" \
    .
  if [ ! -f "${bundle_directory}/bundle/dist/main.js" ]; then
    rm -rf "$bundle_directory"
    printf '%s\n' 'The host agent bundle has no dist/main.js.' >&2
    exit 1
  fi
  cp -R deploy/host-agent "${bundle_directory}/install"
  printf '%s\n' "$revision" > "${bundle_directory}/COMMIT"
  tar -czf "$agent_bundle" -C "$bundle_directory" COMMIT bundle install
  rm -rf "$bundle_directory"
  printf 'Host agent bundle %s (commit %s)\n' "$agent_bundle" "$revision"
  sha256sum "$agent_bundle"
fi

printf 'Deploy with SOFTQRAFT_COMPUTE_IMAGE_TAG=%s\n' "$revision"
