import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { BuildingPlan } from "@osm3d/worldgen";
import {
  buildingAppearance,
  createBuildingVisual,
  roofSurface,
} from "./buildingVisual.js";

const rectangle = [
  { x: 0, z: 0 },
  { x: 12, z: 0 },
  { x: 12, z: 8 },
  { x: 0, z: 8 },
  { x: 0, z: 0 },
];
const plan = (rings = [rectangle]): BuildingPlan => ({
  planId: "building:test:0",
  sourceId: "way/42",
  height: 8,
  heightSource: "fallback",
  baseHeight: 17,
  rings,
  buildingType: "house",
});
function area(positions: number[]) {
  let result = 0;
  for (let i = 0; i < positions.length; i += 9)
    result +=
      Math.abs(
        (positions[i + 3]! - positions[i]!) *
          (positions[i + 8]! - positions[i + 2]!) -
          (positions[i + 6]! - positions[i]!) *
            (positions[i + 5]! - positions[i + 2]!),
      ) / 2;
  return result;
}
describe("building appearance", () => {
  it("retains colorful mode without overriding an explicit facade color", () => {
    const colorOf = (building: BuildingPlan, colorful: boolean) =>
      (
        (createBuildingVisual(building, colorful)!.children[0] as THREE.Mesh)
          .material as THREE.MeshStandardMaterial
      ).color.getHexString();
    expect(colorOf(plan(), true)).not.toBe(colorOf(plan(), false));
    expect(
      colorOf(
        { ...plan(), appearanceTags: { "building:colour": "#123456" } },
        true,
      ),
    ).toBe("123456");
  });
  it("is deterministic and honors supported OSM appearance tags", () => {
    expect(buildingAppearance(plan())).toEqual(buildingAppearance(plan()));
    expect(
      buildingAppearance({
        ...plan(),
        appearanceTags: {
          "roof:shape": "gabled",
          "roof:height": "2",
          "building:colour": "#123456",
          "building:material": "brick",
        },
      }),
    ).toMatchObject({
      roof: "gabled",
      rise: 2,
      eaves: 6,
      wallColor: "#123456",
      finish: "brick",
    });
  });
  it("falls back safely for unsupported roofs and invalid colors", () => {
    expect(
      buildingAppearance({
        ...plan(),
        appearanceTags: {
          "roof:shape": "dome",
          "building:colour": "not-a-color",
        },
      }),
    ).toMatchObject({ roof: "flat", rise: 0 });
  });
  for (const shape of ["gabled", "hipped", "flat"]) {
    it(`keeps ${shape} roof area, holes and height bounded`, () => {
      const hole = [
        { x: 3, z: 2 },
        { x: 3, z: 6 },
        { x: 9, z: 6 },
        { x: 9, z: 2 },
        { x: 3, z: 2 },
      ];
      const building = {
        ...plan([rectangle, hole]),
        appearanceTags: { "roof:shape": shape },
      };
      const surface = roofSurface(building);
      expect(area(surface.positions)).toBeCloseTo(72, 5);
      surface.positions.forEach((v, i) => {
        expect(Number.isFinite(v)).toBe(true);
        if (i % 3 === 1) {
          expect(v).toBeGreaterThanOrEqual(surface.appearance.eaves - 1e-8);
          expect(v).toBeLessThanOrEqual(8 + 1e-8);
        }
      });
    });
  }
  it("does not bridge a concave footprint", () => {
    const ring = [
      { x: 0, z: 0 },
      { x: 12, z: 0 },
      { x: 12, z: 4 },
      { x: 4, z: 4 },
      { x: 4, z: 8 },
      { x: 0, z: 8 },
      { x: 0, z: 0 },
    ];
    expect(area(roofSurface(plan([ring])).positions)).toBeCloseTo(64, 5);
  });
  it("keeps feature selection on every mesh and limits detail draw calls", () => {
    const group = createBuildingVisual(plan())!;
    expect(group.position.y).toBeCloseTo(17.02);
    const meshes: THREE.Mesh[] = [];
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        meshes.push(object);
        expect(object.userData.sourceId).toBe("way/42");
      }
    });
    expect(meshes).toHaveLength(3);
    expect(group.children.some((child) => child instanceof THREE.LOD)).toBe(
      true,
    );
  });
});
