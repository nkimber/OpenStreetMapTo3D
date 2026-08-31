import { describe, expect, it } from "vitest";
import type { GenerationSettings, NormalizedFeature } from "@osm3d/contracts";
import {
  affectedChunkIds,
  buildRoadSurface,
  buildWorldPlan,
  changedOverrideTargetIds,
  estimateBuildingHeight,
  estimateRoadWidth,
  resolveSpawnPose,
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

  it("builds a continuous mitered strip instead of isolated segment ribbons", () => {
    const surface = buildRoadSurface(
      [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
        { x: 30, z: -10 },
      ],
      8,
    );
    expect(surface.positions).toHaveLength(18);
    expect(surface.indices).toHaveLength(12);
    expect(surface.positions.every(Number.isFinite)).toBe(true);
  });

  it("creates deterministic chunks, intersections, and build hashes", () => {
    const first = feature("road", {});
    const second: NormalizedFeature = {
      ...feature("road", {}),
      sourceId: "osm:way:2",
      geometry: {
        type: "LineString",
        coordinates: [
          [-75.01, 40.05],
          [-75, 40.05],
          [-74.99, 40.05],
        ],
      },
    };
    first.geometry = {
      type: "LineString",
      coordinates: [
        [-75, 40],
        [-75, 40.05],
        [-75, 40.1],
      ],
    };
    const input = [first, second];
    const plan = buildWorldPlan(
      input,
      { longitude: -75, latitude: 40.05, height: 0 },
      settings,
      [],
      { sourceSnapshotId: "snapshot-1" },
    );
    const repeated = buildWorldPlan(
      input,
      { longitude: -75, latitude: 40.05, height: 0 },
      settings,
      [],
      { sourceSnapshotId: "snapshot-1" },
    );
    expect(plan.buildHash).toBe(repeated.buildHash);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(
      plan.junctions.some((junction) => junction.kind === "intersection"),
    ).toBe(true);
  });

  it("identifies only chunks touched by an override and preserves colon IDs", () => {
    const road = feature("road", {});
    const original = buildWorldPlan(
      [road],
      { longitude: -75, latitude: 40, height: 0 },
      settings,
    );
    const overrides = [
      {
        targetId: road.sourceId,
        operation: "set-width" as const,
        payloadVersion: 1,
        payload: { width: 11 },
      },
    ];
    const edited = buildWorldPlan(
      [road],
      { longitude: -75, latitude: 40, height: 0 },
      settings,
      overrides,
    );
    expect(changedOverrideTargetIds([], overrides)).toEqual([road.sourceId]);
    expect(affectedChunkIds(original, edited, [road.sourceId])).toEqual(
      expect.arrayContaining(original.featureChunks[road.sourceId] ?? []),
    );
    expect(edited.buildHash).not.toBe(original.buildHash);
  });

  it("snaps an exact spawn request to the selected road segment", () => {
    const road = feature("road", {});
    const plan = buildWorldPlan(
      [road],
      { longitude: -75, latitude: 40, height: 0 },
      settings,
    );
    const midpoint = plan.roads[0]?.points[0];
    expect(midpoint).toBeDefined();
    const pose = resolveSpawnPose(plan, [
      {
        targetId: road.sourceId,
        operation: "set-spawn",
        payloadVersion: 1,
        payload: { x: midpoint?.x ?? 0, z: -2_000 },
      },
    ]);
    expect(pose.sourceId).toBe(road.sourceId);
    expect(Number.isFinite(pose.yaw)).toBe(true);
  });
});
