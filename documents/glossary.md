# Glossary

Status: Draft

Last updated: 2026-08-30

## Build

A versioned generation result produced from a source snapshot, settings,
overrides, and generator version. Generated buffers may be cached, but the build
recipe is authoritative.

## Chunk

A bounded square region of the local world generated and rendered as a unit.
Chunks support culling, incremental rebuilds, and future streaming.

## Diagnostic

A structured information, warning, or error record with a stable code, safe
message, optional source feature, and severity.

## ENU

East-North-Up, a local tangent coordinate frame measured in metres relative to a
geographic anchor.

## Feature

A normalized geographic object such as a road, building, land polygon, water
polygon, or barrier. A feature retains its source identity and original tags.

## Generation assumption

A value introduced by the application when source data is incomplete, such as a
default building height or road width. Assumptions are not source facts.

## Local world

The metre-based coordinate system used by Three.js and Rapier for one project.
It is derived from WGS84 geometry using the project's geographic anchor.

## ODbL

The Open Data Commons Open Database License under which OpenStreetMap makes its
database available.

## OSM

OpenStreetMap, both the collaborative geographic database and the community that
maintains it.

## Override

A user-authored change layered over an immutable source snapshot, such as a
changed building height, road width, visibility state, or vehicle spawn.

## Provider adapter

A server-side implementation that obtains geocoding, OSM, elevation, imagery,
or other data through a stable project-owned interface.

## Source fact

A normalized value directly supported by the source data, including its
provenance. It is distinct from a generation assumption.

## Source snapshot

An immutable record of a provider response, query, retrieval time, content hash,
license, and attribution. Refreshing creates a new snapshot.

## WGS84

The longitude/latitude reference system used for persistent source geometry.
PostGIS stores source geometry as EPSG:4326.

## World definition

The versioned data transfer object sent to the browser containing the geographic
anchor, normalized features, generation settings, overrides, diagnostics, and
attribution required to generate a world.
