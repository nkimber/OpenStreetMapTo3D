# Implementation status

Status: Active

Last updated: 2026-08-30

## Working vertical slice

The repository contains a runnable MVP. `docker compose up --build` starts
PostGIS, the Fastify API, and the Vite web application. The primary workflow has
been exercised in Chromium from import through driving and reopening a saved
world.

Implemented capabilities:

- Explicit Nominatim search and direct coordinate entry
- Movable, bounded rectangular selection in MapLibre
- Offline fixture and live bounded Overpass imports
- Content-addressed compressed source cache and immutable snapshot records
- OSM road, building, land, water, and multipolygon normalization
- Preview overlays and source-coverage counts before generation
- WGS84/ECEF/local-ENU coordinate conversion
- Flat ground, road meshes, land areas, and extruded building meshes
- Inspect and Drive modes with fixed-step Rapier vehicle physics
- Road-aligned vehicle spawn, chase camera, keyboard input, and reset
- Persistent worlds plus building-height, road-width, visibility, and spawn
  overrides
- PostGIS migrations, structured validation errors, health/readiness endpoints,
  source attribution, linting, unit tests, browser smoke coverage, and CI
- Development and production Docker image targets

## Verification snapshot

The current automated gates are:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
docker build --target production .
```

The browser test uses the bundled sample and does not contact geocoding or
Overpass. Base-map tiles are an optional external visual layer and are not an
input to world generation.

## Known MVP limitations

- Terrain is flat; elevation and imagery are roadmap work.
- Roads are rendered as per-segment ribbons rather than a fully joined lane and
  intersection mesh.
- Building collision uses bounding boxes and generated roofs are flat.
- The car spawn is chosen from the selected road rather than an exact clicked
  point along that road.
- Import work runs in the API process and browser mesh preparation runs on the
  main thread for the bounded MVP area.
- Editing does not yet provide undo/redo or partial chunk rebuilding.
- Public provider availability and data coverage vary; the fixture is the
  reproducible fallback.

These limitations correspond to later items in the
[delivery roadmap](delivery-roadmap.md), not missing setup steps.
