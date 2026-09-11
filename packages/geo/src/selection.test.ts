import { describe, expect, it } from "vitest";
import {
  normalizeBearing,
  selectionBounds,
  selectionMatchesBounds,
  selectionRing,
} from "./index.js";

const selection = {
  center: { longitude: -84.25, latitude: 34.02, height: 0 },
  sizeMeters: 1000,
  bearingDegrees: 0,
};
describe("rotatable square selection", () => {
  it("wraps bearings in both directions", () => {
    expect(normalizeBearing(-5)).toBe(355);
    expect(normalizeBearing(360)).toBe(0);
    expect(normalizeBearing(725)).toBe(5);
  });
  it("preserves side lengths and center when rotated", () => {
    for (const bearingDegrees of [0, 5, 45, 90, 135, 270, 355]) {
      const ring = selectionRing({ ...selection, bearingDegrees });
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual(ring[4]);
      const scale =
        111320 * Math.cos((selection.center.latitude * Math.PI) / 180);
      for (let i = 0; i < 4; i++)
        expect(
          Math.hypot(
            (ring[i + 1]![0] - ring[i]![0]) * scale,
            (ring[i + 1]![1] - ring[i]![1]) * 111320,
          ),
        ).toBeCloseTo(1000, 5);
      expect(
        ring.slice(0, 4).reduce((sum, p) => sum + p[0], 0) / 4,
      ).toBeCloseTo(selection.center.longitude, 10);
      expect(
        ring.slice(0, 4).reduce((sum, p) => sum + p[1], 0) / 4,
      ).toBeCloseTo(selection.center.latitude, 10);
    }
  });
  it("uses a larger envelope at 45 degrees without changing square size", () => {
    const initial = selectionBounds(selection),
      diagonal = selectionBounds({ ...selection, bearingDegrees: 45 });
    expect(
      (diagonal.east - diagonal.west) / (initial.east - initial.west),
    ).toBeCloseTo(Math.SQRT2, 8);
    expect(
      selectionMatchesBounds({ ...selection, bearingDegrees: 45 }, diagonal),
    ).toBe(true);
    expect(
      selectionMatchesBounds({ ...selection, bearingDegrees: 45 }, initial),
    ).toBe(false);
  });
});
