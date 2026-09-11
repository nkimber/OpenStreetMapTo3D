# Building customizations

Building customizations are stored independently of world overrides, keyed by
snapshot provider and OSM source ID. This installation shares customizations
between its worlds; there is no per-user ownership model yet. Offline fixtures
and live OSM sources have separate namespaces.

The definition endpoint includes saved customizations for its buildings. PUT
`/api/worlds/:id/building-customization` validates the building, footprint and
exterior-wall placement, and atomically checks the supplied revision. A stale
save returns HTTP 409. Reset saves an empty, versioned record rather than
deleting the revision history. New snapshots with the same provider/source ID
reuse these records. Changed OSM IDs are not automatically matched.

Wall endpoints and route points use geographic coordinates, independent of the
world origin. The footprint signature ignores ring ordering and winding, but
changes when the footprint changes. Garage widths are 2.7, 5.4 and 8.1 metres
for one, two and three cars. The placement validator requires space on both
sides of an opening.

Persistence checkpoint validation: contracts tests, API boundary tests, API
TypeScript check and targeted lint passed. Database integration and browser
acceptance are pending the editor implementation.
