import { describe, expect, it } from "vitest";
import type {
  ElevationSnapshot,
  GenerationSettings,
  NormalizedFeature,
  WorldOverride,
} from "@osm3d/contracts";
import { localToWgs84 } from "@osm3d/geo";
import { buildRoadSurface, buildWorldPlan, affectedChunkIds } from "./index.js";
import {
  buildTerrainPlan,
  sampleTerrainPlan,
  type TerrainPlan,
} from "./terrain.js";
import {
  combineSurfaces,
  meshTriangles,
  signedArea,
  SurfaceIndex,
  triangleHeight,
  type SurfaceMesh,
} from "./surface.js";

export const anchor = { longitude: -75, latitude: 40, height: 0 };
export const bounds = {
  west: -75.0002,
  south: 39.9998,
  east: -74.9998,
  north: 40.0002,
};
export const elevation: ElevationSnapshot = {
  schemaVersion: 1,
  provider: "fixture",
  dataset: "nonplanar clearance fixture",
  retrievedAt: "2026-01-01T00:00:00Z",
  bounds,
  columns: 3,
  rows: 3,
  spacingMeters: { eastWest: 17, northSouth: 22 },
  heights: [100, 104, 108, 110, 100, 112, 106, 108, 115],
  verticalDatum: "test",
  units: "meters",
  minHeight: 100,
  maxHeight: 115,
  contentHash: "c".repeat(64),
  attribution: { text: "test", url: "https://example.test", license: "test" },
};
export const settings: GenerationSettings = {
  buildingLevelHeight: 3,
  defaultBuildingHeight: 8,
  includeMinorPaths: true,
  buildingCollisions: true,
  seed: 1,
  visualStyle: "clean",
};
export function feature(
  id: string,
  points: Array<[number, number]>,
  tags: Record<string, string> = {},
): NormalizedFeature {
  return {
    sourceId: id,
    sourceType: "way",
    kind: "road",
    tags: { highway: "residential", width: "6", ...tags },
    facts: { width: Number(tags.width ?? 6) },
    warnings: [],
    geometry: {
      type: "LineString",
      coordinates: points.map(([east, north]) => {
        const p = localToWgs84({ east, north, up: 0 }, anchor);
        return [p.longitude, p.latitude];
      }),
    },
  };
}
const options = { bounds, elevation, chunkSize: 32, terrainCellsPerChunk: 8 };

function terrainIndex(terrain: TerrainPlan): SurfaceIndex {
  return new SurfaceIndex(
    combineSurfaces(
      terrain.chunks.flatMap((chunk) => (chunk.mesh ? [chunk.mesh] : [])),
    ),
  );
}
function assertPavementEmpty(terrain: TerrainPlan, road: SurfaceMesh): void {
  const ground = terrainIndex(terrain);
  for (const triangle of meshTriangles(road)) {
    // Interior samples across each triangle, including close to both road edges.
    for (const [u, v] of [
      [0.02, 0.02],
      [0.49, 0.49],
      [0.02, 0.96],
      [0.96, 0.02],
      [1 / 3, 1 / 3],
    ]) {
      const w = 1 - u! - v!;
      const x = triangle[0].x * u! + triangle[1].x * v! + triangle[2].x * w;
      const z = triangle[0].z * u! + triangle[1].z * v! + triangle[2].z * w;
      expect(
        ground.height(x, z),
        `terrain inside pavement at ${x},${z}`,
      ).toBeUndefined();
    }
  }
}

describe("road-constrained terrain", () => {
  it("keeps a higher neighboring corridor from burying a lower road", () => {
    const flat = {
      ...elevation,
      columns: 2,
      rows: 2,
      heights: [100, 100, 100, 100],
      minHeight: 100,
      maxHeight: 100,
    };
    const roads = [0, 2].map((y, index) => ({
      points: [
        { x: -20, y, z: index * 7 },
        { x: 20, y, z: index * 7 },
      ],
      width: 6,
      tunnel: false,
    }));
    const graded = buildTerrainPlan({
      ...options,
      cellsPerChunk: 8,
      anchor,
      elevation: flat,
      roads,
    });
    expect(sampleTerrainPlan(graded, 0, 0)).toBeLessThanOrEqual(-0.049);
    const roadSurface = combineSurfaces(
      roads.map((road) => buildRoadSurface(road.points, road.width)),
    );
    const cut = buildTerrainPlan({
      ...options,
      cellsPerChunk: 8,
      anchor,
      elevation: flat,
      roads,
      roadSurface,
    });
    assertPavementEmpty(cut, roadSurface);
    expect(sampleTerrainPlan(cut, 0, 0)).toBeCloseTo(0, 5);
    expect(sampleTerrainPlan(cut, 0, 7)).toBeCloseTo(2, 5);
  });

  it("clips diagonal bends and wide miter edges across terrain chunk seams", () => {
    const plan = buildWorldPlan(
      [
        feature(
          "curve",
          [
            [-30, -18],
            [-3, 8],
            [8, -8],
            [30, 20],
          ],
          { width: "10" },
        ),
      ],
      anchor,
      settings,
      [],
      options,
    );
    assertPavementEmpty(plan.terrain!, plan.roads[0]!.mesh);
    const roads = new SurfaceIndex(plan.terrain!.roadSurface!);
    for (const chunk of plan.terrain!.chunks) {
      for (const triangle of meshTriangles(
        chunk.mesh ?? { positions: [], indices: [] },
      )) {
        for (const p of triangle) {
          const roadHeight = roads.height(p.x, p.z);
          if (roadHeight !== undefined) expect(p.y).toBeCloseTo(roadHeight, 5);
        }
      }
    }
    // Each side independently interpolates shared boundary vertices.
    for (const left of plan.terrain!.chunks) {
      const right = plan.terrain!.chunks.find(
        (chunk) => chunk.x === left.x + 1 && chunk.z === left.z,
      );
      if (!right) continue;
      for (let z = left.bounds.minZ + 0.5; z < left.bounds.maxZ; z += 0.5) {
        const x = left.bounds.maxX;
        const a = sampleTerrainPlan({ ...plan.terrain!, chunks: [left] }, x, z);
        const b = sampleTerrainPlan(
          { ...plan.terrain!, chunks: [right] },
          x,
          z,
        );
        expect(
          a,
          `seam ${x},${z} ${left.id}/${right.id} meshes:${!!left.mesh}/${!!right.mesh}`,
        ).toBeCloseTo(b, 4);
      }
    }
  });

  it("preserves the area outside pavement without holes or duplicate terrain pieces", () => {
    const roadSurface = buildRoadSurface(
      [
        { x: -18, y: 0, z: -11 },
        { x: 18, y: 3, z: 11 },
      ],
      6,
    );
    const plan = buildTerrainPlan({
      ...options,
      anchor,
      cellsPerChunk: 8,
      roadSurface,
    });
    const area = (mesh: SurfaceMesh) =>
      meshTriangles(mesh).reduce(
        (sum, t) => sum + Math.abs(signedArea(...t)) / 2,
        0,
      );
    const groundArea = plan.chunks.reduce(
      (sum, chunk) => sum + (chunk.mesh ? area(chunk.mesh) : 32 * 32),
      0,
    );
    expect(groundArea + area(roadSurface)).toBeCloseTo(
      plan.chunks.length * 32 * 32,
      5,
    );
  });

  it("uses the rendered triangle diagonal when sampling a nonplanar cell", () => {
    const plan = buildTerrainPlan({ ...options, anchor, cellsPerChunk: 8 });
    plan.chunks = [
      {
        id: "cell",
        x: 0,
        z: 0,
        rows: 2,
        columns: 2,
        heights: [0, 0, 0, 4],
        bounds: { minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
        minHeight: 0,
        maxHeight: 4,
      },
    ];
    expect(sampleTerrainPlan(plan, 0.5, 0.5)).toBe(0);
    expect(sampleTerrainPlan(plan, 0.75, 0.75)).toBe(2);
  });

  it("joins ground crossings even when the source has no shared node", () => {
    const plan = buildWorldPlan(
      [
        feature("east", [
          [-23, 1],
          [24, 1],
        ]),
        feature("north", [
          [2, -25],
          [2, 22],
        ]),
      ],
      anchor,
      settings,
      [],
      options,
    );
    const junction = plan.junctions.find((j) => j.kind === "intersection")!;
    expect(junction).toBeDefined();
    const surfaces = plan.roads.map((r) => new SurfaceIndex(r.mesh));
    for (const dx of [-2, 0, 2])
      for (const dz of [-2, 0, 2]) {
        for (const surface of surfaces)
          expect(
            surface.height(junction.center.x + dx, junction.center.z + dz),
          ).toBeCloseTo(junction.center.y, 5);
      }
  });

  it("joins road approaches to the same junction surface on a hill", () => {
    const plan = buildWorldPlan(
      [
        feature("through", [
          [-24, 0],
          [0, 0],
          [24, 0],
        ]),
        feature("side", [
          [0, 0],
          [0, 25],
        ]),
      ],
      anchor,
      settings,
      [],
      options,
    );
    const junction = plan.junctions.find((j) => j.kind === "intersection")!;
    expect(junction).toBeDefined();
    for (const road of plan.roads) {
      const surface = new SurfaceIndex(road.mesh);
      for (const point of road.points.filter(
        (p) =>
          Math.hypot(p.x - junction.center.x, p.z - junction.center.z) <
          junction.radius,
      )) {
        expect(point.y).toBeCloseTo(junction.center.y, 5);
        expect(surface.height(point.x, point.z)).toBeCloseTo(
          junction.center.y,
          5,
        );
      }
    }
    assertPavementEmpty(plan.terrain!, plan.terrain!.roadSurface!);
  });

  it("rebuilds geometry after widening, hiding, and undoing a road", () => {
    const features = [
      feature("edited", [
        [-25, -10],
        [25, 10],
      ]),
    ];
    const original = buildWorldPlan(features, anchor, settings, [], options);
    const width: WorldOverride = {
      id: "width",
      targetId: "edited",
      operation: "set-width",
      payloadVersion: 1,
      payload: { width: 12 },
    };
    const widened = buildWorldPlan(
      features,
      anchor,
      settings,
      [width],
      options,
    );
    expect(widened.terrain).not.toEqual(original.terrain);
    expect(
      affectedChunkIds(original, widened, ["edited"]).length,
    ).toBeGreaterThan(0);
    assertPavementEmpty(widened.terrain!, widened.roads[0]!.mesh);
    const hidden = buildWorldPlan(
      features,
      anchor,
      settings,
      [{ ...width, operation: "set-visible", payload: { visible: false } }],
      options,
    );
    expect(hidden.roads).toHaveLength(0);
    expect(hidden.terrain!.chunks.every((chunk) => !chunk.mesh)).toBe(true);
    const restored = buildWorldPlan(features, anchor, settings, [], options);
    expect(restored.buildHash).toBe(original.buildHash);
    expect(restored.terrain).toEqual(original.terrain);
  });

  it("retains terrain under bridge decks", () => {
    const plan = buildWorldPlan(
      [
        feature(
          "bridge",
          [
            [-20, 0],
            [20, 0],
          ],
          { bridge: "yes", layer: "1" },
        ),
      ],
      anchor,
      settings,
      [],
      options,
    );
    expect(plan.terrain!.roadSurface!.indices).toHaveLength(0);
    expect(plan.terrain!.chunks.every((chunk) => !chunk.mesh)).toBe(true);
  });

  it("queries clipped terrain triangles exactly beside a road", () => {
    const plan = buildWorldPlan(
      [
        feature("slope", [
          [-20, -15],
          [20, 15],
        ]),
      ],
      anchor,
      settings,
      [],
      options,
    );
    for (const chunk of plan.terrain!.chunks) {
      for (const triangle of meshTriangles(
        chunk.mesh ?? { positions: [], indices: [] },
      ).filter((_, i) => i % 19 === 0)) {
        const x = triangle.reduce((sum, p) => sum + p.x, 0) / 3;
        const z = triangle.reduce((sum, p) => sum + p.z, 0) / 3;
        expect(sampleTerrainPlan(plan.terrain, x, z)).toBeCloseTo(
          triangleHeight(triangle, x, z)!,
          5,
        );
      }
    }
  });
});
