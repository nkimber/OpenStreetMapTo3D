import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import {
  buildWorldPlan,
  sampleTerrainPlan,
  type WorldPlan,
  type TerrainChunkPlan,
} from "@osm3d/worldgen";
import type {
  ElevationSnapshot,
  GenerationSettings,
  NormalizedFeature,
  WorldOverride,
} from "@osm3d/contracts";
import {
  terrainCollider,
  terrainGeometry,
  TerrainRuntime,
} from "./terrainRuntime.js";

const bounds = {
  west: -75.0002,
  south: 39.9998,
  east: -74.9998,
  north: 40.0002,
};
const elevation: ElevationSnapshot = {
  schemaVersion: 1,
  provider: "fixture",
  dataset: "runtime",
  retrievedAt: "2026-01-01T00:00:00Z",
  bounds,
  columns: 2,
  rows: 2,
  spacingMeters: { eastWest: 34, northSouth: 44 },
  heights: [100, 103, 108, 101],
  minHeight: 100,
  maxHeight: 108,
  verticalDatum: "test",
  units: "meters",
  contentHash: "d".repeat(64),
  attribution: { text: "test", url: "https://example.test", license: "test" },
};
const settings: GenerationSettings = {
  buildingLevelHeight: 3,
  defaultBuildingHeight: 8,
  includeMinorPaths: true,
  buildingCollisions: true,
  seed: 1,
  visualStyle: "clean",
};
const features: NormalizedFeature[] = [
  {
    sourceId: "road",
    sourceType: "way",
    kind: "road",
    geometry: {
      type: "LineString",
      coordinates: [
        [-75.00017, 40],
        [-74.99983, 40],
      ],
    },
    tags: { highway: "residential", width: "6" },
    facts: { width: 6 },
    warnings: [],
  },
  {
    sourceId: "park",
    sourceType: "way",
    kind: "land",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-75.0002, 39.9998],
          [-74.9998, 39.9998],
          [-74.9998, 40.0002],
          [-75.0002, 40.0002],
          [-75.0002, 39.9998],
        ],
      ],
    },
    tags: { landuse: "park" },
    facts: {},
    warnings: [],
  },
];
function plan(overrides: WorldOverride[] = [], dem = elevation): WorldPlan {
  return buildWorldPlan(
    features,
    { longitude: -75, latitude: 40, height: 0 },
    settings,
    overrides,
    { bounds, elevation: dem, chunkSize: 32, terrainCellsPerChunk: 8 },
  );
}
const ray = (x: number, z: number) =>
  new RAPIER.Ray({ x, y: 30, z }, { x: 0, y: -1, z: 0 });

describe("terrain scene and physics replacement", () => {
  it("matches render, sampler and heightfield for a nonplanar cell", async () => {
    await RAPIER.init();
    const chunk: TerrainChunkPlan = {
      id: "cell",
      x: 0,
      z: 0,
      rows: 2,
      columns: 2,
      heights: [0, 0, 0, 4],
      bounds: { minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
      minHeight: 0,
      maxHeight: 4,
    };
    const terrain = { ...plan().terrain!, chunks: [chunk] };
    const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    physics.createCollider(terrainCollider(chunk));
    physics.step();
    const mesh = new THREE.Mesh(
      terrainGeometry(chunk),
      new THREE.MeshBasicMaterial(),
    );
    for (const [x, z] of [
      [0.25, 0.25],
      [0.75, 0.75],
      [0.3, 0.8],
    ]) {
      const expected = sampleTerrainPlan(terrain, x!, z!);
      const hit = physics.castRay(ray(x!, z!), 50, true);
      expect(30 - hit!.timeOfImpact).toBeCloseTo(expected, 4);
      const visible = new THREE.Raycaster(
        new THREE.Vector3(x!, 30, z!),
        new THREE.Vector3(0, -1, 0),
      ).intersectObject(mesh);
      expect(visible[0]!.point.y).toBeCloseTo(expected, 4);
    }
    mesh.geometry.dispose();
    mesh.material.dispose();
    physics.free();
  });

  it("has no terrain or park surface inside pavement and matches shoulders to collision", async () => {
    await RAPIER.init();
    const world = plan();
    const scene = new THREE.Scene();
    const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const runtime = new TerrainRuntime(scene, physics);
    runtime.sync(world, false);
    scene.updateMatrixWorld(true);
    physics.step();
    // Only terrain meshes exist: park polygons are represented by vertex colors.
    expect(scene.children).toHaveLength(world.terrain!.chunks.length);
    for (const x of [-10, 0, 10]) {
      expect(physics.castRay(ray(x, 0), 60, true)).toBeNull();
      const hits = new THREE.Raycaster(
        new THREE.Vector3(x, 30, 0),
        new THREE.Vector3(0, -1, 0),
      ).intersectObjects(scene.children);
      expect(hits).toHaveLength(0);
    }
    for (const [x, z] of [
      [-6, 3.01],
      [2, -3.01],
      [0, 5],
      [7, 7],
      [-12, -6],
    ]) {
      const hit = physics.castRay(ray(x!, z!), 60, true);
      const visible = new THREE.Raycaster(
        new THREE.Vector3(x!, 30, z!),
        new THREE.Vector3(0, -1, 0),
      ).intersectObjects(scene.children);
      expect(
        hit,
        `shoulder at ${x},${z}; road width ${world.roads[0]!.width}`,
      ).not.toBeNull();
      expect(visible.length).toBeGreaterThan(0);
      expect(30 - hit!.timeOfImpact).toBeCloseTo(visible[0]!.point.y, 3);
      expect(30 - hit!.timeOfImpact).toBeCloseTo(
        sampleTerrainPlan(world.terrain, x!, z!),
        3,
      );
    }
    for (const surface of [
      ...world.roads.map((road) => road.mesh),
      ...world.junctions.map((junction) => junction.mesh),
    ])
      physics.createCollider(
        RAPIER.ColliderDesc.trimesh(
          new Float32Array(surface.positions),
          new Uint32Array(surface.indices),
        ),
      );
    physics.step();
    for (const x of [-10, 0, 10])
      expect(
        30 - physics.castRay(ray(x, 0), 60, true)!.timeOfImpact,
      ).toBeCloseTo(sampleTerrainPlan(world.terrain, x, 0), 3);
    physics.free();
  });

  it("replaces both sides of edited seams, restores hidden roads, and avoids collider leaks", async () => {
    await RAPIER.init();
    const scene = new THREE.Scene();
    const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const runtime = new TerrainRuntime(scene, physics);
    const original = plan();
    runtime.sync(original, false);
    physics.step();
    const count = physics.colliders.len();
    const before = scene.children.slice();
    const wide = plan([
      {
        targetId: "road",
        operation: "set-width",
        payloadVersion: 1,
        payload: { width: 12 },
      },
    ]);
    const changed = runtime.sync(wide, false);
    physics.step();
    expect(changed).toContain("terrain:-1:-1");
    expect(changed).toContain("terrain:0:0");
    expect(physics.colliders.len()).toBe(count);
    expect(physics.castRay(ray(0, 5), 60, true)).toBeNull();
    const untouched = original.terrain!.chunks.find(
      (chunk) => !changed.includes(chunk.id),
    )!;
    expect(scene.getObjectByName(untouched.id)).toBe(
      before.find((mesh) => mesh.name === untouched.id),
    );
    expect(runtime.sync(wide, false)).toHaveLength(0);
    const hidden = plan([
      {
        targetId: "road",
        operation: "set-visible",
        payloadVersion: 1,
        payload: { visible: false },
      },
    ]);
    runtime.sync(hidden, false);
    physics.step();
    expect(physics.castRay(ray(0, 0), 60, true)).not.toBeNull();
    runtime.sync(original, false);
    physics.step();
    expect(physics.castRay(ray(0, 0), 60, true)).toBeNull();
    expect(physics.colliders.len()).toBe(count);
    const changedDem = plan([], {
      ...elevation,
      heights: [100, 100, 120, 120],
      contentHash: "e".repeat(64),
    });
    expect(runtime.sync(changedDem, false).length).toBeGreaterThan(0);
    physics.step();
    expect(
      30 - physics.castRay(ray(10, 15), 60, true)!.timeOfImpact,
    ).toBeCloseTo(sampleTerrainPlan(changedDem.terrain, 10, 15), 3);
    physics.free();
  });
});
