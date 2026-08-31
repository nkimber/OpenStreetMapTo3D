import { describe, expect, it } from "vitest";
import { normalizeOverpass, parseOsmNumber } from "./index.js";

describe("OSM normalization", () => {
  it("parses metric and imperial values", () => {
    expect(parseOsmNumber("12 m")).toBe(12);
    expect(parseOsmNumber("10' 6\"")).toBeCloseTo(3.2004, 4);
  });

  it("normalizes roads and buildings with stable source IDs", () => {
    const result = normalizeOverpass({
      elements: [
        {
          type: "way",
          id: 10,
          tags: { highway: "residential", lanes: "2" },
          geometry: [
            { lat: 40, lon: -75 },
            { lat: 40.001, lon: -75 },
          ],
        },
        {
          type: "way",
          id: 11,
          tags: { building: "house", "building:levels": "2" },
          geometry: [
            { lat: 40, lon: -75 },
            { lat: 40, lon: -74.9999 },
            { lat: 40.0001, lon: -74.9999 },
            { lat: 40.0001, lon: -75 },
            { lat: 40, lon: -75 },
          ],
        },
      ],
    });
    expect(result.features).toHaveLength(2);
    expect(result.features[0]?.sourceId).toBe("osm:way:10");
    expect(result.features[1]?.facts.levels).toBe(2);
  });

  it("preserves courtyard holes from multipolygon relations", () => {
    const result = normalizeOverpass({
      elements: [
        {
          type: "relation",
          id: 20,
          tags: { type: "multipolygon", building: "apartments" },
          members: [
            {
              type: "way",
              ref: 21,
              role: "outer",
              geometry: [
                { lat: 40, lon: -75 },
                { lat: 40, lon: -74.99 },
                { lat: 40.01, lon: -74.99 },
                { lat: 40.01, lon: -75 },
                { lat: 40, lon: -75 },
              ],
            },
            {
              type: "way",
              ref: 22,
              role: "inner",
              geometry: [
                { lat: 40.002, lon: -74.998 },
                { lat: 40.002, lon: -74.992 },
                { lat: 40.008, lon: -74.992 },
                { lat: 40.008, lon: -74.998 },
                { lat: 40.002, lon: -74.998 },
              ],
            },
          ],
        },
      ],
    });
    expect(result.features[0]?.geometry.type).toBe("Polygon");
    expect(
      result.features[0]?.geometry.type === "Polygon"
        ? result.features[0].geometry.coordinates
        : [],
    ).toHaveLength(2);
  });

  it("reports missing roads and estimated building heights", () => {
    const result = normalizeOverpass({
      elements: [
        {
          type: "way",
          id: 30,
          tags: { building: "house" },
          geometry: [
            { lat: 40, lon: -75 },
            { lat: 40, lon: -74.999 },
            { lat: 40.001, lon: -74.999 },
            { lat: 40, lon: -75 },
          ],
        },
      ],
    });
    expect(result.features[0]?.warnings[0]?.code).toBe(
      "BUILDING_HEIGHT_ESTIMATED",
    );
    expect(
      result.diagnostics.some((item) => item.code === "NO_ROADS_FOUND"),
    ).toBe(true);
  });
});
