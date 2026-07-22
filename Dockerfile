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
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm run build

FROM node:24-alpine AS runner
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server.js"]
