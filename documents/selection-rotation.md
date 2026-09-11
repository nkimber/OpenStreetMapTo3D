# Rotating the neighborhood selection

Click the setup map to focus it. Plain arrow keys continue to pan the map and move the selection center. Shift+Left/Right continues to rotate the map camera. **Ctrl+Left/Right rotates the selection itself by 5°**, without changing the center or camera bearing. A rotation slider offers 1° steps; left/right buttons and Reset rotation provide mouse/touch alternatives. Rotation is clockwise from north and wraps at 360°.

The polygon is calculated in local metre-scaled coordinates, so its side length and area remain unchanged when rotated. Both map rendering and the import API use the same corner calculation. The map's independent camera rotation does not change the selected geographic polygon or discard an imported preview.

## Import and persistence

- At 0°, existing bounding-box requests and saved worlds remain compatible.
- For a rotated selection, live Overpass queries use its four-corner `poly` filter, with latitude/longitude pairs. Elevation uses the enclosing north-aligned bounds. A 2 km square remains a 4 km² selection even when its download envelope approaches 8 km².
- The API validates that the envelope matches the selection. Browser/server cache identities include the rotation; content identities also distinguish rotated requests.
- Changing rotation clears the old preview/import selection. Results arriving from an older boundary are ignored, so generating cannot inadvertently use that old download.
- Selection center, side length and angle are persisted in world generation settings. The project's PostGIS boundary stores the rotated polygon; existing summary bounds remain its axis-aligned envelope. No database migration is required.
- The offline fixture is generated within a north-aligned square and then rotated into the selected area, allowing local end-to-end testing without a live Overpass call.

## Boundary semantics

This is an import selection, not a hard clipping plane. As before, Overpass returns complete ways/relations, which can extend across the selected edge, and terrain generation retains its surrounding chunk padding. Rotating the selection does not rotate the actual streets, buildings, or compass direction of a live neighborhood. Polar/dateline-spanning selections remain outside the supported bounds format.

## Validation

Tests cover preserved side lengths and center, angle wrapping, expanded envelopes, API limits and malformed selections, Overpass polygon syntax, and rotation-aware cache identities. Browser checks cover Ctrl rotation, Shift camera rotation, reset, and a rotated offline import saved as a world. Live Overpass availability is not established by fixture tests.

2026-09-10 checkpoint: 90 unit tests and all three existing Chromium workflows passed. Typecheck, lint, formatting and the Docker production build passed. Interactive checks verified 5° Ctrl steps, 0°/355° wraparound, unchanged selection center/angle/import after Shift rotation, and a saved 5° offline world. A read-only database check confirmed its boundary was the rotated five-point closed polygon. No cloud deployment was performed.

References: [Overpass QL polygon filter](<https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL#By_polygon_(poly)>), [MapLibre keyboard controls](https://maplibre.org/maplibre-gl-js/docs/API/classes/KeyboardHandler/).
