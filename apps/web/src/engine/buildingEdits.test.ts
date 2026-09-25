import { describe, expect, it } from "vitest";
import {
  footprintSignature,
  type BuildingOpening,
  type NormalizedFeature,
  type WorldDefinition,
} from "@osm3d/contracts";
import { buildWorldPlan } from "@osm3d/worldgen";
import {
  automaticPath,
  exteriorWalls,
  nearestWall,
  openingPosition,
  routeBlocked,
  toLocal,
  toMap,
} from "./buildingEdits.js";
import {
  createCustomizationVisual,
  openingPanels,
} from "./buildingEditVisuals.js";
import { createBuildingVisual } from "./buildingVisual.js";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

const house: NormalizedFeature = {
  sourceId: "house",
  sourceType: "way",
  kind: "building",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-75, 40],
        [-74.9998, 40],
        [-74.9998, 40.00015],
        [-75, 40.00015],
        [-75, 40],
      ],
    ],
  },
  tags: { building: "house" },
  facts: {},
  warnings: [],
};
const road: NormalizedFeature = {
  sourceId: "road",
  sourceType: "way",
  kind: "road",
  geometry: {
    type: "LineString",
    coordinates: [
      [-75.001, 39.9998],
      [-74.999, 39.9998],
    ],
  },
  tags: { highway: "residential" },
  facts: {},
  warnings: [],
};
const definition = {
  world: {
    anchor: { longitude: -75, latitude: 40, height: 0 },
    settings: {
      buildingLevelHeight: 3,
      defaultBuildingHeight: 8,
      includeMinorPaths: true,
      buildingCollisions: true,
      seed: 1,
      visualStyle: "clean",
    },
  },
  features: [house, road],
  overrides: [],
} as unknown as WorldDefinition;
const plan = buildWorldPlan(
  definition.features,
  definition.world.anchor,
  definition.world.settings,
);
const opening: BuildingOpening = {
  id: "garage",
  kind: "garage",
  wall: exteriorWalls(house)[0]!,
  fraction: 0.5,
  cars: 3,
  width: 1,
  sill: 1,
  path: [],
};
describe("building editing geometry", () => {
  it("supports cars on the rendered driveway apron", async () => {
    await RAPIER.init();
    const openingWithPath = {
      ...opening,
      path: automaticPath(opening, "house", definition, plan),
    };
    const building = { ...plan.buildings[0]!, baseHeight: 1.5 };
    const visual = createCustomizationVisual(
      building,
      {
        sourceId: "house",
        revision: 0,
        footprint: footprintSignature(house.geometry),
        openings: [openingWithPath],
        appearance: {},
        boundaries: [],
        landscaping: [],
      },
      definition,
      plan,
      false,
    );
    const surface = visual.children.find(
      (item) => item.userData.route,
    ) as THREE.Mesh;
    const vertices = surface.geometry.getAttribute("position");
    expect(vertices.getY(0)).toBeCloseTo(building.baseHeight + 0.04, 5);
    expect(vertices.getY(1)).toBeCloseTo(building.baseHeight + 0.04, 5);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    try {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      world.createCollider(
        RAPIER.ColliderDesc.trimesh(
          new Float32Array(vertices.array),
          Uint32Array.from({ length: vertices.count }, (_, i) => i),
        ),
        body,
      );
      world.step();
      for (const index of [0, 18, vertices.count - 3]) {
        const x =
          (vertices.getX(index) +
            vertices.getX(index + 1) +
            vertices.getX(index + 2)) /
          3;
        const z =
          (vertices.getZ(index) +
            vertices.getZ(index + 1) +
            vertices.getZ(index + 2)) /
          3;
        const y =
          (vertices.getY(index) +
            vertices.getY(index + 1) +
            vertices.getY(index + 2)) /
          3;
        const hit = world.castRay(
          new RAPIER.Ray({ x, y: 20, z }, { x: 0, y: -1, z: 0 }),
          40,
          true,
        );
        expect(hit).not.toBeNull();
        expect(20 - hit!.timeOfImpact).toBeCloseTo(y, 4);
      }
    } finally {
      world.free();
    }
  });
  it("anchors doors to the same geographic wall in different worlds", () => {
    const point = openingPosition(opening, definition);
    expect(toMap(point, definition)[0]).toBeCloseTo(-74.9999, 6);
    const shifted = {
      ...definition,
      world: {
        ...definition.world,
        anchor: { longitude: -75.002, latitude: 40.001, height: 0 },
      },
    };
    expect(toMap(openingPosition(opening, shifted), shifted)[0]).toBeCloseTo(
      -74.9999,
      6,
    );
    expect(nearestWall(house, point, definition)?.fraction).toBeCloseTo(0.5);
  });
  it("creates a clear driveway to the road edge for all garage widths", () => {
    for (const cars of [1, 2, 3] as const) {
      const path = automaticPath(
        { ...opening, cars },
        "house",
        definition,
        plan,
      );
      expect(path.length).toBeGreaterThanOrEqual(3);
      const local = path.map((p) => toLocal(p, definition));
      expect(routeBlocked(local, plan.buildings, cars * 2.7, "house")).toBe(
        false,
      );
      expect(local.at(-1)!.z).toBeGreaterThan(15);
      expect(local.at(-1)!.z).toBeLessThan(22);
    }
  });
  it("rejects a route through a neighboring building, including clearance", () => {
    const neighbor = {
      ...plan.buildings[0]!,
      sourceId: "neighbor",
      rings: [
        [
          { x: 0, z: 5 },
          { x: 15, z: 5 },
          { x: 15, z: 15 },
          { x: 0, z: 15 },
          { x: 0, z: 5 },
        ],
      ],
    };
    expect(
      routeBlocked(
        [
          { x: 8, z: 0 },
          { x: 8, z: 22 },
        ],
        [neighbor],
        5.4,
        "house",
      ),
    ).toBe(true);
    expect(
      routeBlocked(
        [
          { x: 17, z: 0 },
          { x: 17, z: 22 },
        ],
        [neighbor],
        5.4,
        "house",
      ),
    ).toBe(true);
    expect(
      routeBlocked(
        [
          { x: 20, z: 0 },
          { x: 20, z: 22 },
        ],
        [neighbor],
        5.4,
        "house",
      ),
    ).toBe(false);
    const detourObstacle = {
      ...neighbor,
      rings: [
        [
          { x: 4, z: 10 },
          { x: 10, z: 10 },
          { x: 10, z: 13 },
          { x: 4, z: 13 },
          { x: 4, z: 10 },
        ],
      ],
    };
    const path = automaticPath(opening, "house", definition, {
      ...plan,
      buildings: [...plan.buildings, detourObstacle],
    });
    expect(
      routeBlocked(
        path.map((p) => toLocal(p, definition)),
        [...plan.buildings, detourObstacle],
        8.1,
        "house",
      ),
    ).toBe(false);
  });
  it("reports missing accessible roads", () => {
    expect(() =>
      automaticPath(opening, "house", definition, { ...plan, roads: [] }),
    ).toThrow(/No clear/);
    expect(() =>
      automaticPath(opening, "house", definition, {
        ...plan,
        roads: plan.roads.map((r) => ({ ...r, bridge: true })),
      }),
    ).toThrow(/No clear/);
  });
  it("builds finite facade panels and terrain-following route meshes", () => {
    const value = {
      sourceId: "house",
      revision: 0,
      footprint: footprintSignature(house.geometry),
      openings: [
        { ...opening, path: automaticPath(opening, "house", definition, plan) },
      ],
      appearance: {},
      boundaries: [],
      landscaping: [],
    };
    const visuals = createCustomizationVisual(
      plan.buildings[0]!,
      value,
      definition,
      plan,
      true,
    );
    const houseVisual = createBuildingVisual(
      plan.buildings[0]!,
      false,
      openingPanels(value, definition),
    );
    visuals.add(houseVisual!);
    let count = 0;
    visuals.traverse((item) => {
      if (item instanceof THREE.Mesh) {
        count++;
        expect(
          Array.from(item.geometry.getAttribute("position").array).every(
            Number.isFinite,
          ),
        ).toBe(true);
      }
    });
    expect(count).toBeGreaterThan(10);
  });
});
