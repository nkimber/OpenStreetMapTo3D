# World generation and physics

Status: Active

Last updated: 2026-08-31

## Coordinate model

Source geometry is stored as WGS84 longitude and latitude. Each world chooses an
anchor near the center of its boundary and converts source coordinates into a
local East-North-Up frame measured in metres.

Three.js and Rapier use:

- `+X`: east
- `+Y`: up
- `-Z`: north

Keeping local coordinates close to zero prevents visible jitter and unstable
physics. Conversion code belongs in `packages/geo` and must be covered by known
coordinate fixtures and round-trip tolerances.

## Build identity

A build key is derived from:

```text
source snapshot hash
+ elevation snapshot hash
+ normalized schema version
+ generation settings
+ ordered user overrides
+ world-generator version
```

Generation must not use unseeded randomness. A saved project can therefore
rebuild the same world even when generated mesh caches are removed.

## Chunking

The local world is divided into deterministic 256 metre square chunks.

Each chunk may contain:

- A 4 m visual/physics heightfield grid with boundary samples shared by its
  neighbors
- Road surface mesh
- Building mesh or instanced objects
- Decorative land and water meshes
- Simplified static colliders
- Feature-ID lookup tables for selection

Chunks allow frustum culling, bounded rebuilds after edits, and future streaming.
A feature crossing a boundary has one authoritative owner selected from its
centroid so that it is not rendered twice. Intersection dependencies can add a
source ID to other chunks; edit invalidation uses the union of the old and new
feature-to-chunk maps.

## Roads

Road generation consumes both the OSM centerline graph and interpreted width.

Width precedence:

1. Explicit `width`
2. Lane count multiplied by the configured lane width
3. Highway-class default

Implemented generation stages:

1. Deduplicate centerline points and classify layer, bridge, and tunnel state.
2. Densify centerlines to at most 4 m and bilinearly sample the immutable DEM.
3. Smooth longitudinal grades while keeping each cross-section level.
4. Apply bridge, tunnel, and OSM-layer separation with endpoint ramps.
5. Grade the shared terrain heightfield beneath ordinary roads and junctions.
   High terrain is cut with a cell-safety margin; low terrain is filled along
   the shoulder profile. Both return to the original DEM outside the corridor.
6. Create continuous two-sided strips with stable miter joins and blended
   ground-road shoulders.
7. Group equal graph nodes per vertical layer and create intersection/end-cap
   surfaces.
8. Diagnose grades above 20% and retain 3D centerlines for exact spawn snapping.
9. Use the road and junction triangle strips as fixed Rapier colliders.

Bridge decks are raised separate surfaces with matching colliders. A heightfield
cannot contain a hole or overhang, so a tunnel lowers nearby terrain into a
diagnosed open cut. A later mesh or voxel terrain backend is required for a
closed tunnel.

## Buildings

Height precedence:

1. Explicit `height`
2. `building:levels` multiplied by a configurable level height
3. Default selected by building type
4. Global fallback

The initial generator extrudes footprints with flat roofs. Later versions may
interpret `roof:shape`, `roof:height`, building parts, colors, and materials.

Every generated building retains:

- Stable source ID
- Original tags
- Selected height and its origin (`source`, `levels`, or `fallback`)
- Applied overrides
- Diagnostics
- Median terrain base height

Building collision should use simplified fixed geometry. Dense visual details
must not create unnecessarily complex collision meshes.

## Terrain, land use, and water

The DEM contract stores absolute metre heights in a recorded vertical datum.
Generation bilinearly samples that grid and subtracts the height at the world
anchor, producing local ENU-relative `Y` values. The absolute reference height
remains in `TerrainPlan` for inspection.

Terrain chunks align to the 256 m world lattice and include a 40 m safety
margin. The default 64 × 64 cells create a 4 m grid. Values are serialized in
Rapier-compatible x-major order; adjacent chunks sample the same coordinates at
their borders. Three.js triangulates these heights and Rapier consumes the same
array as a heightfield collider. Tests ray-cast the collider and compare it with
the visual plan sampler. Ground-road corridors and junction discs are graded in
this shared array, so hidden terrain cannot remain as a competing collider below
the road surface.

Land-use overlays are resampled onto the terrain. Buildings remain vertical and
start at the median height of their outer footprint. Water currently follows
terrain like other overlays; a level water-plane model is future work.

## Web Worker boundary

Geometry preparation runs in a module Web Worker. Messages use versioned
contracts from `packages/contracts`.

Worker input:

- Normalized features
- Immutable elevation snapshot and world bounds
- Local-world anchor
- Generation settings
- User overrides
- Generator version and deterministic seed

Worker output is a structured-cloneable `WorldPlan` containing road surface
positions and indices, junctions, building/land plans, authoritative chunks,
feature-to-chunk dependencies, the deterministic build hash, diagnostics, and
statistics. It also contains heightfield chunks, elevation metadata, 3D road
profiles, shoulder surfaces, and building base heights. The main thread converts
that one plan into both Three.js buffers and Rapier objects. A future
binary/transferable representation can reduce structured-copy cost for larger
areas without changing the versioned message contract.

The main thread owns Three.js objects, input handling, and the render loop.

## Physics loop

Rapier advances at a fixed 60 Hz timestep with an accumulator. Rendering may run
at a different rate and interpolates visible transforms.

The initial vehicle uses Rapier's dynamic ray-cast vehicle controller:

- One dynamic chassis rigid body
- Four visual wheels driven from controller state
- Ray-cast suspension rather than physical wheel bodies
- Tunable engine, brake, steering, suspension, and friction parameters
- Continuous collision detection where profiling shows it is necessary

Reset behavior records recent upright, in-bounds transforms relative to the
terrain below the car, so valid negative local elevations do not trigger false
recovery.
Pressing `R` or **Reset car** restores the latest safe transform; `Shift+R` or
**Return to spawn** restores the configured road spawn. Both clear velocity.
Sustained unsafe poses are recovered automatically after 2.5 seconds, and a
fall more than 8 m below the local terrain recovers immediately. Inspect mode
holds the service brake and handbrake so a parked car does not roll down a hill.

Forward engine force tapers toward 90 km/h and reverse force toward 32 km/h.
The UI supports keyboard controls, the browser standard-gamepad layout, and a
0.5–1.5 steering-sensitivity range.

## Performance targets and telemetry

The default world is 1 km by 1 km and the recommended maximum is 2 km by 2 km.
Drive mode targets 60 frames per second, routine main-thread work stays below
50 ms, generation is cancelable, and a single-feature edit rebuilds only its
affected chunks. The running editor exposes frame rate, road triangles, Worker
duration, terrain triangles/source/range, car elevation, long frames, recovery
count, last rebuilt chunks, diagnostics, and build hash.

See the measured baseline and explicit gates in
[performance-budget.md](performance-budget.md).
