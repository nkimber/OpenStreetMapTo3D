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

- Ground mesh
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
2. Create continuous two-sided strips with stable miter joins.
3. Group equal graph nodes per vertical layer.
4. Generate deterministic intersection and round end-cap discs.
5. Triangulate visible surfaces and retain centerlines for exact spawn snapping.
6. Assign roads and junction dependencies to chunks in stable order.

The visible road and the physics surface are separate concerns. The MVP may use
a continuous flat ground collider with roads rendered slightly above it. Later,
road-specific colliders and friction values can follow elevation and surface
types.

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

Building collision should use simplified fixed geometry. Dense visual details
must not create unnecessarily complex collision meshes.

## Ground, land use, and water

MVP ground is a flat plane covering the selected boundary with a safety margin.
Land-use polygons apply procedural colors or materials above that plane. Water
is decorative until terrain and bridge clearance are supported.

Future terrain support will:

- Retrieve elevation through a provider adapter.
- Construct a heightfield visual mesh and Rapier collider.
- Conform roads to a smoothed terrain profile.
- Preserve bridge and tunnel separation.
- Record the elevation source and license alongside OSM attribution.

## Web Worker boundary

Geometry preparation runs in a module Web Worker. Messages use versioned
contracts from `packages/contracts`.

Worker input:

- Normalized features
- Local-world anchor
- Generation settings
- User overrides
- Generator version and deterministic seed

Worker output is a structured-cloneable `WorldPlan` containing road surface
positions and indices, junctions, building/land plans, authoritative chunks,
feature-to-chunk dependencies, the deterministic build hash, diagnostics, and
statistics. The main thread converts that plan into Three.js buffers and Rapier
objects. A future binary/transferable representation can reduce structured-copy
cost for larger areas without changing the versioned message contract.

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

Reset behavior records recent upright, in-bounds transforms on valid ground.
Pressing `R` or **Reset car** restores the latest safe transform; `Shift+R` or
**Return to spawn** restores the configured road spawn. Both clear velocity.
Sustained unsafe poses are recovered automatically after 2.5 seconds, and a
fall below -8 m recovers immediately.

Forward engine force tapers toward 90 km/h and reverse force toward 32 km/h.
The UI supports keyboard controls, the browser standard-gamepad layout, and a
0.5–1.5 steering-sensitivity range.

## Performance targets and telemetry

The default world is 1 km by 1 km and the recommended maximum is 2 km by 2 km.
Drive mode targets 60 frames per second, routine main-thread work stays below
50 ms, generation is cancelable, and a single-feature edit rebuilds only its
affected chunks. The running editor exposes frame rate, road triangles, Worker
duration, long frames, recovery count, last rebuilt chunks, diagnostics, and
build hash.

See the measured baseline and explicit gates in
[performance-budget.md](performance-budget.md).
