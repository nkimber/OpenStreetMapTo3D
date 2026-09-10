# ADR-0006: Terrain ends at road boundaries

Status: Accepted

Date: 2026-09-10

## Problem

Heightfield grading alone did not guarantee road clearance. Overlapping blend
corridors could raise ground above a neighboring road. Large land-use triangles
could span a road cutting. Bilinear height queries differed from the rendered
triangle planes, and editing roads left permanent terrain meshes and colliders
at their previous heights.

## Decision

Generator 0.5.0 uses the final pavement triangles as a geometric constraint.

1. Sample the immutable DEM and smooth road profiles. Insert shared nodes at
   same-level ground crossings where source geometry lacks them; never infer
   connections to bridges, tunnels or nonzero layers. Resolve connected junction
   heights together, flatten their footprints, and ease the approaches over
   distance along each road. Closely spaced junction plateaus share a height.
2. Grade the surrounding ground. Full-strength road constraints take precedence
   over neighboring blend corridors.
3. Subtract the union of non-bridge road and junction triangles from intersecting
   terrain grid triangles. Keep and triangulate the outside pieces rather than
   deleting whole grid cells. New pavement-boundary vertices meet road height.
4. Use shared edge profiles for clipped grid edges and chunk boundaries. Weld
   coincident vertices. Terrain beside pavement is the physical shoulder and
   embankment; the old decorative shoulder skirt is no longer generated.
5. Render and collide against the exact clipped mesh in affected chunks. Retain
   the regular heightfield in unaffected chunks. Query triangle planes using
   the same diagonal as rendering and Rapier; inside a road opening, return the
   replacement road surface height.
6. Paint land and water classifications onto terrain vertices, honoring polygon
   holes. No separate polygon can cover pavement. Water remains a terrain color,
   not a level or transparent water surface.
7. Hash terrain chunks in the Worker. Stage changed scene meshes and colliders,
   then replace them synchronously between simulation frames. Compare generated
   feature geometry as well as override targets to rebuild connected roads and
   buildings whose bases moved. Preserve unchanged terrain chunks.

Bridge decks retain underlying terrain. Tunnels remain open cuts; ceilings,
portals, and source-derived bridge clearances are separate future work. Legacy
flat worlds retain their floor and switch it out when terrain becomes available.

## Verification

The increment adds fourteen regression tests covering neighboring corridors,
diagonal bends and wide miters, pavement exclusion, conserved outside area,
chunk seams, nonplanar sampling, connected junction heights, width/visibility
edits and undo, bridge preservation, render/collider agreement, land colors,
terrain replacement without collider leaks, changed DEM heights, and an uphill
vehicle replay crossing a junction and a terrain seam.
Missing crossing nodes and compatibility of the optimized 64-bit hash are also
covered.

A Chromium regression also widens and hides a road, verifies terrain triangle
counts and deterministic hashes return on undo, and drives after replacement.

Geometry tests check samples throughout pavement triangles, including near road
edges. Runtime tests ray-cast both Three.js geometry and actual Rapier colliders.
The vehicle replay includes eight seconds of acceleration and two of braking.
These fixtures protect geometric correctness; they do not establish a frame-rate
budget for every real neighborhood or prove survey-grade road geometry.

## Costs and limitations

The sample has about 306,000 terrain triangles at the existing 4 m grid density.
Welded buffers and resolved crossings bring the serialized plan to roughly
7.6 MB before compression, versus 19.6 MB for the initial unwelded approach.
Road-boundary generation costs more than the former heightfield
grading pass, and the earlier 250 ms fixture generation budget is not met.
GPU uploads and collider creation still run on the main thread. Future work can
cache unchanged Worker terrain, stream typed buffers, and reduce distant detail.

Road profiles and junction plateaus are generated approximations. Very steep
terrain, conflicting source topology, and retaining walls between nearby roads
still need explicit engineering rules; roads above the diagnostic grade threshold
must be inspected. This decision guarantees pavement exclusion from generated
terrain by construction, not that every possible OSM input is a safe real road.
