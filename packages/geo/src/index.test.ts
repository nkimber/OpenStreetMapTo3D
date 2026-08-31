import { describe, expect, it } from "vitest";
import { boundsAreaSquareKm, localToWgs84, wgs84ToLocal } from "./index.js";

describe("local ENU conversion", () => {
  const anchor = { longitude: -75.1652, latitude: 39.9526, height: 0 };

  it("keeps the anchor at the local origin", () => {
    const local = wgs84ToLocal(anchor, anchor);
    expect(local.east).toBeCloseTo(0, 6);
    expect(local.north).toBeCloseTo(0, 6);
    expect(local.up).toBeCloseTo(0, 6);
  });

  it("round-trips a nearby point", () => {
    const source = { longitude: -75.16, latitude: 39.956, height: 12 };
    const restored = localToWgs84(wgs84ToLocal(source, anchor), anchor);
    expect(restored.longitude).toBeCloseTo(source.longitude, 7);
    expect(restored.latitude).toBeCloseTo(source.latitude, 7);
    expect(restored.height).toBeCloseTo(source.height, 3);
  });

  it("estimates a positive neighborhood area", () => {
    const area = boundsAreaSquareKm({
      west: -75.171,
      south: 39.948,
      east: -75.159,
      north: 39.957,
    });
    expect(area).toBeGreaterThan(0.8);
    expect(area).toBeLessThan(1.3);
  });
});
