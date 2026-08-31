import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { sampleTerrainPlan, type TerrainPlan } from "@osm3d/worldgen";

describe("Rapier terrain heightfield", () => {
  it("matches the x-major terrain plan used by the visual mesh", async () => {
    await RAPIER.init();
    const heights = [0, 1, 2, 2, 3, 4, 4, 5, 6];
    const terrain: TerrainPlan = {
      cellsPerChunk: 2,
      referenceHeight: 0,
      sourceMinHeight: 0,
      sourceMaxHeight: 6,
      provider: "fixture",
      dataset: "physics-test",
      verticalDatum: "local",
      chunks: [
        {
          id: "terrain:0:0",
          x: 0,
          z: 0,
          rows: 3,
          columns: 3,
          heights,
          bounds: { minX: -1, minZ: -1, maxX: 1, maxZ: 1 },
          minHeight: 0,
          maxHeight: 6,
        },
      ],
    };
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(2, 2, new Float32Array(heights), {
        x: 2,
        y: 1,
        z: 2,
      }),
      body,
    );
    world.step();
    for (const [x, z] of [
      [-0.75, -0.75],
      [0, 0],
      [0.75, 0.75],
    ] as const) {
      const hit = world.castRay(
        new RAPIER.Ray({ x, y: 20, z }, { x: 0, y: -1, z: 0 }),
        40,
        true,
      );
      expect(hit).toBeDefined();
      expect(20 - (hit?.timeOfImpact ?? 0)).toBeCloseTo(
        sampleTerrainPlan(terrain, x, z),
        3,
      );
    }
    world.free();
  });
});
