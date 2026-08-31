# API and persistence

Status: Draft

Last updated: 2026-08-30

## API principles

- HTTP JSON endpoints with versioned Zod contracts
- OpenAPI generated from the same validation schemas
- Server-sent events for import and build progress
- Stable machine-readable error codes
- Idempotency for operations that create source snapshots or projects
- No arbitrary provider URLs supplied by clients
- Pagination and explicit response-size limits for feature collections

The initial API prefix is `/api`. A public deployment may introduce `/api/v1`
before compatibility must be maintained for external clients.

## Implemented endpoints

```text
GET    /api/health
GET    /api/ready
POST   /api/geocode
POST   /api/imports
GET    /api/imports/:importId
GET    /api/imports/:importId/events
GET    /api/snapshots/:snapshotId/preview
POST   /api/worlds
GET    /api/worlds
GET    /api/worlds/:worldId/definition
PUT    /api/worlds/:worldId/overrides
```

Planned build-management endpoints are:

```text
GET    /api/worlds/:worldId
PATCH  /api/worlds/:worldId
POST   /api/worlds/:worldId/builds
GET    /api/worlds/:worldId/builds/:buildId
```

Destructive endpoints such as project deletion are deferred until recovery and
confirmation behavior is designed.

## Example import request

```json
{
  "provider": "overpass",
  "bounds": {
    "west": -75.2,
    "south": 39.94,
    "east": -75.185,
    "north": 39.952
  },
  "queryVersion": 1
}
```

Successful creation returns `202 Accepted` with an import job ID. Import status
is durable in PostgreSQL. The API process may execute jobs in-process initially;
the job-runner interface must permit a separate worker later.

## Progress events

Server-sent event types:

- `status`
- `progress`
- `diagnostic`
- `complete`
- `failed`

Events include a monotonically increasing sequence number. Reconnecting clients
can provide the last event ID and retrieve subsequent durable status.

## Core database entities

### `world_projects`

- UUID primary key
- Name
- WGS84 boundary polygon
- WGS84 anchor coordinate
- Generation settings JSON
- Current source snapshot and build IDs
- Created and updated timestamps

### `source_snapshots`

- UUID primary key
- Provider and query version
- Normalized query parameters
- Retrieval timestamp
- SHA-256 content hash
- Compressed-cache location
- Attribution text and license URL
- Raw and normalized schema versions

Source snapshots are immutable.

### `osm_features`

- Source snapshot ID
- Stable OSM source identity
- Feature kind
- WGS84 PostGIS geometry
- Original tags JSON
- Interpreted facts JSON
- Geometry hash
- Diagnostics JSON

A spatial index supports project clipping and diagnostics.

### `world_overrides`

- UUID primary key
- World project ID
- Stable target source ID or generated object ID
- Operation type
- Versioned patch payload
- Created and updated timestamps

Examples include changing height, changing road width, hiding a feature, and
placing the vehicle spawn.

### `world_builds`

- UUID primary key
- World project and source snapshot IDs
- Generator version
- Build-input hash
- Status and progress
- Statistics and diagnostics
- Optional generated-artifact cache key
- Start and finish timestamps

### `jobs`

- UUID primary key
- Job type and status
- Validated input JSON
- Progress and current stage
- Attempt count and retry time
- Stable error code and safe error details
- Created, started, and completed timestamps

## World definition DTO

The browser receives a versioned `WorldDefinition`, not database rows:

```ts
interface WorldDefinition {
  schemaVersion: number;
  worldId: string;
  sourceSnapshotId: string;
  bounds: Wgs84Bounds;
  anchor: Wgs84Position;
  attribution: Attribution[];
  features: NormalizedFeature[];
  settings: GenerationSettings;
  overrides: WorldOverride[];
  diagnostics: Diagnostic[];
}
```

Large definitions may later use streamed chunks or FlatGeobuf. Gzipped JSON or
GeoJSON is sufficient for the bounded MVP area.

## Migration and compatibility policy

- Database changes use ordered, immutable migrations.
- DTOs carry explicit schema versions.
- Generator versions are recorded in builds.
- Overrides have versioned payloads and migration functions.
- Cached meshes may be deleted whenever their producing version is unsupported.
- Source snapshots and user overrides must not depend on a generated cache.
