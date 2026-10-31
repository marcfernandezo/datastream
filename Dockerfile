# syntax=docker/dockerfile:1.7
# Multi-arch (linux/amd64, linux/arm64) image for Datastream: web + worker.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=true
RUN corepack enable
WORKDIR /app

FROM base AS deps
# Fallback toolchain only for native modules without a prebuild for this arch.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:${NODE_VERSION}-bookworm-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/datastream.db \
    BACKUP_DIR=/data/backups \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
# Standalone output: server.js, traced node_modules, static assets, migrations
# and the bundled worker/CLI (see scripts/assemble-standalone.mjs).
COPY --from=build --chown=node:node /app/.next/standalone ./
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
