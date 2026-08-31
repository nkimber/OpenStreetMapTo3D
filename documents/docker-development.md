# Docker development

Status: Implemented

Last updated: 2026-08-30

## Goal

A contributor with Docker Desktop and Git should be able to run the project
without installing Node.js or PostgreSQL on the host.

The intended command is:

```powershell
docker compose up --build
```

The application is available at [http://localhost:5173](http://localhost:5173)
after the web service finishes its workspace-package build.

## Development services

### `web`

- Node-based Vite development server
- Source copied into the development image for consistent Windows/Linux pnpm
  links; rebuild the service image after source changes
- Exposes the browser application on localhost
- Proxies `/api` to the API service

### `api`

- Node-based Fastify development process
- Source copied into the development image
- Connects to PostGIS through the Compose network
- Writes compressed source snapshots to the cache volume
- Is not exposed publicly except through the web development proxy unless a
  debugging profile is selected

### `db`

- Pinned PostgreSQL/PostGIS image and digest
- Internal Compose network only by default
- Health check uses `pg_isready`
- Persistent named volume for database data

## Volumes

- `postgres_data`: durable database files
- `osm_cache`: compressed source snapshots and rebuildable artifacts
- Dependency caches may be named volumes, but source directories must not be
  hidden by a volume mounted over the workspace

Neither volume belongs in Git.

## Dockerfile strategy

The multi-stage Dockerfile uses these named targets:

- `base`: Node image, Corepack, and pinned pnpm
- `dependencies`: workspace dependency installation from lockfiles
- `development`: source tree and development commands
- `build`: compile packages, API, and web assets
- `production`: minimal runtime containing API output and static web assets

The final application image serves both the compiled API and web assets. PostGIS
remains a separate container.

## Configuration

Configuration is environment-based and validated on API startup. Planned
variables include:

```text
DATABASE_URL
PUBLIC_APP_URL
NOMINATIM_BASE_URL
OVERPASS_BASE_URL
OSM_USER_AGENT
OSM_CACHE_DIRECTORY
MAX_IMPORT_AREA_SQUARE_KM
MAX_IMPORT_RESPONSE_BYTES
LOG_LEVEL
```

The repository contains `.env.example` with non-secret development defaults.
Real `.env` files are ignored. Container images must not contain credentials.

## Health and readiness

- `/api/health` confirms the API process is running.
- `/api/ready` verifies required configuration, database connectivity, schema
  migrations, and cache-directory writability.
- External OSM provider outages do not make the local application unready;
  provider state is reported separately.

Compose health checks gate dependent service startup where useful. Application
logic must still tolerate a dependency becoming unavailable after startup.

## Development commands

Commands exposed through the workspace package scripts:

```text
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm db:migrate
```

`pnpm test:e2e` expects the Compose stack to be running. The CI workflow starts
the stack and runs every listed gate automatically.

## Production considerations

- Run as a non-root user.
- Use a read-only root filesystem where practical.
- Mount only the required writable cache directory.
- Pin images and dependencies rather than relying on `latest`.
- Apply database migrations as an explicit deployment step.
- Configure request limits, trusted proxy behavior, and allowed origins.
- Back up project records and source snapshots together.
