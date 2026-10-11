# syntax=docker/dockerfile:1
#
# Production image of the Support Ticket Tracker: one container, one Node process.
#  - The Node image is pinned to an exact version (requirements section 3).
#  - The AdminJS bundle of the custom components is built here, so the container starts in seconds and serves the
#    files that were built (ADMIN_JS_SKIP_BUNDLE=true).
#  - Runs as the unprivileged `node` user; the image holds no .env, no tests and no dev tools.
#  - Migrations are a separate step (they need the owner role, the application does not):
#      docker run --rm --env-file .env IMAGE npx prisma migrate deploy
#    and so are the commands: node dist/cli/admin-create.js, storage-reconcile.js, seed-*.js, smoke.js.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim

FROM ${NODE_IMAGE} AS build
# Prisma's engines need OpenSSL, which the slim image does not include.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY public ./public
RUN npm run build
# Needs no database: the bundler only reads the component files. The URLs satisfy Prisma's schema validation.
RUN NODE_ENV=production DATABASE_URL=postgresql://build:build@localhost:5432/build?schema=support DIRECT_URL=postgresql://build:build@localhost:5432/build?schema=support \
    node dist/cli/build-admin-bundle.js

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="support-ticket-tracker" \
      org.opencontainers.image.vendor="com.berney" \
      org.opencontainers.image.source="https://github.com/vasilykamenev/ticket-tracker"
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    ADMIN_JS_SKIP_BUNDLE=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build --chown=node:node /app/.adminjs ./.adminjs
USER node
EXPOSE 3000
# Liveness only: no configuration or database detail (that is /health/ready, for the platform's readiness probe).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
