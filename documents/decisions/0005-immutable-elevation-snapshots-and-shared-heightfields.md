# ADR-0005: Immutable elevation snapshots and shared heightfields

Status: Accepted

Date: 2026-08-31

## Context

Roads, buildings, rendering, and vehicle physics previously assumed `Y = 0`.
Adding terrain is not only a visual change: the same sampled surface must drive
road profiles, building bases, vehicle spawn, collision, attribution, and the
deterministic build identity. Live elevation services can also change after a
project is saved.

## Decision

- The API retrieves elevation during the map import and stores the complete DEM
  grid as part of the immutable source snapshot.
- The initial live provider is the public-domain USGS 3DEP ImageServer. The
  bundled fixture uses a deterministic synthetic slope. Missing live coverage
  produces a diagnosed flat fallback without discarding usable OSM data.
- DEM rows run south to north and columns west to east. Heights are absolute
  metres in the recorded vertical datum. Metadata includes bounds, grid size,
  spacing, min/max values, provider, dataset, attribution, and SHA-256 hash.
- World generation subtracts the DEM height at the local anchor. The resulting
  `Y` values are local relative heights; the absolute reference remains in the
  terrain plan.
- Terrain uses the same deterministic 256 m chunk lattice as other generated
  content. Adjacent chunks sample the same boundary coordinates. The default
  grid has 32 cells per chunk (8 m spacing); roads are densified to at most 4 m.
- One structured-cloneable terrain plan creates both the Three.js mesh and the
  Rapier heightfield. Rapier's required x-major height order is explicit and
  covered by a collider ray-cast test.
- Ground roads are grade-smoothed, have level cross-sections and blended visual
  shoulders, and use their rendered triangle strip as the drivable collider.
  Buildings remain vertical and start at the median footprint elevation.
- Bridges use separate raised deck geometry and colliders. Because a heightfield
  cannot represent an overhang, tunnels are represented as diagnosed open cuts
  until a mesh/voxel terrain implementation is introduced.
- The elevation content hash participates in the deterministic world build
  hash. Elevation attribution is displayed beside OSM attribution.

## Consequences

Saved worlds remain reproducible if upstream DEM data changes. Rendering and
physics cannot silently use different terrain samples. The worker payload and
browser memory are larger, so terrain density has an explicit performance
budget. USGS coverage is primarily United States data; the current global
fallback is flat and diagnosed rather than fabricated. True tunnel overhangs
remain future work.
