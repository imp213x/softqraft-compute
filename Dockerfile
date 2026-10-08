# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# SoftQraft Compute API image. Build it with deploy/scripts/build-compute-image.sh,
# which refuses a dirty tree and tags softqraft/compute:<full commit SHA>.
# The base is the same pinned Node 24 slim image as SoftQraft Cloud's.
ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS build-base

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack

# The Proxmox tests make a throwaway TLS certificate with openssl at run time.
RUN if ! command -v openssl >/dev/null 2>&1; then \
      apt-get update \
      && apt-get install -y --no-install-recommends openssl \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# pnpm through corepack, at the version package.json pins (packageManager).
RUN corepack enable pnpm && corepack prepare pnpm@9.15.0 --activate && pnpm --version


FROM build-base AS build

COPY . .

RUN --mount=type=cache,id=softqraft-compute-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# The release gate: build, typecheck, unit tests (the host agent's end-to-end
# test runs against the built API and the fake Proxmox), the cloud-federation-v1
# §9 conformance runner, check:boundaries, check:federation-vendor and
# check:console. test:pg needs a Postgres and cannot run here: it stays in CI
# (.github/workflows/ci.yml), which runs the full test:ci.
RUN pnpm run test:image \
    && test -f apps/api/dist/index.js \
    && test -f apps/api/dist/migrate.js \
    && test -f apps/console/console.html \
    && test -f apps/host-agent/dist/main.js

# Production bundles: the API with its production dependencies only, then its
# dist, migrations and the console assets beside it (the API serves
# ../console from its dist). The vendored federation kit publishes src, not
# dist, so its built dist is added to the bundle by hand.
RUN --mount=type=cache,id=softqraft-compute-pnpm,target=/pnpm/store,sharing=locked \
    pnpm --filter @softqraft/compute-api deploy --prod --store-dir /pnpm/store /out/apps/api \
    && rm -rf /out/apps/api/dist /out/apps/api/migrations /out/apps/api/src /out/apps/api/test \
    && cp -R apps/api/dist apps/api/migrations /out/apps/api/ \
    && federation=$(readlink -f /out/apps/api/node_modules/@softqraft/federation) \
    && rm -rf "$federation/dist" && cp -R packages/federation/dist "$federation/dist" \
    && mkdir -p /out/apps/console \
    && cp -R apps/console/console.html apps/console/admin.html apps/console/modules apps/console/styles apps/console/assets /out/apps/console/ \
    && find /out -name '*.test.*' -type f -delete \
    && cd /out/apps/api \
    && node --input-type=module -e "await import('/out/apps/api/dist/app.js'); await import('/out/apps/api/dist/store/index.js')" \
    && test -f /out/apps/api/dist/index.js \
    && test -f /out/apps/console/console.html

# The host agent bundle, for install.sh --from (docs/host-agent.md). Built and
# gated with the image, exported with --target host-agent-bundle --output.
RUN --mount=type=cache,id=softqraft-compute-pnpm,target=/pnpm/store,sharing=locked \
    pnpm --filter @softqraft/compute-host-agent deploy --prod --store-dir /pnpm/store /out/host-agent \
    && find /out/host-agent -name '*.test.*' -type f -delete \
    && test -f /out/host-agent/dist/main.js


FROM scratch AS host-agent-bundle

COPY --from=build /out/host-agent/ /


FROM ${NODE_IMAGE} AS runtime

ARG BUILD_REVISION=unknown
ARG BUILD_SOURCE=https://github.com/imp213x/softqraft-compute

LABEL org.opencontainers.image.title="SoftQraft Compute" \
      org.opencontainers.image.description="SoftQraft Compute API, Console and fleet pages" \
      org.opencontainers.image.source="${BUILD_SOURCE}" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    HOST=0.0.0.0 \
    PORT=8080

# Root-owned and read-only to the process: it runs as the image's `node` user.
COPY --from=build /out/apps /app/apps

WORKDIR /app/apps/api

USER node

EXPOSE 8080
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# Migrations, as a one-off with the same image: node dist/migrate.js
CMD ["node", "dist/index.js"]
