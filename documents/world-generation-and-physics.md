# World generation and physics

Status: Draft

Last updated: 2026-08-30

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

The local world is divided into square chunks. The proposed starting size is
256 metres, subject to profiling.

Each chunk may contain:

- Ground mesh
- Road surface mesh
- Building mesh or instanced objects
- Decorative land and water meshes
- Simplified static colliders
- Feature-ID lookup tables for selection

Chunks allow frustum culling, bounded rebuilds after edits, and future streaming.
A feature crossing a boundary must have one authoritative owner or deterministic
fragments so that it is not rendered twice.

## Roads

Road generation consumes both the OSM centerline graph and interpreted width.

Width precedence:

1. Explicit `width`
2. Lane count multiplied by the configured lane width
3. Highway-class default

Generation stages:

1. Split centerlines at graph intersections.
2. Resolve bridges, tunnels, and vertical layer relationships.
3. Create buffered surface polygons with stable joins and end caps.
4. Generate intersection polygons.
5. Triangulate visible surfaces.
6. Retain the centerline graph for spawn snapping and the minimap.

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

Worker output:

- Transferable vertex, normal, UV, and index buffers
- Material groups
- Feature-selection ranges
- Simplified collider descriptions
- Diagnostics and statistics

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

Reset behavior records recent stable vehicle transforms on valid road or ground.
Pressing reset restores the latest safe transform, clears unsafe velocity, and
keeps the current camera mode.

## Proposed performance targets

- Default world: 1 km by 1 km
- Recommended maximum: 2 km by 2 km
- Drive-mode target: 60 frames per second on documented reference hardware
- No routine interactive main-thread task longer than 50 milliseconds
- Geometry generation must be cancelable
- Rebuilding one edited chunk must not rebuild the entire world

Reference hardware and concrete geometry budgets will be recorded after the
first performance fixture exists.
