import RAPIER from "@dimforge/rapier3d-compat";
import { defaultVehicleConfig } from "@osm3d/simulation";
import type { BuildingPlan } from "@osm3d/worldgen";
import { beforeAll, describe, expect, it } from "vitest";
import { buildingCollider, buildingCollisionMesh } from "./buildingPhysics.js";

const concaveBuilding: BuildingPlan = {
  planId: "building:concave",
  sourceId: "concave",
  height: 8,
  heightSource: "source",
  baseHeight: 1.5,
  rings: [
    [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 4 },
      { x: 4, z: 4 },
      { x: 4, z: 10 },
      { x: 0, z: 10 },
      { x: 0, z: 0 },
    ],
  ],
};

describe("building collision geometry", () => {
  beforeAll(async () => RAPIER.init());

  it("uses the footprint instead of filling its axis-aligned bounds", () => {
    const mesh = buildingCollisionMesh(concaveBuilding);
    expect(mesh).toBeDefined();
    expect(mesh!.vertices).toHaveLength(6 * 2 * 3);

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    try {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          0,
          concaveBuilding.baseHeight,
          0,
        ),
      );
      world.createCollider(buildingCollider(concaveBuilding)!, body);
      world.step();
      const downward = { x: 0, y: -1, z: 0 };
      const inside = world.castRay(
        new RAPIER.Ray({ x: 2, y: 20, z: 8 }, downward),
        30,
        true,
      );
      const clearConcavity = world.castRay(
        new RAPIER.Ray({ x: 8, y: 20, z: 8 }, downward),
        30,
        true,
      );

      expect(inside).not.toBeNull();
      expect(20 - inside!.timeOfImpact).toBeCloseTo(9.5, 4);
      expect(clearConcavity).toBeNull();

      const [halfX, halfY, halfZ] = defaultVehicleConfig.chassisHalfExtents;
      const chassis = new RAPIER.Cuboid(halfX, halfY, halfZ);
      const rotation = { x: 0, y: 0, z: 0, w: 1 };
      const throughConcavity = world.castShape(
        { x: 6, y: 2.5, z: 7 },
        rotation,
        { x: 1, y: 0, z: 0 },
        chassis,
        0,
        3,
        true,
      );
      const intoOuterWall = world.castShape(
        { x: 12, y: 2.5, z: 1 },
        rotation,
        { x: -1, y: 0, z: 0 },
        chassis,
        0,
        4,
        true,
      );

      expect(throughConcavity).toBeNull();
      expect(intoOuterWall).not.toBeNull();
      expect(intoOuterWall!.time_of_impact).toBeCloseTo(1.05, 4);
    } finally {
      world.free();
    }
  });

  it("keeps courtyard holes open", () => {
    const building: BuildingPlan = {
      ...concaveBuilding,
      planId: "building:courtyard",
      sourceId: "courtyard",
      rings: [
        [
          { x: 0, z: 0 },
          { x: 12, z: 0 },
          { x: 12, z: 12 },
          { x: 0, z: 12 },
          { x: 0, z: 0 },
        ],
        [
          { x: 4, z: 4 },
          { x: 4, z: 8 },
          { x: 8, z: 8 },
          { x: 8, z: 4 },
          { x: 4, z: 4 },
        ],
      ],
    };
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    try {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      world.createCollider(buildingCollider(building)!, body);
      world.step();
      const ray = (x: number, z: number) =>
        world.castRay(
          new RAPIER.Ray({ x, y: 20, z }, { x: 0, y: -1, z: 0 }),
          30,
          true,
        );

      expect(ray(2, 6)).not.toBeNull();
      expect(ray(6, 6)).toBeNull();
    } finally {
      world.free();
    }
  });
});
