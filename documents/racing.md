# Racing

## Course setup and generation

Drive mode opens a race director before committing to a race. The player can select a 1 km, 3 km, or 5 km target, compare up to three routes, regenerate the alternatives, choose Casual, Competitive, or Expert rivals, and enable or disable junction closures. The selected route is drawn on the offline minimap before the grid is created.

The simulation builds a layer-aware road graph from drivable roads at least 4.2 m wide. Footpaths, tracks, private or motor-vehicle-restricted roads, driveways, parking aisles, and area highways are excluded. Candidate generation prefers returning circuits, falls back to out-and-back routes, and repeats a viable base route when the requested distance requires multiple laps.

Course search and scoring run in a dedicated Web Worker. The director opens immediately with a loading message; changing distance or regenerating replaces the pending job. Closing the director, leaving Drive mode, or exiting the world terminates generation. Only the latest request can populate the picker, and Start race remains disabled until its courses arrive. Worker failures and a 30-second timeout show a retryable error in the director.

Generation shares a prepared graph and spatial road indexes across candidate headings, reconstructs only the required shortest path, and skips duplicate road sets, orientations, and repeated junction geometry. This avoids the exhaustive path reconstruction and whole-network scans that previously froze the browser on densely sampled neighborhoods. Regression tests cover a 6,001-point road, spatial cell boundaries and overlapping road widths, and worker readiness, replacement, cancellation, errors, and timeout cleanup.

Every candidate reports total and per-lap length, turn count, ascent, maximum grade, average road width, topology, route difficulty, and a quality score. Quality favors useful road width, junction and turn variety while penalizing steep grades and repeated geometry. Unused branches at route junctions are identified for optional red-and-white closure barriers.

## Race runtime

The current race uses a checkered grid, three-light countdown, four physics vehicles, checkpoint arches, turn arrows, minimap overlays, and position/time/progress HUD. Rival vehicles match the selected player model with different paint, apply distinct driving personalities, plan overtakes on sufficiently wide roads, recover when stuck, and yield when another racer blocks their lane. Race integrity checks cover false starts, missed checkpoints, wrong-way driving, off-course recovery, lap counting, split timing, and finish order.

## Rival intelligence and handling

The three named rivals use cautious, balanced, and aggressive profiles layered over Casual, Competitive, or Expert difficulty. They look ahead through upcoming road curvature, brake before turns, select a passing side on wider roads, return toward the center after an overtake, steer away from close side contact, draft a car ahead, and receive a capped catch-up power adjustment when substantially behind. Steering mistakes are small, deterministic, and reduced at higher difficulty. A rival that remains stalled or overturned for three seconds is returned just behind its route progress.

Drafting also gives the player a capped 12% power benefit when closely aligned behind a rival. Collision yielding remains authoritative at close range, so drafting and overtaking never intentionally apply engine force through another vehicle.

The sedan is the balanced baseline. The sport hatchback accelerates and steers more sharply, while the SUV is slower with stronger braking and more heavily damped suspension. The selected profile applies equally to the player and same-model rivals.

## Race rules

The start grid physically holds every car through the countdown and reports an attempted false start. Route direction and separation are checked continuously: sustained reverse travel shows a wrong-way warning, missed arches must be driven through, and a player who stays well off course for four seconds is returned to the last completed checkpoint. Checkpoint split times compare against rivals that have already crossed, multi-lap progress is explicit, position changes are announced, and finish order is deterministic from recorded finish times and remaining route progress.

## Race feedback and results

The route arrows turn red while the player is travelling the wrong way. The chase camera eases wider when another racer is close and moves into a wider orbit after the finish. Web Audio cues cover each countdown light, the green signal, engine pitch, tire slip, heavy impacts, checkpoint crossings, a gained position, and the finish fanfare; the audio context is activated from the Start race gesture so browser autoplay rules are respected.

Crossing the final arch reveals animated checkered flags and a results board with all four racers, recorded finish times, the fastest checkpoint split, and a locally saved best time for that generated course. From the board the player can immediately race again, return to the course director, or exit racing.

## Race button freeze validation — 2026-10-01

The local reference probe used a saved neighborhood with 270 roads and 13,845 sampled points. Standalone candidate generation fell from 63.2 seconds to 0.84 seconds for the 1 km target, and from 63.4 seconds to 0.63 seconds for the 5 km target. These measurements cover generation, not overall rendering performance. In Chromium, worker round trips took approximately 0.9–1.4 seconds while a 50 ms browser heartbeat continued to advance.

The 166-test suite passed with two workers; the default parallel run initially timed out in two API tests. Repository type checking, the production build, and formatting and lint checks for changed sources passed. Browser validation on the rebuilt local Docker web service covered course generation, rapid distance changes, regenerating and closing during generation, reopening setup, starting and cancelling a race, retrying after a worker-load failure, and cancelling generation by leaving Drive mode. Full race completion and remote deployment acceptance were not retested for this fix.

The broader `pnpm test:e2e` run did not pass on the local stack: the minimap test exceeded its 5-second initial-world-load assertion, the building-height test still showed `levels` provenance after Apply, and the road-width test did not observe a changed build hash within 30 seconds. Those world-loading and editor-rebuild checks remain unresolved; the successful targeted race checks do not establish acceptance for those workflows.
