# Testing strategy

Status: Active

Last updated: 2026-08-31

## Objectives

Testing must protect geographic correctness, deterministic generation, stable
vehicle behavior, API compatibility, and the primary user workflow. Tests must
not make CI availability depend on public geocoding, Overpass, or elevation
services.

## Test layers

### Static checks

- TypeScript strict mode
- ESLint with project rules
- Formatting verification
- Dependency and license inventory
- Database migration validation

### Unit tests

High-value units include:

- WGS84 to local ENU conversion and inverse conversion
- Longitude behavior around the antimeridian
- OSM height, level, lane, and width interpretation
- Stable source IDs and build hashes
- Elevation grid contract validation, bilinear sampling, and snapshot hashing
- Road graph splitting and intersection classification
- Polygon orientation, holes, and triangulation
- Override application and migration
- Fixed-timestep accumulation
- Vehicle input mapping and reset-state selection

### Geometry fixture tests

Each fixture contains source data, expected diagnostics, and invariant checks
rather than fragile full-buffer snapshots.

Implemented representative fixtures:

- Simple four-way intersection and dense building block
- Curved residential road
- T-junction and cul-de-sac
- Ground road, bridge, and tunnel sharing coordinates on separate layers
- Sloped DEM with seam-identical chunks, uphill road profiles, median building
  bases, and elevation-aware spawn

Additional normalization fixtures cover:

- Building polygon with a courtyard
- OSM multipolygon relation
- Missing building heights
- Invalid self-intersecting polygon

Generated mesh snapshots may be used for focused regression tests but should be
versioned deliberately when algorithms change.

### API integration tests

- Run against an isolated PostGIS test database.
- Use recorded provider responses.
- Verify limits, timeouts, cache hits, idempotency, and attribution.
- Verify failed imports do not create complete snapshots.
- Verify source snapshots are immutable.
- Verify USGS multipoint batching with recorded responses and fixture/fallback
  behavior without contacting the public service.
- Verify migrations from every supported schema baseline.

### Browser and end-to-end tests

The offline Playwright workflow covers:

1. Open the sample neighborhood.
2. Select or accept the default boundary.
3. Generate the world.
4. Inspect a building and verify generated-value provenance.
5. Apply a height override and verify exactly one chunk rebuilds.
6. Verify build-hash changes, undo, redo, hide, and restore.
7. Enter Drive mode, apply input, and verify the configured speed budget.
8. Use safe reset and original-spawn return.
9. Reopen the saved world and verify the override remains authoritative.
10. Confirm attribution remains available.
11. Confirm elevation provider, relief, terrain triangles, and elevation
    attribution are present.

The sample workflow must run without network access.

### Physics replay tests

The Rapier replay runs a fixed 60 Hz input sequence and asserts bounded outcomes:

- The vehicle remains upright on continuous ground while crossing the origin
  chunk seam.
- The 90 km/h force taper stays under the allowed tolerance.
- Braking reduces velocity by the documented amount.
- Repeating the sequence produces equivalent position and speed checkpoints for
  the same Rapier and project versions.
- Ray casts against the x-major Rapier heightfield match the same terrain plan
  sampled by rendering.

Pure simulation tests separately cover safe-pose classification, recovery
timeouts, input smoothing, speed-force tapering, and standard-gamepad mapping.

Exact cross-version floating-point equality is not required; tolerances must be
documented.

## Performance tests

Maintain representative worlds for:

- Small synthetic block
- Default 1 km suburban area
- Dense building area near the maximum supported boundary

Track:

- Source normalization time
- World-generation time
- Main-thread long tasks
- Vertex and triangle counts
- Collider counts
- Browser memory after generation
- Median and low-percentile frame times in Drive mode

Performance failures should report which chunks or feature classes dominate the
budget.

Current budgets and the reference-machine baseline are recorded in
[performance-budget.md](performance-budget.md).

## Continuous integration gates

A pull request must pass:

- Lint and formatting
- Typecheck
- Unit and geometry tests
- API integration tests
- Production build
- Sample-world browser smoke test
- Migration validation

Longer performance and full browser suites may run on the default branch or on
demand until execution time is acceptable for every pull request.

## Manual exploratory checklist

- Compare the 2D preview and generated road topology.
- Drive across intersections and chunk boundaries.
- Drive uphill/downhill and across a terrain-chunk seam; verify no visible or
  collision step at the shared edge.
- Inspect estimated versus source-provided heights.
- Resize the browser during generation and driving.
- Cancel and retry imports and generation.
- Simulate unavailable providers and database restarts.
- Use keyboard-only navigation through the setup flow.
- Verify attribution at common viewport sizes.
