# Testing strategy

Status: Draft

Last updated: 2026-08-30

## Objectives

Testing must protect geographic correctness, deterministic generation, stable
vehicle behavior, API compatibility, and the primary user workflow. Tests must
not make CI availability depend on public geocoding or Overpass services.

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
- Road graph splitting and intersection classification
- Polygon orientation, holes, and triangulation
- Override application and migration
- Fixed-timestep accumulation
- Vehicle input mapping and reset-state selection

### Geometry fixture tests

Each fixture contains source data, expected diagnostics, and invariant checks
rather than fragile full-buffer snapshots.

Required fixtures:

- Simple four-way intersection
- Curved residential road
- Cul-de-sac and driveway
- Building polygon with a courtyard
- OSM multipolygon relation
- Missing building heights
- Invalid self-intersecting polygon
- Bridge over road or water
- Tunnel and layer relationship
- Boundary-crossing feature
- Dense suburban neighborhood

Generated mesh snapshots may be used for focused regression tests but should be
versioned deliberately when algorithms change.

### API integration tests

- Run against an isolated PostGIS test database.
- Use recorded provider responses.
- Verify limits, timeouts, cache hits, idempotency, and attribution.
- Verify failed imports do not create complete snapshots.
- Verify source snapshots are immutable.
- Verify migrations from every supported schema baseline.

### Browser and end-to-end tests

Playwright covers:

1. Open the sample neighborhood.
2. Select or accept the default boundary.
3. Generate the world.
4. Inspect a road and building.
5. Place the vehicle.
6. Enter Drive mode and apply input.
7. Reset the vehicle.
8. Save, reload, and compare project state.
9. Confirm attribution remains available.

The sample workflow must run without network access.

### Physics replay tests

Record a fixed sequence of inputs and assert bounded outcomes at checkpoints:

- Vehicle remains upright on a straight road.
- Braking reduces velocity within an expected range.
- Steering changes heading in the expected direction.
- Reset produces the saved stable transform.
- Repeating the same input produces equivalent results for the same Rapier and
  project versions.

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
- Inspect estimated versus source-provided heights.
- Resize the browser during generation and driving.
- Cancel and retry imports and generation.
- Simulate unavailable providers and database restarts.
- Use keyboard-only navigation through the setup flow.
- Verify attribution at common viewport sizes.
