# Performance budget

Status: Active

Last updated: 2026-08-31

## Scope

These budgets cover the current elevation-aware browser runtime. They are
acceptance targets, not claims that every OpenStreetMap area has equal feature
density. A result outside a budget must identify the fixture, build hash,
hardware, browser, and dominant feature or chunk before the limit is changed.

## World-size tiers

| Tier                |               Area | Intended use                         |
| ------------------- | -----------------: | ------------------------------------ |
| Fixture             | 23 source features | Reproducible CI and workflow testing |
| Default             |        1 km × 1 km | Normal neighborhood project          |
| Maximum recommended |        2 km × 2 km | User-confirmed high-cost project     |

## Budgets

| Metric                                |              Fixture |   Default 1 km world |   Maximum 2 km world |
| ------------------------------------- | -------------------: | -------------------: | -------------------: |
| Worker geometry plan                  |             ≤ 250 ms |           ≤ 1,500 ms |           ≤ 5,000 ms |
| Single-feature partial plan + rebuild |             ≤ 250 ms |             ≤ 500 ms |           ≤ 1,000 ms |
| Drive frame rate after warm-up        |      ≥ 55 fps median |      ≥ 50 fps median |      ≥ 40 fps median |
| 1% low frame rate                     |             ≥ 40 fps |             ≥ 30 fps |             ≥ 24 fps |
| Routine main-thread task              |              < 50 ms |              < 50 ms |              < 50 ms |
| Interactive edit rebuild scope        | Affected chunks only | Affected chunks only | Affected chunks only |
| Forward/reverse force taper           |           90/32 km/h |           90/32 km/h |           90/32 km/h |

Generation must remain cancelable at every tier. A cancel terminates the active
Worker and leaves the immutable source snapshot and saved overrides intact.

## Reference machine and baseline

The initial manual baseline was recorded on:

- Windows 11, Docker Desktop
- Intel Core Ultra 7 265H, 16 cores / 16 logical processors
- Intel Arc 140T GPU, driver 32.0.101.8508
- 63.4 GiB system memory
- Node.js 24.13.1, Playwright 1.62.1

For the bundled 23-feature elevation sample, headed Chromium reported 13 feature
chunks, 36 terrain chunks, 73,728 terrain triangles, 9,252 road/shoulder
triangles, a 174 ms warm Worker plan, 60 fps, and zero recoveries after warm-up.
A building height edit reported one rebuilt feature chunk. This is an
observational developer baseline; CI uses SwiftShader and is a functional rather
than GPU-performance measurement.

## Measurement surfaces

The **Build & performance** panel reports frame rate, road and terrain triangles,
elevation provider/range, car elevation, Worker duration, affected chunks,
main-thread frames longer than 50 ms, recovery count, diagnostic count, and
deterministic build hash. The offline browser test checks elevation attribution,
the speed limit, and one-chunk rebuild. Geometry fixtures check deterministic
terrain seams, collider sampling, uphill profiles, joined curves/intersections,
and vertical-layer separation.

Before a performance-sensitive release:

1. Run `pnpm test` and `pnpm test:e2e` against the Docker stack.
2. Open the fixture and a recorded 1 km suburban project in headed Chromium.
3. Allow five seconds of warm-up, drive for 30 seconds, and record the telemetry.
4. Apply one building and one road override; record duration and rebuilt chunks.
5. Record the build hash and investigate any new diagnostics or budget breach.

Future automation should collect frame-time percentiles and memory directly
through the Performance API rather than relying only on the live panel.
