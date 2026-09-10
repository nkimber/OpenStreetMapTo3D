# StreetRove

**Your neighborhood. Your world. Your drive.**

StreetRove is an open-source application for turning OpenStreetMap
neighborhood data into a saved, editable 3D world that can be explored by car.

## Run it

Docker Desktop is the only runtime prerequisite:

```powershell
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173). Choose the bundled sample
for a deterministic import, or search for a location and use live OpenStreetMap
data through the configured Overpass provider. PostGIS data and compressed OSM
snapshots persist in named Docker volumes.

Stop the services with `docker compose down`. Add `--volumes` only when you
intentionally want to remove local projects and cached source data.

## Implemented stack

- TypeScript, React, Vite, and MapLibre GL JS
- Three.js rendering
- Rapier3D vehicle physics
- Fastify API
- PostgreSQL and PostGIS
- Docker Compose development environment

## What works

- Explicit geocoding and direct latitude/longitude entry
- Rectangular MapLibre selection with imported feature preview
- Rate-limited Nominatim and bounded Overpass adapters
- Immutable, content-addressed OSM snapshots in PostgreSQL/PostGIS
- Immutable elevation grids from USGS 3DEP, plus a deterministic offline hill
  fixture and diagnosed flat fallback outside coverage
- Deterministic local-ENU terrain, grade-smoothed roads, terrain-conformed land,
  and vertically extruded buildings
- Cancelable Web Worker generation into deterministic 256 m chunks
- Joined road strips, layer-aware intersections/end caps, and provenance
- Three.js inspect mode and fixed-step Rapier ray-cast vehicle driving
- Shared Three.js/Rapier heightfields, drivable road strips, bridge decks,
  tunnel open cuts, and elevation-aware vehicle spawn/recovery
- Keyboard and standard-gamepad controls with safe-pose recovery
- Persistent height, width, visibility, and exact road-spawn overrides
- Undo/redo and affected-chunk-only rebuilds in the live editor
- Build hash, worker timing, frame, triangle, recovery, and diagnostic telemetry
- Saved/recent worlds with visible OpenStreetMap and elevation attribution
- Fully offline sample data and representative geometry/physics fixtures

## Verify it

With Node.js 24 and pnpm available locally:

```powershell
corepack pnpm install
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

The end-to-end test expects the Docker Compose stack to be running.

## Documentation

For the password-protected OVHcloud pilot, see the
[VPS deployment guide](deploy/README.md).

See the [project documentation](documents/README.md) for the product scope,
user workflow, technical architecture, data pipeline, development environment,
testing strategy, and delivery roadmap.

## Data licensing

Application source code is licensed under the MIT License. OpenStreetMap data
is provided under the Open Data Commons Open Database License (ODbL) and must
be attributed to OpenStreetMap contributors. The initial USGS 3DEP elevation
source is public domain and is attributed separately in generated worlds.
