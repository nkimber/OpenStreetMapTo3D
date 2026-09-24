import { describe, expect, it } from "vitest";
import {
  generateRaceCourse,
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
});
