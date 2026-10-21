# syntax=docker/dockerfile:1.7
#
# One Dockerfile for every Node service in the monorepo:
#   docker build -f docker/node-app.Dockerfile --build-arg APP=api .
#   docker build -f docker/node-app.Dockerfile --build-arg APP=worker .
#
# Stages: prune the monorepo to one app (turbo) -> install with a warm pnpm
# store -> bundle -> `pnpm deploy` production deps -> distroless runtime.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-trixie-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# --- prune: keep only the target app and the workspace packages it uses -----
FROM base AS pruner
ARG APP
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @lifeos/${APP} --docker

# --- build ------------------------------------------------------------------
FROM base AS builder
ARG APP
# Manifests first so the dependency layer is cached until a lockfile changes.
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
# turbo prune keeps workspace packages only; the shared tsconfig lives at the root.
COPY tsconfig.base.json ./
RUN pnpm --filter @lifeos/${APP} build
# Flat (hoisted) production node_modules: bundled workspace code resolves its
# npm deps from the app root.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @lifeos/${APP} deploy --prod --legacy --config.node-linker=hoisted /out

# --- runtime ----------------------------------------------------------------
# Distroless: no shell or package manager, runs as UID 65532, compatible with
# readOnlyRootFilesystem.
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian13:nonroot AS runtime
ARG APP
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/Synknite/lifeos
LABEL org.opencontainers.image.title="lifeos-${APP}" \
      org.opencontainers.image.description="LifeOS ${APP}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    SERVICE_VERSION=${VERSION} \
    NODE_OPTIONS="--enable-source-maps"
WORKDIR /app
COPY --from=builder --chown=65532:65532 /out/ ./
USER 65532:65532
EXPOSE 3000 9000
# The distroless entrypoint is `node`; `--import` loads OpenTelemetry before
# any instrumented module.
CMD ["--import", "./dist/instrumentation.js", "dist/main.js"]
