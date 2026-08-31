import { describe, expect, it } from "vitest";
import type { GenerationSettings } from "@osm3d/contracts";
import { representativeFixtures } from "./fixtures.js";
import { buildWorldPlan } from "./index.js";

const settings: GenerationSettings = {
  buildingLevelHeight: 3,
  defaultBuildingHeight: 8,
  includeMinorPaths: true,
  buildingCollisions: true,
  seed: 7,
  visualStyle: "clean",
};

const anchor = { longitude: -75, latitude: 40, height: 0 };

describe("representative neighborhood fixtures", () => {
  it("builds a T-junction and round cul-de-sac caps", () => {
    const plan = buildWorldPlan(
      representativeFixtures.suburban,
      anchor,
      settings,
    );
    expect(
      plan.junctions.some(
        (junction) =>
          junction.kind === "intersection" && junction.sourceIds.length === 2,
      ),
    ).toBe(true);
    expect(
      plan.junctions.filter((junction) => junction.kind === "end-cap").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("builds a dense four-way block across deterministic chunks", () => {
    const plan = buildWorldPlan(
      representativeFixtures.denseUrban,
      anchor,
      settings,
      [],
      { chunkSize: 128 },
    );
    expect(plan.buildings).toHaveLength(12);
    expect(plan.chunks.length).toBeGreaterThan(4);
    expect(
      plan.junctions.some(
        (junction) =>
          junction.kind === "intersection" && junction.sourceIds.length === 2,
      ),
    ).toBe(true);
  });

  it("creates finite connected geometry for a multi-bend road", () => {
    const plan = buildWorldPlan(
      representativeFixtures.curvedRoad,
      anchor,
      settings,
    );
    const curve = plan.roads[0];
    expect(curve?.mesh.positions).toHaveLength(30);
    expect(curve?.mesh.indices).toHaveLength(24);
    expect(curve?.mesh.positions.every(Number.isFinite)).toBe(true);
  });

  it("keeps bridge, tunnel, and ground nodes in separate vertical layers", () => {
    const plan = buildWorldPlan(
      representativeFixtures.layered,
      anchor,
      settings,
    );
    expect(new Set(plan.roads.map((road) => road.layer))).toEqual(
      new Set([-1, 0, 1]),
    );
    expect(
      plan.junctions.some(
        (junction) =>
          junction.sourceIds.includes("fixture:way:ground") &&
          junction.sourceIds.includes("fixture:way:bridge"),
      ),
    ).toBe(false);
    expect(
      plan.diagnostics.filter(
        (diagnostic) => diagnostic.code === "road.vertical-separation",
      ),
    ).toHaveLength(2);
  });
});
