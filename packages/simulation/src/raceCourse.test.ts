import { describe, expect, it } from "vitest";
import {
  generateRaceCourse,
  generateRaceCourseCandidates,
  nearestRaceProgress,
  sampleRaceRoute,
  type RaceRoad,
} from "./index.js";

const line = (id: string, points: Array<[number, number]>): RaceRoad => ({
  id,
  width: 7,
  layer: 0,
  points: points.map(([x, z]) => ({ x, y: 0, z })),
});

describe("race course generation", () => {
  it("generates multi-lap choices promptly on a densely sampled road", () => {
    const road = line(
      "dense",
      Array.from({ length: 6_001 }, (_, index) => [index * 0.2, -32]),
    );
    const started = performance.now();
    const candidates = generateRaceCourseCandidates(
      [road],
      { x: 0, z: -32 },
      { x: 1, z: 0 },
      { targetLength: 5_000 },
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.length).toBeGreaterThanOrEqual(5_000);
    // A generous regression ceiling: exhaustive path reconstruction and road
    // scans used to take tens of seconds for this many samples.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("preserves nearest widths and branch closures across spatial cell boundaries", () => {
    const roads = [
      {
        ...line("crossing", [
          [-200, -32],
          [200, -32],
        ]),
        width: 5,
      },
      line("loop", [
        [-64, -32],
        [32, -32],
        [32, 300],
        [-64, 300],
        [-64, -32],
      ]),
      line("branch", [
        [32, -32],
        [32, -180],
      ]),
    ];
    const course = generateRaceCourse(
      roads,
      { x: 32, z: 40 },
      { x: 0, z: 1 },
      { minimumLength: 500 },
    )!;
    expect(course.kind).toBe("loop");
    expect(course.barriers).toContainEqual({ x: 32, y: 0, z: -37, yaw: -0 });
    const widths = course.points.map((point) => {
      let nearest = Infinity;
      let width = 5;
      for (const road of roads) {
        for (let index = 1; index < road.points.length; index += 1) {
          const start = road.points[index - 1]!;
          const end = road.points[index]!;
          const dx = end.x - start.x;
          const dz = end.z - start.z;
          const ratio = Math.max(
            0,
            Math.min(
              1,
              ((point.x - start.x) * dx + (point.z - start.z) * dz) /
                (dx * dx + dz * dz),
            ),
          );
          const separation = Math.hypot(
            point.x - start.x - ratio * dx,
            point.z - start.z - ratio * dz,
          );
          if (separation < nearest) {
            nearest = separation;
            width = road.width;
          }
        }
      }
      return width;
    });
    expect(course.averageRoadWidth).toBe(
      widths.reduce((sum, width) => sum + width, 0) / widths.length,
    );
  });

  it("prefers a connected loop that returns to the projected start", () => {
    const course = generateRaceCourse(
      [
        line("south", [
          [0, 0],
          [300, 0],
        ]),
        line("east", [
          [300, 0],
          [300, 300],
        ]),
        line("north", [
          [300, 300],
          [0, 300],
        ]),
        line("west", [
          [0, 300],
          [0, 0],
        ]),
      ],
      { x: 40, z: 2 },
      { x: 1, z: 0 },
    );

    expect(course?.kind).toBe("loop");
    expect(course?.length).toBeGreaterThanOrEqual(1_000);
    expect(course?.points[0]).toEqual(course?.points.at(-1));
    expect(course?.checkpointDistances.at(-1)).toBe(course?.length);
  });

  it("falls back to a one-kilometre out-and-back course", () => {
    const course = generateRaceCourse(
      [
        line("straight", [
          [0, 0],
          [650, 0],
        ]),
      ],
      { x: 80, z: 0 },
      { x: 1, z: 0 },
    );

    expect(course?.kind).toBe("out-and-back");
    expect(course?.length).toBeGreaterThanOrEqual(1_000);
    expect(course?.points[0]).toEqual(course?.points.at(-1));
  });

  it("rejects a connected road component that is too short", () => {
    expect(
      generateRaceCourse(
        [
          line("short", [
            [0, 0],
            [300, 0],
          ]),
        ],
        { x: 0, z: 0 },
        { x: 1, z: 0 },
      ),
    ).toBeUndefined();
  });

  it("samples and advances progress without jumping across an overlapping return", () => {
    const course = generateRaceCourse(
      [
        line("straight", [
          [0, 0],
          [650, 0],
        ]),
      ],
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    )!;
    expect(sampleRaceRoute(course, 100).x).toBeCloseTo(100);
    expect(nearestRaceProgress(course, { x: 120, z: 1 }, 90)).toBeCloseTo(120);
    expect(nearestRaceProgress(course, { x: 120, z: 1 }, 90)).toBeLessThan(200);
  });

  it("scores candidate routes and expands a circuit to the selected distance", () => {
    const roads = [
      line("south", [
        [0, 0],
        [300, 0],
      ]),
      line("east", [
        [300, 0],
        [300, 300],
      ]),
      line("north", [
        [300, 300],
        [0, 300],
      ]),
      line("west", [
        [0, 300],
        [0, 0],
      ]),
    ];
    const candidates = generateRaceCourseCandidates(
      roads,
      { x: 40, z: 2 },
      { x: 1, z: 0 },
      { targetLength: 3_000 },
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.kind).toBe("loop");
    expect(candidates[0]?.length).toBeGreaterThanOrEqual(3_000);
    expect(candidates[0]?.laps).toBeGreaterThan(1);
    expect(candidates[0]?.qualityScore).toBeGreaterThan(0);
    expect(candidates[0]?.averageRoadWidth).toBe(7);
  });

  it("identifies an unused junction branch for optional course barriers", () => {
    const course = generateRaceCourse(
      [
        line("loop-a", [
          [0, 0],
          [300, 0],
          [300, 300],
          [0, 300],
          [0, 0],
        ]),
        line("branch", [
          [300, 0],
          [450, -120],
        ]),
      ],
      { x: 40, z: 0 },
      { x: 1, z: 0 },
    );
    expect(course?.barriers.length).toBeGreaterThan(0);
  });
});
