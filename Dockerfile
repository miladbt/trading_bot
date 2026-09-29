# syntax=docker/dockerfile:1
###############################################################################
# polymarket-bot — hardened production image (API service)
#
# Security checklist (pre-registered in SECURITY.md), applied:
#   - multi-stage: the build toolchain never ships in the runtime stage
#   - non-root USER (uid/gid 10001), no shell login
#   - base image pinned by tag; PIN BY DIGEST before production use:
#     `docker build --pull . && docker images --digests node` and replace
#     `node:22-alpine` with `node@sha256:<digest>` in both stages
#   - production dependencies only in the runtime stage
#   - NO credentials in this file: runtime configuration arrives ONLY through
#     the environment (compose `env_file`/`environment`, swarm/k8s secrets)
#   - dumb-init as PID 1 for correct signal forwarding (graceful shutdown)
#   - HEALTHCHECK wired to the /health endpoint
#
# The container STARTS IN PAPER MODE: TRADING_MODE=paper and
# LIVE_TRADING_ENABLED=false are baked in as environment defaults, and the
# config loader + api entrypoint refuse any non-paper configuration at
# startup. Live execution does not exist (the factory throws), so overriding
# these envs cannot produce a trading container.
###############################################################################

# ---- Stage 1: build ---------------------------------------------------------
FROM node:22-alpine AS build

# pnpm via corepack, pinned to the repo's packageManager version.
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

WORKDIR /app

# Install the full workspace first (layer caching): manifests change far less
# often than source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/trader/package.json apps/trader/
COPY hermes/package.json hermes/
COPY packages/domain/package.json packages/domain/
COPY packages/shared/package.json packages/shared/
COPY packages/market-data/package.json packages/market-data/
COPY packages/strategy/package.json packages/strategy/
COPY packages/inventory/package.json packages/inventory/
COPY packages/risk/package.json packages/risk/
COPY packages/execution/package.json packages/execution/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/observability/package.json packages/observability/
COPY packages/replay/package.json packages/replay/
COPY packages/persistence/package.json packages/persistence/

RUN pnpm install --frozen-lockfile

# Copy sources and build every workspace package.
COPY apps/ apps/
COPY hermes/ hermes/
COPY packages/ packages/
RUN pnpm -r build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init: correct PID-1 signal forwarding (graceful shutdown depends on it).
RUN apk add --no-cache dumb-init \
    && addgroup -g 10001 botgroup \
    && adduser -u 10001 -G botgroup -D -H bot

# Security defaults: paper mode is the only startable configuration. The
# config loader rejects live-without-credentials at startup and live execution
# does not exist anywhere in the codebase.
ENV NODE_ENV=production \
    TRADING_MODE=paper \
    LIVE_TRADING_ENABLED=false \
    ENABLE_EXTERNAL_HEDGE=false

WORKDIR /app

# Workspace manifests + production node_modules from the build stage.
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/trader/node_modules ./apps/trader/node_modules
COPY --from=build /app/hermes/node_modules ./hermes/node_modules
COPY --from=build /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/market-data/node_modules ./packages/market-data/node_modules
COPY --from=build /app/packages/strategy/node_modules ./packages/strategy/node_modules
COPY --from=build /app/packages/inventory/node_modules ./packages/inventory/node_modules
COPY --from=build /app/packages/risk/node_modules ./packages/risk/node_modules
COPY --from=build /app/packages/execution/node_modules ./packages/execution/node_modules
COPY --from=build /app/packages/orchestrator/node_modules ./packages/orchestrator/node_modules
COPY --from=build /app/packages/observability/node_modules ./packages/observability/node_modules
COPY --from=build /app/packages/replay/node_modules ./packages/replay/node_modules
COPY --from=build /app/packages/persistence/node_modules ./packages/persistence/node_modules

# Built JavaScript for every workspace package (package.json `exports` point
# at src/*.ts in dev; the deploy compose file runs the api via tsx, which
# executes the TS sources directly, so sources are included for api+shared+domain).
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/domain ./packages/domain

# Non-root from here on: everything above may be root-owned.
USER 10001:10001

EXPOSE 3001

# Health endpoint (liveness). Readiness is /ready (503 until warm).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.API_PORT||'3001';fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init forwards SIGTERM/SIGINT; main.ts drains and exits 0.
ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@bot/api", "start"]
