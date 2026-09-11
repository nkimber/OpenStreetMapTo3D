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

## Using Edit mode

1. Open a world and choose **Edit**. Select a building from the list or click it.
   **Focus building** moves the camera near that building.
2. Choose **Place front door**, **Place garage door**, or **Place window** and
   click its wall. The wall dropdown provides an alternative placement method.
   Garage width can be one, two or three cars, before or after placement.
3. Drag an opening's yellow handle along the wall, or use **Position along wall**.
   The editor checks wall fit, overlapping openings and clearance below the roof.
4. Doors get an automatic route to a nearby ground-level road. Use **Connect to
   road** and **Generate driveway/path** to change the destination. Minor paths
   and sidewalks represented as road features are also available destinations.
   Automatic routing searches within 150 metres, checks building clearance for
   the full route width, and tries detours around nearby buildings. It reports
   failure when it cannot find a clear route.
5. Use **Draw route** to click your own route points, then **Finish drawing**.
   **Add bend** inserts a draggable point before the endpoint. Yellow route
   handles can be dragged; the last point must meet the selected road. The
   driveway follows terrain and road surfaces, with a raised entrance apron
   where needed. Its Rapier collision mesh matches the displayed driveway.
6. Change roof shape, wall finish and colors in **Appearance**. Draw fence, gate
   or garden boundary points on the ground. Finish drawing, drag the handles,
   or use **Close boundary** for an enclosure. Select an item to delete it.
7. **Save building** writes the preview to the database. **Undo edit/Redo edit**
   change the preview, including after a save; save again to persist an undo.
   **Discard changes** restores the last saved version. Unsaved edits disable
   leaving Edit mode, and a browser navigation guard protects unsaved work.

**Highlight customized buildings** uses green outlines for matching footprints
and amber for customizations needing review. When a footprint changes, saved
placements are paused; reset and place them on the new walls. **Reset building
customizations** previews removal of all manual changes; save to make it durable.
**Discard and reload saved changes** fetches the latest version after a conflict.

Openings are facade panels; they do not cut accessible interiors into buildings
or animate open. Fences, gates and garden borders are decorative. Routing avoids
building footprints; it does not know property boundaries, legal access or
underground utilities. Route grading follows the available terrain rather than
designing an engineered driveway. Existing world height/visibility overrides
remain local to that world.

## Validation

Run the regular lint, typecheck, build and Vitest checks. The geometry tests cover
all three garage widths, footprint identity, overlap/fit, origin changes, road
connections, building clearance, blocked routes, finite mesh generation, and
Rapier raycasts against the rendered entrance apron.

With Docker running and at least one sample world created:

```powershell
docker compose exec -T api pnpm exec tsx tests/integration/building-customizations.ts
```

The API/database test creates isolated provider namespaces inside a transaction,
then rolls back. It verifies three-car garage persistence across separate
snapshots and shifted world origins, provider isolation, stale-save rejection,
footprint-change rejection and versioned reset.

The browser acceptance exercise covered wall-click placement, a saved three-car
garage and front-door paths, reuse in a second world, door dragging and undo/redo,
roof and wall-color changes, a manually placed window, fence/gate/garden drawing,
closing a boundary, and saving. Test customizations were reset afterwards.
The suite contains 105 passing unit tests. End-to-end browser files run with one
worker to avoid competing terrain/WebGL workloads starving preview rebuilds.
All three end-to-end workflows passed with that configuration, including
incremental building/road overrides, terrain rebuilds, driving, and reopening.
