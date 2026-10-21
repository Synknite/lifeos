# syntax=docker/dockerfile:1.7
#
# Static SPA served by unprivileged nginx (UID 101, port 8080).
#   docker build -f docker/web.Dockerfile .

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @lifeos/web --docker

FROM base AS builder
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
# turbo prune keeps workspace packages only; the shared tsconfig lives at the root.
COPY tsconfig.base.json ./
RUN pnpm --filter @lifeos/web build

FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/OWNER/lifeos
LABEL org.opencontainers.image.title="lifeos-web" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT"
ENV API_UPSTREAM=http://api:3000 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|NGINX_LOCAL_RESOLVERS)$"
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
