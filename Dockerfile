# Two-stage build: full workspace install to run the build, then a slim
# prod-only runtime image carrying just dist/.
#
# Layout matters here: src/app.tsx and src/data-dir.ts resolve the static
# asset root and the default data dir relative to their own module location
# (one level below the app root), not process.cwd() — see the comments in
# those files. tsdown bundles everything into a single dist/server.js, so at
# runtime that file's location IS "one level below the app root". Keep
# WORKDIR and the COPY layout below such that dist/server.js ends up at
# <WORKDIR>/dist/server.js, dist/public/ stays alongside it, and (if not
# overridden by ARTIFACTS_DATA_DIR) data/ sits at <WORKDIR>/data.

FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN VITE_GIT_HOOKS=0 pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm run build

FROM node:24-alpine AS runner
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=builder /app/dist ./dist

# Run as the non-root `node` user baked into the base image (uid/gid 1000)
# rather than root. Everything under /app is read-only for this process
# except the bind-mounted data dir, whose write access is verified in
# docker-compose.yaml's data volume comment / deploy verification.
USER node

EXPOSE 3000

# Liveness probe: hits `/` so `docker ps` and any orchestrator that gates on
# container health can see the server is actually bound. Note caddy-docker-proxy
# itself does not gate upstreams on health status; Caddy's own retries cover the
# brief cold-start window. wget is the busybox one bundled in node:*-alpine.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "dist/server.js"]
