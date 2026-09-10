# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
WORKDIR /workspace

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/geo/package.json packages/geo/package.json
COPY packages/osm/package.json packages/osm/package.json
COPY packages/worldgen/package.json packages/worldgen/package.json
COPY packages/simulation/package.json packages/simulation/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
COPY . .
CMD ["pnpm", "dev"]

FROM dependencies AS build
COPY . .
RUN pnpm build
RUN pnpm --filter @osm3d/api deploy --prod --legacy /opt/osm3d-api

FROM node:24-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app/api
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data/osm \
    && chown appuser:appuser /data/osm
ENV OSM_CACHE_DIRECTORY=/data/osm
COPY --from=build --chown=appuser:appuser /opt/osm3d-api ./
COPY --from=build --chown=appuser:appuser /workspace/apps/web/dist ./public
COPY --from=build --chown=appuser:appuser /workspace/database ./database
USER appuser
EXPOSE 3000
CMD ["node", "dist/server.js"]
