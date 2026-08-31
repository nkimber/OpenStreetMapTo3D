# Security, privacy, and licensing

Status: Draft

Last updated: 2026-08-30

## Operating model

The first release is a single-user local application exposed on localhost. That
reduces but does not eliminate risk: the API still processes user input, calls
external services, parses untrusted geographic data, and stores precise location
projects.

Public deployment requires authentication, authorization, tenant isolation, and
additional abuse controls that are outside the initial release.

## Location privacy

- Tell users when a text search is sent to a configured geocoder.
- Offer direct latitude/longitude entry and bundled offline fixtures.
- Do not add telemetry by default.
- Do not include precise project locations in logs unless explicitly enabled for
  debugging.
- Treat saved project boundaries and names as potentially sensitive.
- Keep database and snapshot volumes local by default.
- Document what must be backed up and how to delete local data safely.

## External-request controls

- Clients select a provider by a known identifier, never by supplying a URL.
- Provider base URLs come from trusted server configuration.
- Reject unsupported protocols and redirects to private network addresses.
- Enforce bounding-box, response-size, duration, and concurrency limits.
- Identify the application as required by provider policies.
- Cache allowed responses to avoid repeated public-service load.
- Redact headers and configuration values from structured logs.

These controls reduce SSRF, denial-of-service, accidental provider abuse, and
secret exposure.

## API and database controls

- Validate every request and response with shared schemas.
- Use parameterized database operations.
- Apply explicit CORS origins.
- Set body-size and request-duration limits.
- Use safe error responses without stack traces in production.
- Run containers as non-root users.
- Expose PostGIS only within the Compose network by default.
- Keep destructive project operations recoverable or explicitly confirmed.

## Browser controls

- Use a restrictive Content Security Policy compatible with Web Workers and
  WebAssembly.
- Do not inject OSM tags as HTML.
- Treat names, addresses, and other OSM tag values as untrusted text.
- Validate worker messages at the boundary.
- Avoid loading arbitrary model or texture URLs supplied by project data.
- Cap geometry allocation before creating browser buffers.

## Secrets

The MVP should require no paid map API keys. Database credentials and future
provider tokens belong in local environment files or a deployment secret store.

- `.env` files remain ignored.
- `.env.example` contains placeholders only.
- Images must not contain secrets.
- CI credentials use repository secret storage.
- Logs, diagnostics, and exported projects must not contain credentials.

## Application source license

The repository uses the MIT License. Each new dependency must have a license
compatible with distribution under the project's intended model. Dependency
license reports should be generated in CI before releases.

## OpenStreetMap data license

OpenStreetMap data is available under the Open Data Commons Open Database
License (ODbL). The application must:

- Display `© OpenStreetMap contributors` in map and 3D views.
- Link to the OSM copyright and license information.
- Preserve attribution in exported metadata.
- Keep code licensing separate from database/data licensing.
- Review share-alike obligations before distributing an altered or derived
  database.

Authoritative information is available at
[OpenStreetMap Copyright and License](https://www.openstreetmap.org/copyright).

## Public-service policies

Using open data does not grant unlimited use of community-operated servers.
Implementation must follow the current policies for:

- [Nominatim](https://operations.osmfoundation.org/policies/nominatim/)
- [OSM API](https://operations.osmfoundation.org/policies/api/)
- Any selected Overpass instance
- Any future tile, elevation, or imagery provider

Provider policies may change. Configuration and adapters must let deployments
switch services without rebuilding the user workflow.

## Export manifest

Every exported world should include a Markdown or JSON manifest containing:

- Application and generator version
- Source provider and snapshot retrieval time
- OSM attribution and ODbL link
- Additional elevation, imagery, model, or texture attribution
- User-created asset declarations
- A statement identifying estimated/generated geometry

This manifest is part of the export, not an optional UI decoration.
