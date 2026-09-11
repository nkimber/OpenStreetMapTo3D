# Implementation status

Status: Active

Last updated: 2026-09-10

## Working vertical slice

The repository contains a runnable, editable neighborhood-driving application.
`docker compose up --build` starts PostGIS, the Fastify API, and the Vite web
application. The primary workflow is covered in Chromium from offline import
through generation, editing, driving, and reopening the persisted result.

Implemented capabilities:

- Garage with three locally bundled CC0 cars, body paint, persistent device
  preferences, animated wheels and vehicle lighting; safe modal pause and
  load-failure fallback
- Footprint-preserving procedural roofs, wall/shingle patterns and nearby-only
  windows/doors, with supported OSM appearance tags and explicit estimation labels
  (see [graphics details and limits](graphics-and-garage.md))
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
  grade-smoothed 3D road profiles, shared junction plateaus, physical shoulders,
  and extruded building meshes based at median footprint elevation
- Deterministic 256 m terrain chunks with shared edges and a 4 m base grid;
  road-boundary clipping, matching Three.js/Rapier triangle meshes near roads,
  heightfields elsewhere, land-use vertex colors, and elevation-aware hashes
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
- StreetRove branding while retaining existing package identifiers, storage
  keys and development database volumes
- Offline drive minimap built from imported features, with collapse/expand
  controls and a vehicle marker
- Prepared password-protected pilot deployment with a separate import worker,
  restart recovery, atomic cache writes and backup/packaging scripts

## Verification snapshot

The September terrain increment adds fourteen geometry, hashing, runtime and vehicle
regressions, plus a browser regression for road widening, hiding, undo and driving
after terrain replacement. See [ADR-0006](decisions/0006-road-boundary-terrain-and-collision.md)
for the implementation, coverage and known limitations. The earlier 250 ms
fixture-generation budget is currently unmet. The expected gates are:

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

### Repository checkpoint: 2026-09-10

Validated the complete StreetRove working tree before check-in:

- Formatting, full-repository lint, type checking, and API/web production builds
- 68 unit/integration tests across 19 files
- All three Chromium workflows, run serially against the local Docker stack:
  minimap controls, sample editing/driving/reopening, and terrain edit/undo
- Production Docker image build and both Compose configuration checks
- Deployment shell syntax and source-archive exclusions for secrets/local data

This checkpoint does not deploy to Azure or another host. The separate production
worker's crash recovery, VPS authentication/TLS, and backup restoration still
require deployment acceptance checks; unit tests and image builds do not prove
those operational scenarios.

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
  driving cameras, traffic, and pedestrians are not implemented.
- Public provider availability and OSM feature coverage vary; the fixture is
  the reproducible fallback.

The remaining limitations align with [Phase 5B and later](delivery-roadmap.md).
