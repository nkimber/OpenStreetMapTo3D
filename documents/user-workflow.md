# User workflow

Status: Active

Last updated: 2026-08-31

## Primary journey

```text
Home -> Find location -> Select area -> Review data -> Generate
     -> Inspect world -> Place car -> Drive -> Save
```

## 1. Home

The home screen presents:

- **Create a world**
- Recently opened local projects
- A sample neighborhood that requires no external service
- Links to data attribution and project documentation

No account is required. If the API or database is unavailable, the page should
explain which local service is unhealthy rather than presenting an empty screen.

## 2. Find a location

The user may:

- Submit a city, address, or nearby intersection.
- Enter a latitude and longitude.
- Open the bundled sample fixture.

Search occurs only after explicit submission. The application must not send
autocomplete requests to the public Nominatim service.

The interface should explain that a submitted location is sent to the configured
geocoding provider. Latitude/longitude entry offers an alternative when the user
does not want to submit a text address.

## 3. Select an area

A 2D MapLibre preview centers on the search result. The user moves and resizes a
rectangular selection.

Proposed defaults:

- Initial selection: approximately 1 km by 1 km
- Recommended maximum: 2 km by 2 km
- Hard limits enforced by the API, not only the browser

The preview displays estimated area, feature count, download size, and a simple
performance classification. Oversized selections remain visible but cannot be
submitted until reduced.

## 4. Review source coverage

After the preview import, the application reports:

- Roads, driveways, paths, and parking areas found
- Building footprints found
- Buildings with explicit height or level information
- Buildings requiring estimated heights
- Unsupported or invalid features skipped
- Whether terrain elevation is available

Diagnostics must distinguish source facts from generated assumptions. The
default action remains **Generate world**; advanced settings are optional.

## 5. Configure generation

MVP settings:

- World name
- Visual style
- Building-height fallback
- Include or exclude minor paths
- Include or exclude building collision
- Deterministic generation seed

Later settings may include elevation, vegetation density, roof generation,
imagery, weather, and road-surface presets.

## 6. Generate

Progress uses user-facing stages:

1. Preparing source data
2. Building the road network
3. Constructing buildings
4. Creating ground and collision surfaces
5. Preparing the driving scene

Generation is cancelable. Cancellation preserves the imported source snapshot
but does not mark the world build as complete.

If individual features fail, the build should finish with warnings when a usable
world can still be produced. Fatal failures must include a retry action and a
diagnostic identifier.

## 7. Inspect and edit

The world initially opens in Inspect mode with an orbit camera. Selecting an
object shows its OSM identity, relevant source tags, generated values, and any
manual override.

Implemented editing actions:

- Change building height
- Hide or restore a feature
- Adjust a road width
- Set or move the exact vehicle spawn point by clicking a road
- Undo and redo changes

Edits are stored as overrides; the original OSM source snapshot remains intact.

## 8. Place the vehicle

The user clicks a road surface. The application projects that exact picked point
onto the road centerline and aligns the car with the closest segment tangent.
The resulting versioned spawn override persists with the project.

If the selected point is unsuitable, the application explains why and proposes
the nearest valid point.

## 9. Drive

Current controls:

- W/S or up/down: forward and reverse
- A/D or left/right: steering
- Space: handbrake
- R: reset at the most recent safe position
- Shift+R: return to the configured spawn
- Standard gamepad: left stick steering, triggers throttle/reverse, primary
  button handbrake

Drive mode displays speed, safe-reset and spawn-return controls, gamepad and
steering settings, a chase camera, and OpenStreetMap attribution. Editing
controls are hidden while physics is active.

## 10. Save and reopen

A saved project contains:

- Geographic boundary and local-world anchor
- Source snapshot reference and attribution
- Generation settings and generator version
- User overrides
- Vehicle preset and spawn point
- Last editor camera position

Generated meshes may be cached, but the source snapshot and generation recipe
remain the authoritative representation.

## Recovery paths

- **No buildings found:** allow a road-only world.
- **No roads found:** stop before Drive mode and let the user adjust the area.
- **Missing heights:** use documented defaults and show an estimation count.
- **External provider unavailable:** use a cached snapshot or sample fixture.
- **Generation exceeds memory:** cancel safely and recommend a smaller area.
- **Vehicle becomes stuck:** reset to the last known stable road position.
