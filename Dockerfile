# Node 22 matches the version used in stage 1 verification. NOT yet verified inside Docker (no Docker on the dev machine).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="support-ticket-tracker" \
      org.opencontainers.image.vendor="com.berney"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# AdminJS bundles custom components into .adminjs at startup; the runtime user must be able to write it.
RUN mkdir -p .adminjs && chown node:node .adminjs
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
