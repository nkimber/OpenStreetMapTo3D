import { describe, expect, it } from "vitest";
import { AreaSelectionSchema } from "@osm3d/contracts";
import { selectionBounds, selectionRing } from "@osm3d/geo";
import { overpassQuery } from "./providers.js";

describe("rotated import queries", () => {
  const selection = {
    center: { latitude: 34, longitude: -84, height: 0 },
    sizeMeters: 2000,
    bearingDegrees: 45,
  };
  it("requests the polygon using latitude/longitude pairs, not its envelope", () => {
    const query = overpassQuery(selectionBounds(selection), selection);
    const pairs = selectionRing(selection)
      .slice(0, -1)
      .map(([lon, lat]) => `${lat} ${lon}`)
      .join(" ");
    expect(query).toContain(`way["highway"](poly:"${pairs}")`);
    expect(query).toContain(`relation["building"](poly:"${pairs}")`);
    expect(query).toContain("out geom;");
  });
  it("preserves legacy north-aligned queries", () => {
    expect(overpassQuery({ south: 1, west: 2, north: 3, east: 4 })).toContain(
      'way["highway"](1,2,3,4)',
    );
  });
  it("rejects invalid sizes and non-finite or unnormalized bearings", () => {
    for (const bearingDegrees of [-1, 360, Infinity, NaN])
      expect(
        AreaSelectionSchema.safeParse({ ...selection, bearingDegrees }).success,
      ).toBe(false);
    expect(
      AreaSelectionSchema.safeParse({ ...selection, sizeMeters: 2001 }).success,
    ).toBe(false);
  });
});
