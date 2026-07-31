# Two-stage build: full workspace install to run the build, then a slim
# prod-only runtime image carrying just dist/.
#
# Layout matters here: src/app.tsx and src/data-dir.ts resolve the static
# asset root and the default data dir relative to their own module location
# (one level below the app root), not process.cwd() — see the comments in
# those files. tsdown bundles everything into a single dist/server.js, so at
# runtime that file's location IS "one level below the app root". Keep
# WORKDIR and the COPY layout below such that dist/server.js ends up at
# <WORKDIR>/dist/server.js and dist/public/ stays alongside it.

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
ENV ARTIFACTS_PORT=3000
ENV ARTIFACTS_DATABASE_PATH=/app/data/database/artifacts.db
ENV ARTIFACTS_FILES_DIR=/app/data/files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data/database /app/data/files && chown -R node:node /app/data

# Run as the non-root `node` user baked into the base image (uid/gid 1000)
# rather than root. Everything under /app is read-only for this process except
# the two persistence paths, which are prepared for independent named volumes.
# Host bind mounts retain host ownership and must be writable by this user; the
# Docker operator probes that access before replacing a running container.
USER node

EXPOSE ${ARTIFACTS_PORT}

# Liveness probe: hits `/` so `docker ps` and any orchestrator that gates on
# container health can see the server is actually bound. wget is the busybox
# implementation bundled in node:*-alpine.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${ARTIFACTS_PORT}/" || exit 1

CMD ["node", "dist/server.js"]
