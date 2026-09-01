import { describe, expect, it } from "vitest";
import type {
  ElevationSnapshot,
  GenerationSettings,
  NormalizedFeature,
} from "@osm3d/contracts";
import {
  buildTerrainPlan,
  buildWorldPlan,
  ROAD_TERRAIN_CLEARANCE_METERS,
  resolveSpawnPose,
  sampleElevationSnapshot,
  sampleTerrainPlan,
} from "./index.js";

const bounds = {
  west: -75.003,
  south: 39.997,
  east: -74.997,
  north: 40.003,
};

const elevation: ElevationSnapshot = {
  schemaVersion: 1,
  provider: "fixture",
  dataset: "test slope",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  bounds,
  columns: 3,
  rows: 3,
  spacingMeters: { eastWest: 256, northSouth: 333 },
  heights: [100, 102, 104, 110, 112, 114, 120, 122, 124],
  verticalDatum: "test datum",
  units: "meters",
  minHeight: 100,
  maxHeight: 124,
  contentHash: "a".repeat(64),
  attribution: {
    text: "test elevation",
    url: "https://example.test/elevation",
    license: "test",
  },
};

const corridorBounds = {
  west: -75.0001,
  south: 39.9999,
  east: -74.9999,
  north: 40.0001,
};

const flatElevation: ElevationSnapshot = {
  ...elevation,
  dataset: "flat corridor test",
  bounds: corridorBounds,
  columns: 2,
  rows: 2,
  spacingMeters: { eastWest: 20, northSouth: 20 },
  heights: [100, 100, 100, 100],
  minHeight: 100,
  maxHeight: 100,
};

function corridorTerrain(input: {
  roads?: Array<{
    points: Array<{ x: number; y: number; z: number }>;
    width: number;
    tunnel: boolean;
  }>;
  junctions?: Array<{
    center: { x: number; y: number; z: number };
    radius: number;
  }>;
}) {
  return buildTerrainPlan({
    bounds: corridorBounds,
    anchor: { longitude: -75, latitude: 40, height: 0 },
    elevation: flatElevation,
    chunkSize: 256,
    cellsPerChunk: 64,
    ...input,
  });
}

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
    sourceId: "fixture:road:hill",
    sourceType: "way",
    kind: "road",
    geometry: {
      type: "LineString",
      coordinates: [
        [-75, 39.9975],
        [-75, 40.0025],
      ],
    },
    tags: { highway: "residential", name: "Hill Road" },
    facts: {},
    warnings: [],
  },
  {
    sourceId: "fixture:building:hill",
    sourceType: "way",
    kind: "building",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-75.0003, 40.0018],
          [-74.9998, 40.0018],
          [-74.9998, 40.0022],
          [-75.0003, 40.0022],
          [-75.0003, 40.0018],
        ],
      ],
    },
    tags: { building: "house" },
    facts: {},
    warnings: [],
  },
];

describe("elevation-aware world generation", () => {
  it("bilinearly samples the immutable DEM grid", () => {
    expect(sampleElevationSnapshot(elevation, -75, 40)).toBeCloseTo(112, 6);
  });

  it("builds seam-identical terrain, uphill roads, and elevated building bases", () => {
    const plan = buildWorldPlan(
      features,
      { longitude: -75, latitude: 40, height: 0 },
      settings,
      [],
      { bounds, elevation, chunkSize: 256, terrainCellsPerChunk: 64 },
    );
    expect(plan.terrain?.chunks.length).toBeGreaterThan(1);
    const adjacent = plan.terrain?.chunks.find((left) =>
      plan.terrain?.chunks.some(
        (right) => right.z === left.z && right.x === left.x + 1,
      ),
    );
    const neighbor = adjacent
      ? plan.terrain?.chunks.find(
          (candidate) =>
            candidate.z === adjacent.z && candidate.x === adjacent.x + 1,
        )
      : undefined;
    expect(adjacent).toBeDefined();
    expect(neighbor).toBeDefined();
    for (let row = 0; row < (adjacent?.rows ?? 0); row += 1) {
      expect(
        adjacent?.heights[(adjacent.columns - 1) * adjacent.rows + row],
      ).toBe(neighbor?.heights[row]);
    }
    const road = plan.roads[0];
    expect(road?.points.length).toBeGreaterThan(20);
    expect(
      (road?.points.at(-1)?.y ?? 0) - (road?.points[0]?.y ?? 0),
    ).toBeGreaterThan(10);
    expect(plan.buildings[0]?.baseHeight).toBeGreaterThan(5);
    const spawn = resolveSpawnPose(plan, []);
    expect(Math.hypot(spawn.x, spawn.z)).toBeLessThan(0.1);
    expect(spawn.y).toBeGreaterThan(0);
    expect(Number.isFinite(spawn.pitch)).toBe(true);
    for (const point of road?.points.filter((_, index) => index % 8 === 0) ??
      []) {
      expect(
        point.y - sampleTerrainPlan(plan.terrain, point.x, point.z),
      ).toBeGreaterThan(0.015);
    }
  });

  it("cuts and fills ground-road corridors while returning to the source terrain", () => {
    const raisedRoad = {
      points: [
        { x: -20, y: 5, z: 0 },
        { x: 20, y: 5, z: 0 },
      ],
      width: 6,
      tunnel: false,
    };
    const raised = corridorTerrain({ roads: [raisedRoad] });
    expect(sampleTerrainPlan(raised, 0, 0)).toBeCloseTo(
      5 - ROAD_TERRAIN_CLEARANCE_METERS,
      3,
    );
    expect(sampleTerrainPlan(raised, 0, 7)).toBeGreaterThan(0);
    expect(sampleTerrainPlan(raised, 0, 7)).toBeLessThan(5);
    expect(sampleTerrainPlan(raised, 0, 16)).toBeCloseTo(0, 6);

    const lowered = corridorTerrain({
      roads: [
        {
          ...raisedRoad,
          points: raisedRoad.points.map((point) => ({ ...point, y: -5 })),
        },
      ],
    });
    expect(sampleTerrainPlan(lowered, 0, 0)).toBeCloseTo(
      -5 - ROAD_TERRAIN_CLEARANCE_METERS,
      3,
    );
    expect(sampleTerrainPlan(lowered, 0, 7)).toBeLessThan(-4.9);
    expect(sampleTerrainPlan(lowered, 0, 16)).toBeCloseTo(0, 6);
  });

  it("grades junction discs and keeps tunnels cut-only", () => {
    const junction = corridorTerrain({
      junctions: [{ center: { x: 0, y: 3, z: 0 }, radius: 5 }],
    });
    expect(sampleTerrainPlan(junction, 0, 0)).toBeCloseTo(
      3 - ROAD_TERRAIN_CLEARANCE_METERS,
      3,
    );

    const raisedTunnel = corridorTerrain({
      roads: [
        {
          points: [
            { x: -20, y: 5, z: 0 },
            { x: 20, y: 5, z: 0 },
          ],
          width: 6,
          tunnel: true,
        },
      ],
    });
    expect(sampleTerrainPlan(raisedTunnel, 0, 0)).toBeCloseTo(0, 6);

    const loweredTunnel = corridorTerrain({
      roads: [
        {
          points: [
            { x: -20, y: -5, z: 0 },
            { x: 20, y: -5, z: 0 },
          ],
          width: 6,
          tunnel: true,
        },
      ],
    });
    expect(sampleTerrainPlan(loweredTunnel, 0, 0)).toBeCloseTo(
      -5 - ROAD_TERRAIN_CLEARANCE_METERS,
      3,
    );
  });

  it("leaves bridge terrain untouched beneath the raised deck", () => {
    const bridgeFeatures = features.map((feature) =>
      feature.kind === "road"
        ? { ...feature, tags: { ...feature.tags, bridge: "yes" } }
        : feature,
    );
    const plan = buildWorldPlan(
      bridgeFeatures,
      { longitude: -75, latitude: 40, height: 0 },
      settings,
      [],
      { bounds, elevation, terrainCellsPerChunk: 64 },
    );
    const road = plan.roads[0];
    const midpoint = road?.points[Math.floor((road.points.length - 1) / 2)];
    expect(midpoint).toBeDefined();
    expect(
      (midpoint?.y ?? 0) -
        sampleTerrainPlan(plan.terrain, midpoint?.x ?? 0, midpoint?.z ?? 0),
    ).toBeGreaterThan(2);
  });

  it("includes the elevation snapshot identity in the deterministic build hash", () => {
    const first = buildWorldPlan(
      features,
      { longitude: -75, latitude: 40, height: 0 },
      settings,
      [],
      { bounds, elevation, terrainCellsPerChunk: 8 },
    );
    const changed = buildWorldPlan(
      features,
      { longitude: -75, latitude: 40, height: 0 },
      settings,
      [],
      {
        bounds,
        elevation: { ...elevation, contentHash: "b".repeat(64) },
        terrainCellsPerChunk: 8,
      },
    );
    expect(changed.buildHash).not.toBe(first.buildHash);
  });
});
