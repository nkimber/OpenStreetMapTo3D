# Racing

## Course setup and generation

Drive mode opens a race director before committing to a race. The player can select a 1 km, 3 km, or 5 km target, compare up to three routes, regenerate the alternatives, choose Casual, Competitive, or Expert rivals, and enable or disable junction closures. The selected route is drawn on the offline minimap before the grid is created.

The simulation builds a layer-aware road graph from drivable roads at least 4.2 m wide. Footpaths, tracks, private or motor-vehicle-restricted roads, driveways, parking aisles, and area highways are excluded. Candidate generation prefers returning circuits, falls back to out-and-back routes, and repeats a viable base route when the requested distance requires multiple laps.

Every candidate reports total and per-lap length, turn count, ascent, maximum grade, average road width, topology, route difficulty, and a quality score. Quality favors useful road width, junction and turn variety while penalizing steep grades and repeated geometry. Unused branches at route junctions are identified for optional red-and-white closure barriers.

## Race runtime

The current race uses a checkered grid, three-light countdown, four physics vehicles, checkpoint arches, turn arrows, minimap overlays, and position/time/progress HUD. Rival vehicles match the selected player model with different paint, apply distinct driving personalities, plan overtakes on sufficiently wide roads, recover when stuck, and yield when another racer blocks their lane. Race integrity checks cover false starts, missed checkpoints, wrong-way driving, off-course recovery, lap counting, split timing, and finish order.

## Rival intelligence and handling

The three named rivals use cautious, balanced, and aggressive profiles layered over Casual, Competitive, or Expert difficulty. They look ahead through upcoming road curvature, brake before turns, select a passing side on wider roads, return toward the center after an overtake, steer away from close side contact, draft a car ahead, and receive a capped catch-up power adjustment when substantially behind. Steering mistakes are small, deterministic, and reduced at higher difficulty. A rival that remains stalled or overturned for three seconds is returned just behind its route progress.

Drafting also gives the player a capped 12% power benefit when closely aligned behind a rival. Collision yielding remains authoritative at close range, so drafting and overtaking never intentionally apply engine force through another vehicle.

The sedan is the balanced baseline. The sport hatchback accelerates and steers more sharply, while the SUV is slower with stronger braking and more heavily damped suspension. The selected profile applies equally to the player and same-model rivals.

## Race rules

The start grid physically holds every car through the countdown and reports an attempted false start. Route direction and separation are checked continuously: sustained reverse travel shows a wrong-way warning, missed arches must be driven through, and a player who stays well off course for four seconds is returned to the last completed checkpoint. Checkpoint split times compare against rivals that have already crossed, multi-lap progress is explicit, position changes are announced, and finish order is deterministic from recorded finish times and remaining route progress.
