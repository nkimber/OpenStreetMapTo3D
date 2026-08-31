# OpenStreetMap data pipeline

Status: Active

Last updated: 2026-08-30

## Purpose

The data pipeline converts a user-selected geographic boundary into a stable,
validated source snapshot and normalized feature collection suitable for world
generation. It must preserve provenance and must not make the application depend
directly on any single public endpoint.

## Provider interfaces

```ts
interface GeocoderProvider {
  search(query: string, signal: AbortSignal): Promise<GeocodeResult[]>;
}

interface OsmDataProvider {
  fetchBounds(bounds: Wgs84Bounds, signal: AbortSignal): Promise<RawSnapshot>;
}

interface ElevationProvider {
  readonly id: "fixture" | "usgs-3dep" | "flat-fallback";
  fetch(bounds: Wgs84Bounds): Promise<ElevationSnapshot>;
}
```

Initial adapters:

- `NominatimGeocoder`: explicit, rate-limited searches
- `OverpassOsmDataProvider`: neighborhood-sized bounding-box queries
- `FixtureOsmDataProvider`: deterministic local development and tests
- `Usgs3depElevationProvider`: batched bilinear samples from the USGS 3DEP
  ImageServer
- Synthetic fixture elevation: deterministic slope and localized hill

Future adapters:

- Regional `.osm.pbf` files
- Self-hosted Nominatim and PostGIS
- Managed OSM data providers
- Global or self-hosted DEM services implementing the same snapshot contract

## Elevation extraction

OSM and elevation are fetched concurrently for the selected bounds. The USGS
adapter calculates a target grid near 10 m spacing, caps each axis at 129
samples, and batches ArcGIS multipoint requests below the service sample limit.
The resulting absolute metre values and vertical datum are stored, not queried
again during a world build.

If more than 25% of a live grid is missing, or the provider is unavailable, the
import retains its OSM features and stores a diagnosed flat fallback. This is a
recovery path, not synthetic elevation. The offline fixture instead supplies a
known deterministic hill so elevation generation and driving remain testable
without network access.

## Geocoding

The API must:

- Search only after explicit user submission.
- Avoid autocomplete against the public Nominatim endpoint.
- Identify the application with the required headers.
- Enforce at most one request per second for the public service.
- Cache successful results.
- Keep the endpoint configurable.
- Permit latitude/longitude input without geocoding.

Current public-service requirements are documented in the
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).

## OSM extraction

Use an Overpass bounding-box query rather than the main OSM editing API. The
query should include only features required by the active generator version.

Initial feature families:

- `highway=*` ways and relevant nodes
- `building=*` and `building:part=*` ways and relations
- `landuse=*`, selected `natural=*`, and leisure areas
- Parking areas, barriers, waterways, and railways needed for context

The API enforces:

- Valid longitude and latitude ranges
- A configurable maximum area
- Maximum response bytes
- External request and parsing timeouts
- Concurrency limits
- Cancellation when the user abandons an import

The raw request body, endpoint identity, retrieval time, query, response hash,
elevation grid/hash, and required attributions become the immutable source
snapshot.

## Normalization stages

1. Parse OSM nodes, ways, and relations.
2. Assemble multipolygons and holes.
3. Convert elements to GeoJSON features.
4. Assign stable source IDs such as `osm:way:1234`.
5. Classify features into roads, buildings, land, water, barriers, or ignored.
6. Preserve original tags as JSON.
7. Insert WGS84 geometry into PostGIS.
8. Run validity checks and repair safe polygon defects.
9. Clip features to the selected project boundary where appropriate.
10. Produce diagnostics and a normalized `WorldDefinition`.

Unsafe repairs must not silently change topology. Features that remain invalid
are skipped with a diagnostic containing their source ID.

## Normalized feature contract

```ts
interface NormalizedFeature {
  sourceId: string;
  sourceType: "node" | "way" | "relation";
  sourceVersion?: number;
  kind: "road" | "building" | "land" | "water" | "barrier";
  geometry: GeoJSON.Geometry;
  tags: Record<string, string>;
  facts: Record<string, string | number | boolean>;
  warnings: Diagnostic[];
}
```

`facts` contains interpreted source values, while generation assumptions belong
in generation output. This prevents an estimated building height from being
mistaken for OSM-provided data.

## Caching and reproducibility

Raw snapshots are compressed and stored by content hash in the snapshot volume.
Database records point to the content hash rather than duplicating payloads.

An import cache key includes:

- Provider identity
- Normalized bounding box
- Query/schema version
- Relevant provider options

The user may explicitly refresh a snapshot. Refreshing creates a new snapshot;
it does not overwrite the previous one.

## Updating a saved world

An OSM refresh follows this sequence:

1. Fetch a new immutable snapshot.
2. Normalize using the current schema version.
3. Compare stable source IDs and geometry hashes.
4. Report added, changed, and removed features.
5. Attempt to reapply compatible user overrides.
6. Ask the user to resolve overrides whose targets disappeared or changed type.
7. Generate a new world build while retaining the previous build.

## Failure handling

- Provider timeouts are retryable with bounded backoff.
- Rate-limit responses expose a user-friendly retry time.
- Oversized responses ask the user to reduce the selected boundary.
- Partial or invalid source data generates warnings where a usable world remains.
- Cached snapshots remain usable during provider outages.
- Every failure is associated with a stable diagnostic code for support and tests.
