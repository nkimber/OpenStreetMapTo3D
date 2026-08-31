import { describe, expect, it } from "vitest";
import type { GenerationSettings, NormalizedFeature } from "@osm3d/contracts";
import {
  buildWorldPlan,
  estimateBuildingHeight,
  estimateRoadWidth,
} from "./index.js";

const settings: GenerationSettings = {
  buildingLevelHeight: 3,
  defaultBuildingHeight: 8,
  includeMinorPaths: true,
  buildingCollisions: true,
  seed: 1,
  visualStyle: "clean",
};

function feature(
  kind: "building" | "road",
  facts: NormalizedFeature["facts"],
): NormalizedFeature {
  return {
    sourceId: "osm:way:1",
    sourceType: "way",
    kind,
    geometry:
      kind === "road"
        ? {
            type: "LineString",
            coordinates: [
              [-75, 40],
              [-75, 40.1],
            ],
          }
        : {
            type: "Polygon",
            coordinates: [
              [
                [-75, 40],
                [-74.9, 40],
                [-74.9, 40.1],
                [-75, 40],
              ],
            ],
          },
    tags: kind === "road" ? { highway: "residential" } : { building: "house" },
    facts,
    warnings: [],
  };
}

describe("world generation defaults", () => {
  it("prefers explicit building height over levels", () => {
    expect(
      estimateBuildingHeight(
        feature("building", { height: 12, levels: 2 }),
        settings,
      ),
    ).toEqual({
      height: 12,
      source: "source",
    });
  });

  it("uses lane count before road class defaults", () => {
    expect(estimateRoadWidth(feature("road", { lanes: 2 }))).toBe(6.4);
  });

  it("applies overrides without mutating source facts", () => {
    const building = feature("building", { levels: 2 });
    const plan = buildWorldPlan(
      [building],
      { longitude: -75, latitude: 40, height: 0 },
      settings,
      [
        {
          targetId: building.sourceId,
          operation: "set-height",
          payloadVersion: 1,
          payload: { height: 18 },
        },
      ],
    );
    expect(plan.buildings[0]?.height).toBe(18);
    expect(building.facts.levels).toBe(2);
  });

  it("excludes hidden features from generated geometry", () => {
    const road = feature("road", {});
    const plan = buildWorldPlan(
      [road],
      { longitude: -75, latitude: 40, height: 0 },
      settings,
      [
        {
          targetId: road.sourceId,
          operation: "set-visible",
          payloadVersion: 1,
          payload: { visible: false },
        },
      ],
    );
    expect(plan.roads).toHaveLength(0);
    expect(plan.featureCount).toBe(1);
  });
});
