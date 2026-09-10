# Product vision

Status: Active

Last updated: 2026-09-02

## Product statement

**StreetRove — Your neighborhood. Your world. Your drive.**

StreetRove turns an OpenStreetMap neighborhood extract into an editable,
interactive 3D world in which a user can place and drive a vehicle. The core
experience should require no GIS or 3D-modeling knowledge.

The shortest successful journey is:

> Find a place, select an area, generate a world, place a car, and drive.

## Problem

Open geographic data contains useful road networks, building footprints, land
use, and other features, but it is not immediately usable as a coherent 3D
driving environment. Users currently need to understand data extraction,
coordinate systems, geometry processing, rendering, and physics before they can
explore a familiar place in 3D.

The project packages those steps into one understandable workflow while keeping
the source code and generated-world process open and inspectable.

## Target users

- A hobbyist who wants to drive around a recognizable neighborhood.
- A developer learning geospatial rendering or browser physics.
- An educator demonstrating how open geographic data becomes a simulation.
- A contributor improving procedural roads, buildings, terrain, or vehicles.

## Product principles

1. **Default first.** A useful world must be generated without requiring users
   to configure road widths, building heights, or coordinate systems.
2. **Honest representation.** Estimated geometry must be distinguishable from
   source-provided facts in diagnostics and editing tools.
3. **Smooth driving over raw fidelity.** Physics uses simplified, stable
   collision surfaces rather than every visible geometric detail.
4. **Reproducible generation.** The same source snapshot, settings, overrides,
   and generator version must produce the same world.
5. **Open and replaceable.** External map, elevation, and geocoding providers
   must sit behind adapters rather than being embedded in application logic.
6. **Local by default.** Early versions target a single-user Docker Desktop
   installation with no account or cloud dependency beyond map-data requests.

## MVP scope

The MVP must allow a user to:

1. Search for a location or enter latitude and longitude.
2. Select a neighborhood-sized rectangular boundary.
3. Preview the available roads and buildings.
4. Import and store an OpenStreetMap source snapshot.
5. Capture an elevation snapshot and generate terrain, sloped road surfaces,
   and extruded buildings.
6. Place a vehicle on a selected road.
7. Drive using keyboard controls and reset the vehicle.
8. Save and reopen the generated project.
9. See required OpenStreetMap and elevation attribution.

## MVP non-goals

- Photorealistic reconstruction or façade textures
- Survey-grade geometry or elevation accuracy
- Real-time navigation or autonomous vehicle control
- Traffic, pedestrians, multiplayer, or networking
- Planet-scale streaming
- Self-hosting the full OpenStreetMap planet dataset
- Mobile-device optimization
- A general-purpose 3D editor

## Proposed success criteria

- A first-time user reaches Drive mode without reading documentation.
- A default 1 km by 1 km suburban fixture generates reliably.
- The generated road layout is recognizable relative to the OSM source.
- The car can traverse intersections without collider seams or unstable jumps.
- Saving and reopening produces an equivalent world.
- Automated tests run without contacting public OSM or elevation services.
- Attribution remains visible in the application and in exported metadata.

## Visual direction

The first visual style should be clean and semi-realistic rather than attempting
photorealism with incomplete data. Procedural colors and materials should make
source limitations feel intentional while leaving room for optional imagery and
more detailed assets later.
