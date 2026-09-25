import { describe, expect, it } from "vitest";
import { localToWgs84 } from "@osm3d/geo";
import {
  centerInsideBounds,
  enhancementTileCenter,
  enhancementTileKey,
  enhancementTilesForPose,
} from "./driveEnhancement.js";

const anchor = { longitude: -84.2, latitude: 34.05, height: 0 };

function pose(east: number, north: number, headingDegrees: number) {
  const point = localToWgs84({ east, north, up: 0 }, anchor);
  return {
    longitude: point.longitude,
    latitude: point.latitude,
    headingDegrees,
  };
}

describe("driving enhancement tiles", () => {
  it("starts with the tile containing the car", () => {
    expect(enhancementTilesForPose(pose(25, 25, 90), anchor)).toEqual([
      { x: 0, north: 0 },
    ]);
  });

  it("prefetches the next unprocessed tile in the driving direction", () => {
    expect(enhancementTilesForPose(pose(125, 25, 90), anchor)).toEqual([
      { x: 0, north: 0 },
      { x: 1, north: 0 },
    ]);
    expect(enhancementTilesForPose(pose(-25, -125, 180), anchor)).toEqual([
      { x: -1, north: -1 },
      { x: -1, north: -2 },
    ]);
  });

  it("produces stable tile keys and centers", () => {
    const tile = { x: -1, north: 2 };
    expect(enhancementTileKey(tile)).toBe("-1:2");
    const center = enhancementTileCenter(tile, anchor);
    const expected = localToWgs84({ east: -100, north: 500, up: 0 }, anchor);
    expect(center[0]).toBeCloseTo(expected.longitude, 8);
    expect(center[1]).toBeCloseTo(expected.latitude, 8);
    expect(
      centerInsideBounds(center, {
        west: center[0] - 0.01,
        east: center[0] + 0.01,
        south: center[1] - 0.01,
        north: center[1] + 0.01,
      }),
    ).toBe(true);
  });
});
