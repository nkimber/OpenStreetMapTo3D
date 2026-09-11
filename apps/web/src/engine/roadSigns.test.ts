import { describe, expect, it } from "vitest";
import type { NormalizedFeature, WorldOverride } from "@osm3d/contracts";
import { buildWorldPlan } from "@osm3d/worldgen";
import { roadSignLocations } from "./roadSigns.js";

function road(
  id: string,
  name: string,
  coordinates: number[][],
  layer = 0,
): NormalizedFeature {
  return {
    sourceId: id,
    sourceType: "way",
    kind: "road",
    geometry: {
      type: "LineString",
      coordinates: coordinates as [number, number][],
    },
    tags: { name, highway: "residential", layer: String(layer) },
    facts: { layer },
    warnings: [],
  };
}
const streets = [
  road("a", "Main Street", [
    [-75.001, 40],
    [-75, 40],
    [-74.999, 40],
  ]),
  road("b", "Oak Avenue", [
    [-75, 39.999],
    [-75, 40],
    [-75, 40.001],
  ]),
];
function plan(features = streets, overrides: WorldOverride[] = []) {
  return buildWorldPlan(
    features,
    { longitude: -75, latitude: 40, height: 0 },
    {
      buildingLevelHeight: 3,
      defaultBuildingHeight: 8,
      includeMinorPaths: true,
      buildingCollisions: true,
      seed: 1,
      visualStyle: "clean",
    },
    overrides,
  );
}
describe("intersection road signs", () => {
  it("labels a four-way junction once, excluding dead ends", () => {
    const signs = roadSignLocations(plan());
    expect(signs).toHaveLength(1);
    expect(signs[0]?.names).toEqual(["Main Street", "Oak Avenue"]);
    expect(Math.abs(signs[0]!.x)).toBeGreaterThan(3.5);
    expect(signs[0]?.y).toBe(0);
  });
  it("does not invent names or label same-name splits", () => {
    expect(
      roadSignLocations(
        plan(
          streets.map((street) => ({
            ...street,
            tags: { ...street.tags, name: "Main Street" },
          })),
        ),
      ),
    ).toEqual([]);
    expect(
      roadSignLocations(
        plan(
          streets.map((street) => ({
            ...street,
            tags: { ...street.tags, name: " " },
          })),
        ),
      ),
    ).toEqual([]);
    const unnamed = structuredClone(streets);
    unnamed[1]!.tags.name = "";
    expect(roadSignLocations(plan(unnamed))[0]?.names).toEqual(["Main Street"]);
  });
  it("respects hidden roads and width overrides", () => {
    expect(
      roadSignLocations(
        plan(streets, [
          {
            targetId: "b",
            operation: "set-visible",
            payloadVersion: 1,
            payload: { visible: false },
          },
        ]),
      ),
    ).toEqual([]);
    const signs = roadSignLocations(
      plan(streets, [
        {
          targetId: "a",
          operation: "set-width",
          payloadVersion: 1,
          payload: { width: 20 },
        },
      ]),
    );
    expect(Math.abs(signs[0]!.x)).toBeGreaterThan(10);
  });
  it("does not label crossings on different layers", () => {
    const layered = structuredClone(streets);
    layered[1]!.facts.layer = 1;
    layered[1]!.tags.layer = "1";
    layered[1]!.tags.bridge = "yes";
    expect(roadSignLocations(plan(layered))).toEqual([]);
  });
});
