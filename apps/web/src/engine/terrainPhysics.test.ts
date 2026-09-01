import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import type { ElevationSnapshot } from "@osm3d/contracts";
import {
  buildTerrainPlan,
  ROAD_TERRAIN_CLEARANCE_METERS,
  sampleTerrainPlan,
  type TerrainPlan,
} from "@osm3d/worldgen";

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

  it("keeps the road collider above its graded terrain corridor", async () => {
    await RAPIER.init();
    const bounds = {
      west: -75.0001,
      south: 39.9999,
      east: -74.9999,
      north: 40.0001,
    };
    const elevation: ElevationSnapshot = {
      schemaVersion: 1,
      provider: "fixture",
      dataset: "road-collider-test",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      bounds,
      columns: 2,
      rows: 2,
      spacingMeters: { eastWest: 20, northSouth: 20 },
      heights: [100, 100, 100, 100],
      verticalDatum: "test datum",
      units: "meters",
      minHeight: 100,
      maxHeight: 100,
      contentHash: "c".repeat(64),
      attribution: {
        text: "test elevation",
        url: "https://example.test/elevation",
        license: "test",
      },
    };
    const roadHeight = -2;
    const terrain = buildTerrainPlan({
      bounds,
      anchor: { longitude: -75, latitude: 40, height: 0 },
      elevation,
      chunkSize: 256,
      cellsPerChunk: 64,
      roads: [
        {
          points: [
            { x: -20, y: roadHeight, z: 0 },
            { x: 20, y: roadHeight, z: 0 },
          ],
          width: 6,
          tunnel: false,
        },
      ],
    });
    expect(sampleTerrainPlan(terrain, 0, 0)).toBeCloseTo(
      roadHeight - ROAD_TERRAIN_CLEARANCE_METERS,
      3,
    );

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    for (const chunk of terrain.chunks) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          (chunk.bounds.minX + chunk.bounds.maxX) / 2,
          0,
          (chunk.bounds.minZ + chunk.bounds.maxZ) / 2,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.heightfield(
          chunk.columns - 1,
          chunk.rows - 1,
          new Float32Array(chunk.heights),
          {
            x: chunk.bounds.maxX - chunk.bounds.minX,
            y: 1,
            z: chunk.bounds.maxZ - chunk.bounds.minZ,
          },
        ),
        body,
      );
    }
    const roadBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(
        new Float32Array([
          -20,
          roadHeight,
          -3,
          -20,
          roadHeight,
          3,
          20,
          roadHeight,
          -3,
          20,
          roadHeight,
          3,
        ]),
        new Uint32Array([0, 2, 1, 2, 3, 1]),
      ),
      roadBody,
    );
    world.step();

    const originHeight = 10;
    const hit = world.castRay(
      new RAPIER.Ray({ x: 0, y: originHeight, z: 0 }, { x: 0, y: -1, z: 0 }),
      30,
      true,
    );
    expect(hit).toBeDefined();
    expect(originHeight - (hit?.timeOfImpact ?? 0)).toBeCloseTo(roadHeight, 3);
    world.free();
  });
});
