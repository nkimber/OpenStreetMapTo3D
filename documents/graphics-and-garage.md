# Garage and neighborhood graphics

## User workflow

Open a world and select **Garage** beside Inspect and Drive. Choose the sedan, sport hatchback or SUV, inspect the rotating preview, choose a paint color, then select **Use this car**. Cancel or Escape leaves the existing choice unchanged. The world simulation and rendering pause while the garage is open. The car stops when switching models. Model and paint are stored on this browser/device, not in the shared world definition.

Model-load failure retains the current car. Initial loading has the original procedural car as a fallback, with an error and Garage retry path. Storage failures do not prevent selecting a vehicle. Assets are served locally, with CC0 license and provenance alongside the models.

## Vehicle implementation

Three locally bundled Kenney Car Kit models use GLTFLoader. Body proportions are normalized to the existing 1.9 m wide / 4.1 m long physical chassis; mass, suspension, acceleration and braking tuning remain unchanged. Wheel axle positions are derived from the model nodes; tires are normalized independently to circular 0.36 m radius. Front-wheel steering, rolling and suspension travel follow the vehicle controller. The palette shader repaints only body panels, preserving glass, tires and trim; lamp surfaces glow, brake lamps brighten, and a forward spotlight illuminates the road.

The garage uses one additional preview renderer, disposed on close/change. Late asynchronous loads are discarded and disposed. Replaced model geometry, materials and textures are released. Future vehicle-specific handling can be added separately.

## Building implementation

Generator 0.6.0 carries roof/material/color tags into building plans. A deterministic renderer uses `roof:shape` (flat, gabled, hipped), `roof:height`, `roof:orientation` (along/across), `building:material`, `building:colour`, and `roof:colour` when supported. Missing attributes receive repeatable defaults based on source ID. Unsupported roof shapes fall back to flat roofs. Unknown colors use the palette. Heights remain bounded by the existing building height/collider.

Roof triangles are split by intersecting slope planes inside the actual triangulated footprint. Concave outlines and courtyard holes remain intact. Walls meet the sloping roof boundary. Facades use procedural brick or siding patterns, or plain stucco, plus merged framed windows, estimated doors and garage doors. Roofs use a procedural shingle pattern with distance antialiasing. Building placement and existing collision behavior are unchanged; terrain and road surfaces are not modified.

Each building uses two base meshes and one merged detail mesh. Facade details disappear beyond 160 m. No per-window objects, downloaded house imagery, or per-house texture images are required. Selection metadata is retained on all meshes and the inspector explicitly labels missing appearance details as estimates.

## Limits

These are plausible buildings, not reconstructions of specific homes. Door/garage position is estimated from footprint order, not verified street-facing orientation. Complex roof assemblies, roof direction in degrees, building-part composition, true projecting roof overhangs, foundations fitted to sloping sites, and photographic facades remain future work. Existing building physics still uses bounding boxes. This increment does not change that approximation.

## Validation

Automated coverage includes preference validation, local asset completeness, deterministic building appearance, supported/unsupported tags, roof height limits, exact projected roof area for concave/courtyard footprints, metadata and detail-mesh counts. Existing terrain, physics, import, editing and driving checks are also run. Browser acceptance and final check results are recorded in the implementation handoff; unit tests alone do not establish visual quality or real-neighborhood frame rate.

2026-09-10 checkpoint: 80 tests passed locally; the preceding 79-test suite, web typecheck and full production build also passed in Docker. The existing three Chromium workflows passed twice against the Docker application. Interactive Playwright inspection used the saved 1,888-building neighborhood to check the garage, model loading, saved paint, Escape cancellation and close-up building rendering. That inspection caught and corrected the SUV/hatchback palette mapping; the asset tests now verify each model's paint swatch. No cloud deployment or broad device-performance certification is included.
