# Implementation status

Status: Active

Last updated: 2026-08-31

## Working vertical slice

The repository contains a runnable, editable neighborhood-driving application.
`docker compose up --build` starts PostGIS, the Fastify API, and the Vite web
application. The primary workflow is covered in Chromium from offline import
through generation, editing, driving, and reopening the persisted result.

Implemented capabilities:

- Explicit Nominatim search, direct coordinate entry, and movable MapLibre area
  selection
- Offline fixture and live bounded Overpass imports
- Content-addressed compressed source cache and immutable snapshot records
- Immutable elevation snapshots with USGS 3DEP, deterministic synthetic fixture,
  and a diagnosed flat fallback outside coverage
- OSM road, building, land, water, and multipolygon normalization
- Preview overlays and source-coverage counts before generation
- WGS84/ECEF/local-ENU coordinate conversion
- Cancelable, versioned Web Worker builds with deterministic 256 m chunks and a
  stable 64-bit build hash
- Joined/mitered road strips, layer-aware intersection and end-cap surfaces,
  grade-smoothed 3D road profiles, blended shoulders, terrain-conformed land,
  and extruded building meshes based at median footprint elevation
- Deterministic 256 m terrain chunks with shared edges, 8 m Three.js meshes,
  matching Rapier heightfields, and elevation-aware build hashes
- Separate bridge deck geometry/colliders and drivable diagnosed open cuts for
  tunnels that cannot be represented as heightfield overhangs
- Height and width provenance (`source`, `levels`/`lanes`, class/fallback, or
  `override`) plus non-fatal generation diagnostics
- Inspect and Drive modes with fixed-step Rapier vehicle physics
- Exact clicked-road spawn snapping, keyboard and standard-gamepad input,
  steering sensitivity, speed limiting, safe reset, original-spawn return, and
  automatic recovery from sustained invalid poses
- Persistent building-height, road-width, visibility, and spawn overrides
- Undo/redo, hidden-feature restoration, and affected-chunk-only visual and
  collision rebuilds
- Build/performance telemetry for frame rate, triangles, worker duration,
  terrain source/range/car elevation, long frames, diagnostics, recoveries,
  chunks rebuilt, and deterministic hash
- PostGIS migrations, structured validation errors, health/readiness endpoints,
  source attribution, linting, unit/fixture/physics tests, browser coverage, and
  CI
- Development and production Docker image targets

## Verification snapshot

The current automated suite contains 34 unit, geometry, provider, and Rapier
tests across eleven test files, plus the Chromium end-to-end workflow. The expected
gates are:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
docker build --target production .
```

The browser test imports the bundled sample, verifies elevation source/range and
attribution, a one-chunk edit rebuild, undo/redo, hide/show, capped driving,
resets, and persisted state after reopen.
It does not contact geocoding or Overpass. Base-map tiles are an optional
external visual layer and are not an input to world generation.

## Current limitations

- Live elevation currently uses USGS 3DEP. Areas without coverage receive a
  diagnosed flat fallback; a global DEM adapter remains future work.
- Intersections use deterministic overlap discs and joined centerline strips,
  not lane-level topology, markings, turn rules, or curb geometry.
- Bridges have inferred raised decks, but explicit `ele`, `height`, and endpoint
  structure metadata are not yet fully interpreted. Tunnels are open cuts rather
  than closed overhangs because Rapier heightfields cannot represent caves.
- Building collision uses bounding boxes and generated roofs are flat.
- The Worker returns serializable geometry plans. Three.js buffer upload and
  Rapier object creation still occur on the main thread.
- Progress stages are coarse and cancellation restarts a build rather than
  resuming it.
- The standard gamepad layout is fixed; control remapping, touch input, extra
  driving cameras, minimap, traffic, and pedestrians are not implemented.
- Public provider availability and OSM feature coverage vary; the fixture is
  the reproducible fallback.

The remaining limitations align with [Phase 5B and later](delivery-roadmap.md).
