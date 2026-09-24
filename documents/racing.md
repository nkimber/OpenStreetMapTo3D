# Racing

## Course setup and generation

Drive mode opens a race director before committing to a race. The player can select a 1 km, 3 km, or 5 km target, compare up to three routes, regenerate the alternatives, choose Casual, Competitive, or Expert rivals, and enable or disable junction closures. The selected route is drawn on the offline minimap before the grid is created.

The simulation builds a layer-aware road graph from drivable roads at least 4.2 m wide. Footpaths, tracks, private or motor-vehicle-restricted roads, driveways, parking aisles, and area highways are excluded. Candidate generation prefers returning circuits, falls back to out-and-back routes, and repeats a viable base route when the requested distance requires multiple laps.

Every candidate reports total and per-lap length, turn count, ascent, maximum grade, average road width, topology, route difficulty, and a quality score. Quality favors useful road width, junction and turn variety while penalizing steep grades and repeated geometry. Unused branches at route junctions are identified for optional red-and-white closure barriers.

## Race runtime

The current race uses a checkered grid, three-light countdown, four physics vehicles, checkpoint arches, turn arrows, minimap overlays, and position/time/progress HUD. Rival vehicles match the selected player model with different paint and yield when another racer blocks their lane. The following sections will track richer race rules, AI strategy, feedback, and results as those increments land.
