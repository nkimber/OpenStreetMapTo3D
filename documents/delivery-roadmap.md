# Delivery roadmap

Status: Active

Last updated: 2026-08-31

The roadmap is organized around demonstrable vertical slices. A phase is
complete only when its exit criteria pass in Docker and its supporting tests and
documentation are present.

Current status: Phases 0 through 4 and the Phase 5A terrain foundation are
implemented and verified as a complete editable, driveable vertical slice.
Phase 5B and Phase 6 remain future work. See
[implementation status](implementation-status.md) for verified details.

## Phase 0: Repository and container foundation

Status: Complete

Deliverables:

- pnpm TypeScript workspace
- React/Vite web application
- Fastify API
- PostgreSQL/PostGIS migrations
- Docker Compose development environment
- Shared contract package
- Lint, typecheck, unit-test, and production-build commands
- CI workflow

Exit criteria:

- `docker compose up --build` starts healthy web, API, and database services.
- A browser can load the application and read API readiness.
- Tests run without host Node.js or PostgreSQL installations.

## Phase 1: Location and OSM preview

Status: Complete

Deliverables:

- Explicit geocoding search and coordinate entry
- Area-selection UI
- Provider adapters and rate limiting
- Overpass import with immutable source snapshots
- OSM normalization into PostGIS
- 2D roads/buildings preview
- Recorded sample fixture

Exit criteria:

- A user can select a bounded area and see feature counts and diagnostics.
- Repeating an import uses the cache where policy permits.
- The sample fixture works offline.

## Phase 2: Deterministic 3D world

Status: Complete

Deliverables:

- Local ENU coordinate conversion
- Browser world-generation worker
- Deterministic 256 m chunk plan with continuous flat ground
- Road surfaces and intersection handling
- Extruded buildings with height provenance
- Inspect camera and object selection

Exit criteria:

- The sample neighborhood is recognizable in 3D.
- Repeating a build produces the same build hash and equivalent geometry.
- Invalid individual features yield diagnostics rather than crashing the build.

## Phase 3: Drive mode

Status: Complete

Deliverables:

- Rapier fixed-timestep world
- Ray-cast vehicle controller
- Road-aligned spawn placement
- Keyboard input, chase camera, and reset
- Simplified building and ground collision
- Physics replay tests

Exit criteria:

- The vehicle can cross representative intersections and chunk boundaries.
- Reset recovers from overturned or out-of-bounds states.
- The driving fixture meets the first published performance target.

## Phase 4: Editing and persistence

Status: Complete

Deliverables:

- Saved projects and recent-world list
- Building-height, road-width, visibility, and spawn overrides
- Undo and redo
- Partial chunk rebuilds
- Save/reopen end-to-end coverage

Exit criteria:

- Manual changes survive reload and deterministic regeneration.
- Original source snapshots remain unchanged.
- A changed chunk can rebuild without rebuilding the whole world.

## Phase 5A: Terrain foundation

Status: Complete

Deliverables:

- Elevation-provider interface
- Heightfield terrain and collision
- Road conformance and smoothing
- Improved roofs, land use, vegetation, and materials
- Additional attribution support

Exit criteria:

- Roads remain driveable on representative sloped terrain.
- Bridge and tunnel diagnostics prevent obviously incorrect surface merging.
- Elevation source and license appear in project and export attribution.

Implemented details include USGS 3DEP and fixture providers, immutable DEM
snapshots, 8 m shared-edge terrain chunks, 4 m road profile sampling, matching
Three.js/Rapier surfaces, median building bases, bridge decks, tunnel open-cut
diagnostics, elevation-aware spawn, and deterministic tests.

## Phase 5B: Visual quality

Status: Planned

Deliverables:

- True tunnel-capable mesh or voxel terrain
- Explicit bridge/tunnel height and endpoint interpretation
- Improved roofs, level water, vegetation, materials, and road markings
- Global or self-hosted elevation provider
- Terrain level of detail and binary Worker transfer

Exit criteria:

- Representative bridges and closed tunnels match their tagged clearances.
- A 2 km terrain world remains within the published browser budget.
- Visual layers retain correct source and asset attribution.

## Phase 6: Distribution and contribution readiness

Status: Planned

Deliverables:

- Production application image
- Backup, restore, and upgrade documentation
- Contribution guide and code of conduct
- Versioned project/export format
- Release notes and dependency license report

Exit criteria:

- A clean machine can run a published release using Docker Desktop.
- Existing projects migrate or fail with an actionable compatibility message.
- Contributors can reproduce CI locally.

## Deferred opportunities

- Local regional `.osm.pbf` imports and fully offline operation
- Imagery and user-owned texture overlays
- Traffic and pedestrians
- Multiple vehicles and replays
- Multiplayer sessions
- Native desktop packaging
- 3D Tiles import and export
- Community world presets and procedural styles
