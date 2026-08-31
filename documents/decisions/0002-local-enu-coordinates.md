# ADR-0002: Local ENU world coordinates

Status: Accepted

Date: 2026-08-30

## Context

OpenStreetMap geometry uses geographic longitude and latitude. Three.js and
Rapier work best with Cartesian coordinates close to the origin and consistent
metre units. Sending projected global coordinates directly into browser physics
would introduce large values, projection coupling, and avoidable precision
problems.

The MVP covers a neighborhood rather than a planet-scale scene.

## Decision

Persist source geometry in WGS84/EPSG:4326. For each project, choose a geographic
anchor near the center of its boundary and convert features to a local
East-North-Up frame in metres.

Map local axes into Three.js and Rapier as:

- East to `+X`
- Up to `+Y`
- North to `-Z`

Coordinate conversion belongs in a dedicated shared package and must provide
forward and inverse operations.

## Consequences

Positive:

- Physics and rendering operate near the origin.
- All simulation dimensions use metres.
- Persistent data remains interoperable with GIS tools.
- The local frame is independent of the visual renderer.

Negative:

- Every imported or exported position requires an explicit conversion.
- Worlds spanning large distances need origin shifting or a different approach.
- Axis mapping must be documented and tested to avoid mirrored geometry.

## Revisit when

- Supported worlds exceed the neighborhood-scale boundary.
- The product adds seamless travel between distant regions.
- A globe renderer becomes a primary runtime rather than an optional provider.
