import type {
  ElevationSnapshot,
  Wgs84Bounds,
  Wgs84Position,
} from "@osm3d/contracts";
import { localToWgs84, wgs84ToLocal } from "@osm3d/geo";
import { deterministicHash } from "./hash.js";
import {
  appendPolygon,
  SurfaceIndex,
  subtractTriangle,
  triangleHeight,
  type SurfaceMesh,
  type SurfacePoint,
} from "./surface.js";

export interface TerrainPoint {
  x: number;
  y: number;
  z: number;
}

export interface TerrainChunkPlan {
  id: string;
  x: number;
  z: number;
  rows: number;
  columns: number;
  /** Rapier-compatible x-major order: xIndex * rows + zIndex. */
  heights: number[];
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  minHeight: number;
  maxHeight: number;
  /** Road-boundary tessellation. Rendering and physics consume this exact mesh. */
  mesh?: SurfaceMesh;
  /** Index-buffer offsets for each x-major grid cell, plus a terminal offset. */
  cellOffsets?: number[];
  /** Computed in the Worker to avoid hashing large mesh buffers on the UI thread. */
  contentHash?: string;
}

export interface TerrainPlan {
  chunks: TerrainChunkPlan[];
  cellsPerChunk: number;
  referenceHeight: number;
  sourceMinHeight: number;
  sourceMaxHeight: number;
  provider: ElevationSnapshot["provider"];
  dataset: string;
  verticalDatum: string;
  roadSurface?: SurfaceMesh;
}

export interface TerrainRoadProfile {
  points: TerrainPoint[];
  width: number;
  tunnel: boolean;
}

export interface TerrainJunctionProfile {
  center: TerrainPoint;
  radius: number;
}

export const ROAD_TERRAIN_CLEARANCE_METERS = 0.05;
export const ROAD_TERRAIN_BLEND_WIDTH_METERS = 8;

export function roadTerrainCellSafetyMargin(cellSize: number): number {
  return Math.min(
    ROAD_TERRAIN_BLEND_WIDTH_METERS * 0.75,
    cellSize * Math.SQRT2,
  );
}

export interface ElevationSampler {
  referenceHeight: number;
  atWgs84(longitude: number, latitude: number): number;
  atLocal(x: number, z: number): number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

/** Bilinear sampling of the immutable south-to-north, west-to-east DEM grid. */
export function sampleElevationSnapshot(
  snapshot: ElevationSnapshot,
  longitude: number,
  latitude: number,
): number {
  const column =
    ((clamp(longitude, snapshot.bounds.west, snapshot.bounds.east) -
      snapshot.bounds.west) /
      (snapshot.bounds.east - snapshot.bounds.west)) *
    (snapshot.columns - 1);
  const row =
    ((clamp(latitude, snapshot.bounds.south, snapshot.bounds.north) -
      snapshot.bounds.south) /
      (snapshot.bounds.north - snapshot.bounds.south)) *
    (snapshot.rows - 1);
  const column0 = Math.floor(column);
  const column1 = Math.min(snapshot.columns - 1, column0 + 1);
  const row0 = Math.floor(row);
  const row1 = Math.min(snapshot.rows - 1, row0 + 1);
  const tx = column - column0;
  const ty = row - row0;
  const value = (x: number, y: number) =>
    snapshot.heights[y * snapshot.columns + x] ?? snapshot.minHeight;
  const south = value(column0, row0) * (1 - tx) + value(column1, row0) * tx;
  const north = value(column0, row1) * (1 - tx) + value(column1, row1) * tx;
  return south * (1 - ty) + north * ty;
}

export function createElevationSampler(
  snapshot: ElevationSnapshot,
  anchor: Wgs84Position,
): ElevationSampler {
  const referenceHeight = sampleElevationSnapshot(
    snapshot,
    anchor.longitude,
    anchor.latitude,
  );
  return {
    referenceHeight,
    atWgs84(longitude, latitude) {
      return (
        sampleElevationSnapshot(snapshot, longitude, latitude) - referenceHeight
      );
    },
    atLocal(x, z) {
      const position = localToWgs84(
        { east: x, north: -z, up: 0 },
        { ...anchor, height: 0 },
      );
      return (
        sampleElevationSnapshot(
          snapshot,
          position.longitude,
          position.latitude,
        ) - referenceHeight
      );
    },
  };
}

function localBounds(
  bounds: Wgs84Bounds,
  anchor: Wgs84Position,
): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const corners = [
    [bounds.west, bounds.south],
    [bounds.west, bounds.north],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
  ].map(([longitude = 0, latitude = 0]) => {
    const local = wgs84ToLocal(
      { longitude, latitude, height: 0 },
      { ...anchor, height: 0 },
    );
    return { x: local.east, z: -local.north };
  });
  return {
    minX: Math.min(...corners.map((point) => point.x)),
    minZ: Math.min(...corners.map((point) => point.z)),
    maxX: Math.max(...corners.map((point) => point.x)),
    maxZ: Math.max(...corners.map((point) => point.z)),
  };
}

interface TerrainSegmentReference {
  kind: "segment";
  roadIndex: number;
  start: TerrainPoint;
  end: TerrainPoint;
}

interface TerrainJunctionReference {
  kind: "junction";
  junctionIndex: number;
}

type TerrainCorridorReference =
  TerrainSegmentReference | TerrainJunctionReference;

interface TerrainCorridorIndex {
  bucketSize: number;
  buckets: Map<string, TerrainCorridorReference[]>;
  roads: TerrainRoadProfile[];
  junctions: TerrainJunctionProfile[];
  cellSafetyMargin: number;
}

interface CorridorMatch {
  distance: number;
  height: number;
}

function corridorBucketKey(x: number, z: number, bucketSize: number): string {
  return `${Math.floor(x / bucketSize)}:${Math.floor(z / bucketSize)}`;
}

function addCorridorReference(
  buckets: Map<string, TerrainCorridorReference[]>,
  bucketSize: number,
  reference: TerrainCorridorReference,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
): void {
  const minBucketX = Math.floor(bounds.minX / bucketSize);
  const maxBucketX = Math.floor(bounds.maxX / bucketSize);
  const minBucketZ = Math.floor(bounds.minZ / bucketSize);
  const maxBucketZ = Math.floor(bounds.maxZ / bucketSize);
  for (let bucketX = minBucketX; bucketX <= maxBucketX; bucketX += 1) {
    for (let bucketZ = minBucketZ; bucketZ <= maxBucketZ; bucketZ += 1) {
      const key = `${bucketX}:${bucketZ}`;
      const entries = buckets.get(key) ?? [];
      entries.push(reference);
      buckets.set(key, entries);
    }
  }
}

function buildTerrainCorridorIndex(
  roads: TerrainRoadProfile[],
  junctions: TerrainJunctionProfile[],
  cellSize: number,
): TerrainCorridorIndex {
  const bucketSize = Math.max(16, Math.min(64, cellSize * 8));
  const buckets = new Map<string, TerrainCorridorReference[]>();
  roads.forEach((road, roadIndex) => {
    const reach = road.width / 2 + ROAD_TERRAIN_BLEND_WIDTH_METERS;
    for (
      let pointIndex = 0;
      pointIndex < road.points.length - 1;
      pointIndex += 1
    ) {
      const start = road.points[pointIndex];
      const end = road.points[pointIndex + 1];
      if (!start || !end) continue;
      const reference: TerrainSegmentReference = {
        kind: "segment",
        roadIndex,
        start,
        end,
      };
      addCorridorReference(buckets, bucketSize, reference, {
        minX: Math.min(start.x, end.x) - reach,
        minZ: Math.min(start.z, end.z) - reach,
        maxX: Math.max(start.x, end.x) + reach,
        maxZ: Math.max(start.z, end.z) + reach,
      });
    }
  });
  junctions.forEach((junction, junctionIndex) => {
    const reach = junction.radius + ROAD_TERRAIN_BLEND_WIDTH_METERS;
    addCorridorReference(
      buckets,
      bucketSize,
      { kind: "junction", junctionIndex },
      {
        minX: junction.center.x - reach,
        minZ: junction.center.z - reach,
        maxX: junction.center.x + reach,
        maxZ: junction.center.z + reach,
      },
    );
  });
  return {
    bucketSize,
    buckets,
    roads,
    junctions,
    cellSafetyMargin: roadTerrainCellSafetyMargin(cellSize),
  };
}

function closestSegmentHeight(
  segment: TerrainSegmentReference,
  x: number,
  z: number,
): CorridorMatch {
  const dx = segment.end.x - segment.start.x;
  const dz = segment.end.z - segment.start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio =
    lengthSquared === 0
      ? 0
      : clamp(
          ((x - segment.start.x) * dx + (z - segment.start.z) * dz) /
            lengthSquared,
          0,
          1,
        );
  const candidateX = segment.start.x + dx * ratio;
  const candidateZ = segment.start.z + dz * ratio;
  return {
    distance: Math.hypot(x - candidateX, z - candidateZ),
    height: segment.start.y + (segment.end.y - segment.start.y) * ratio,
  };
}

function linearCorridorInfluence(distance: number, radius: number): number {
  if (distance <= radius) return 1;
  return clamp(1 - (distance - radius) / ROAD_TERRAIN_BLEND_WIDTH_METERS, 0, 1);
}

function cellSafeCutInfluence(
  distance: number,
  radius: number,
  cellSafetyMargin: number,
): number {
  const core = radius + cellSafetyMargin;
  const outer = radius + ROAD_TERRAIN_BLEND_WIDTH_METERS;
  if (distance <= core) return 1;
  if (distance >= outer) return 0;
  const progress = (distance - core) / Math.max(0.001, outer - core);
  const smooth = progress * progress * (3 - 2 * progress);
  return 1 - smooth;
}

function gradeTerrainHeight(
  originalHeight: number,
  x: number,
  z: number,
  corridors: TerrainCorridorIndex,
): number {
  const references =
    corridors.buckets.get(corridorBucketKey(x, z, corridors.bucketSize)) ?? [];
  const roadMatches = new Map<number, CorridorMatch>();
  const junctionMatches: Array<{
    junction: TerrainJunctionProfile;
    distance: number;
  }> = [];

  for (const reference of references) {
    if (reference.kind === "segment") {
      const road = corridors.roads[reference.roadIndex];
      if (!road) continue;
      const match = closestSegmentHeight(reference, x, z);
      if (match.distance > road.width / 2 + ROAD_TERRAIN_BLEND_WIDTH_METERS)
        continue;
      const current = roadMatches.get(reference.roadIndex);
      if (!current || match.distance < current.distance)
        roadMatches.set(reference.roadIndex, match);
      continue;
    }
    const junction = corridors.junctions[reference.junctionIndex];
    if (!junction) continue;
    const distance = Math.hypot(x - junction.center.x, z - junction.center.z);
    if (distance <= junction.radius + ROAD_TERRAIN_BLEND_WIDTH_METERS)
      junctionMatches.push({ junction, distance });
  }

  const groundCandidates: Array<{ target: number; influence: number }> = [];
  for (const [roadIndex, match] of roadMatches) {
    const road = corridors.roads[roadIndex];
    if (!road || road.tunnel) continue;
    const radius = road.width / 2;
    const target = match.height - ROAD_TERRAIN_CLEARANCE_METERS;
    const edgeInfluence = linearCorridorInfluence(match.distance, radius);
    const influence =
      target < originalHeight
        ? Math.max(
            edgeInfluence,
            cellSafeCutInfluence(
              match.distance,
              radius,
              corridors.cellSafetyMargin,
            ),
          )
        : edgeInfluence;
    if (influence > 0) groundCandidates.push({ target, influence });
  }
  for (const { junction, distance } of junctionMatches) {
    const target = junction.center.y - ROAD_TERRAIN_CLEARANCE_METERS;
    const edgeInfluence = linearCorridorInfluence(distance, junction.radius);
    const influence =
      target < originalHeight
        ? Math.max(
            edgeInfluence,
            cellSafeCutInfluence(
              distance,
              junction.radius,
              corridors.cellSafetyMargin,
            ),
          )
        : edgeInfluence;
    if (influence > 0) groundCandidates.push({ target, influence });
  }

  let height = originalHeight;
  if (groundCandidates.length > 0) {
    const totalInfluence = groundCandidates.reduce(
      (total, candidate) => total + candidate.influence,
      0,
    );
    const target =
      groundCandidates.reduce(
        (total, candidate) => total + candidate.target * candidate.influence,
        0,
      ) / totalInfluence;
    const strongestInfluence = Math.max(
      ...groundCandidates.map((candidate) => candidate.influence),
    );
    height += (target - height) * strongestInfluence;
    // Full-strength pavement constraints take precedence over neighboring blends.
    for (const candidate of groundCandidates) {
      if (candidate.influence === 1)
        height = Math.min(height, candidate.target);
    }
  }

  for (const [roadIndex, match] of roadMatches) {
    const road = corridors.roads[roadIndex];
    if (!road?.tunnel) continue;
    const target = match.height - ROAD_TERRAIN_CLEARANCE_METERS;
    const influence = cellSafeCutInfluence(
      match.distance,
      road.width / 2,
      corridors.cellSafetyMargin,
    );
    height = Math.min(height, height + (target - height) * influence);
  }
  return height;
}

export function buildTerrainPlan(input: {
  bounds: Wgs84Bounds;
  anchor: Wgs84Position;
  elevation: ElevationSnapshot;
  chunkSize: number;
  cellsPerChunk?: number;
  roads?: TerrainRoadProfile[];
  junctions?: TerrainJunctionProfile[];
  /** @deprecated Use roads with tunnel=true. */
  tunnelRoads?: TerrainRoadProfile[];
  roadSurface?: SurfaceMesh;
}): TerrainPlan {
  const cellsPerChunk = input.cellsPerChunk ?? 64;
  const sampler = createElevationSampler(input.elevation, input.anchor);
  const cellSize = input.chunkSize / cellsPerChunk;
  const corridors = buildTerrainCorridorIndex(
    input.roads ?? input.tunnelRoads ?? [],
    input.junctions ?? [],
    cellSize,
  );
  const bounds = localBounds(input.bounds, input.anchor);
  const padding = 40;
  const minChunkX = Math.floor((bounds.minX - padding) / input.chunkSize);
  const maxChunkX = Math.floor((bounds.maxX + padding) / input.chunkSize);
  const minChunkZ = Math.floor((bounds.minZ - padding) / input.chunkSize);
  const maxChunkZ = Math.floor((bounds.maxZ + padding) / input.chunkSize);
  const chunks: TerrainChunkPlan[] = [];
  const roadIndex = input.roadSurface
    ? new SurfaceIndex(input.roadSurface)
    : undefined;

  for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
      const minX = chunkX * input.chunkSize;
      const minZ = chunkZ * input.chunkSize;
      const heights: number[] = [];
      for (let xIndex = 0; xIndex <= cellsPerChunk; xIndex += 1) {
        const x = minX + (xIndex / cellsPerChunk) * input.chunkSize;
        for (let zIndex = 0; zIndex <= cellsPerChunk; zIndex += 1) {
          const z = minZ + (zIndex / cellsPerChunk) * input.chunkSize;
          const height = gradeTerrainHeight(
            sampler.atLocal(x, z),
            x,
            z,
            corridors,
          );
          heights.push(Number(height.toFixed(4)));
        }
      }
      chunks.push({
        id: `terrain:${chunkX}:${chunkZ}`,
        x: chunkX,
        z: chunkZ,
        rows: cellsPerChunk + 1,
        columns: cellsPerChunk + 1,
        heights,
        bounds: {
          minX,
          minZ,
          maxX: minX + input.chunkSize,
          maxZ: minZ + input.chunkSize,
        },
        minHeight: Math.min(...heights),
        maxHeight: Math.max(...heights),
      });
      if (roadIndex)
        tessellateRoadBoundaries(chunks[chunks.length - 1]!, roadIndex);
      const chunk = chunks[chunks.length - 1]!;
      chunk.contentHash = deterministicHash(chunk);
    }
  }
  return {
    chunks,
    cellsPerChunk,
    referenceHeight: sampler.referenceHeight,
    sourceMinHeight: input.elevation.minHeight,
    sourceMaxHeight: input.elevation.maxHeight,
    provider: input.elevation.provider,
    dataset: input.elevation.dataset,
    verticalDatum: input.elevation.verticalDatum,
    ...(input.roadSurface ? { roadSurface: input.roadSurface } : {}),
  };
}

/** Shared edge profiles keep clipping-created vertices identical on either side. */
function roadEdgeProfile(
  a: SurfacePoint,
  b: SurfacePoint,
  roads: SurfaceIndex,
): (p: SurfacePoint) => number | undefined {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    lengthSquared = dx * dx + dz * dz;
  const knots = [0, 1];
  for (const triangle of roads.within(
    Math.min(a.x, b.x),
    Math.min(a.z, b.z),
    Math.max(a.x, b.x),
    Math.max(a.z, b.z),
  )) {
    for (let i = 0; i < 3; i++) {
      const c = triangle[i]!,
        d = triangle[(i + 1) % 3]!;
      const ex = d.x - c.x,
        ez = d.z - c.z;
      const denominator = dx * ez - dz * ex;
      if (Math.abs(denominator) < 1e-10) continue;
      const t = ((c.x - a.x) * ez - (c.z - a.z) * ex) / denominator;
      const u = ((c.x - a.x) * dz - (c.z - a.z) * dx) / denominator;
      if (t > 0 && t < 1 && u >= -1e-8 && u <= 1 + 1e-8) knots.push(t);
    }
  }
  const values = [...new Set(knots)]
    .sort((x, y) => x - y)
    .map((t) => ({
      t,
      height: roads.height(a.x + t * dx, a.z + t * dz) ?? a.y + t * (b.y - a.y),
    }));
  return (p) => {
    const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSquared;
    if (
      t < -1e-8 ||
      t > 1 + 1e-8 ||
      Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) > 1e-7
    )
      return undefined;
    for (let i = 1; i < values.length; i++) {
      const left = values[i - 1]!,
        right = values[i]!;
      if (t <= right.t + 1e-10) {
        const progress = clamp(
          (t - left.t) / Math.max(1e-12, right.t - left.t),
          0,
          1,
        );
        return left.height + progress * (right.height - left.height);
      }
    }
    return values.at(-1)!.height;
  };
}

function tessellateRoadBoundaries(
  chunk: TerrainChunkPlan,
  roads: SurfaceIndex,
): void {
  if (
    !roads.within(
      chunk.bounds.minX,
      chunk.bounds.minZ,
      chunk.bounds.maxX,
      chunk.bounds.maxZ,
    ).length
  )
    return;
  const mesh: SurfaceMesh = { positions: [], indices: [] };
  const cellOffsets: number[] = [];
  const dx = (chunk.bounds.maxX - chunk.bounds.minX) / (chunk.columns - 1);
  const dz = (chunk.bounds.maxZ - chunk.bounds.minZ) / (chunk.rows - 1);
  const point = (column: number, row: number): SurfacePoint => ({
    x: chunk.bounds.minX + column * dx,
    y: chunk.heights[column * chunk.rows + row] ?? 0,
    z: chunk.bounds.minZ + row * dz,
  });
  for (let column = 0; column < chunk.columns - 1; column++) {
    for (let row = 0; row < chunk.rows - 1; row++) {
      cellOffsets.push(mesh.indices.length);
      const a = point(column, row),
        b = point(column + 1, row);
      const c = point(column, row + 1),
        d = point(column + 1, row + 1);
      const clips = roads
        .within(a.x, a.z, d.x, d.z)
        .filter(
          (triangle) =>
            Math.max(...triangle.map((p) => p.x)) >= a.x &&
            Math.min(...triangle.map((p) => p.x)) <= d.x &&
            Math.max(...triangle.map((p) => p.z)) >= a.z &&
            Math.min(...triangle.map((p) => p.z)) <= d.z,
        );
      const edgeProfiles = clips.length
        ? [
            [a, b],
            [a, c],
            [b, d],
            [c, d],
            [b, c],
          ].map(([start, end]) => roadEdgeProfile(start!, end!, roads))
        : [];
      for (const triangle of [
        [a, c, b],
        [b, c, d],
      ]) {
        let pieces = [triangle];
        for (const clip of clips)
          pieces = pieces.flatMap((piece) => subtractTriangle(piece, clip));
        for (const piece of pieces) {
          // New vertices on pavement edges meet the road exactly. The remaining
          // terrain triangles are the physical shoulder, so no overlapping skirt exists.
          appendPolygon(
            mesh,
            piece.map((p) => ({
              ...p,
              y:
                roads.height(p.x, p.z) ??
                edgeProfiles
                  .map((sample) => sample(p))
                  .find((height) => height !== undefined) ??
                p.y,
            })),
          );
        }
      }
    }
  }
  cellOffsets.push(mesh.indices.length);
  chunk.mesh = mesh;
  chunk.cellOffsets = cellOffsets;
  for (let i = 1; i < mesh.positions.length; i += 3) {
    chunk.minHeight = Math.min(chunk.minHeight, mesh.positions[i]!);
    chunk.maxHeight = Math.max(chunk.maxHeight, mesh.positions[i]!);
  }
}

const roadIndexes = new WeakMap<TerrainPlan, SurfaceIndex>();

export function sampleTerrainPlan(
  terrain: TerrainPlan | undefined,
  x: number,
  z: number,
): number {
  if (!terrain) return 0;
  const chunk = terrain.chunks.find(
    (candidate) =>
      x >= candidate.bounds.minX &&
      x <= candidate.bounds.maxX &&
      z >= candidate.bounds.minZ &&
      z <= candidate.bounds.maxZ,
  );
  if (!chunk) return 0;
  const column =
    ((x - chunk.bounds.minX) / (chunk.bounds.maxX - chunk.bounds.minX)) *
    (chunk.columns - 1);
  const row =
    ((z - chunk.bounds.minZ) / (chunk.bounds.maxZ - chunk.bounds.minZ)) *
    (chunk.rows - 1);
  const column0 = Math.floor(column);
  const column1 = Math.min(chunk.columns - 1, column0 + 1);
  const row0 = Math.floor(row);
  const row1 = Math.min(chunk.rows - 1, row0 + 1);
  const tx = column - column0;
  const tz = row - row0;
  const value = (xIndex: number, zIndex: number) =>
    chunk.heights[xIndex * chunk.rows + zIndex] ?? 0;
  if (chunk.mesh && chunk.cellOffsets) {
    const cell =
      Math.min(column0, chunk.columns - 2) * (chunk.rows - 1) +
      Math.min(row0, chunk.rows - 2);
    const mesh = chunk.mesh;
    const vertex = (index: number): SurfacePoint => ({
      x: mesh.positions[index * 3]!,
      y: mesh.positions[index * 3 + 1]!,
      z: mesh.positions[index * 3 + 2]!,
    });
    for (
      let i = chunk.cellOffsets[cell]!;
      i < chunk.cellOffsets[cell + 1]!;
      i += 3
    ) {
      const height = triangleHeight(
        [
          vertex(mesh.indices[i]!),
          vertex(mesh.indices[i + 1]!),
          vertex(mesh.indices[i + 2]!),
        ],
        x,
        z,
      );
      if (height !== undefined) return height;
    }
    // Pavement replaces the terrain here. Queries for recovery/building placement
    // use the actual drivable surface, not the removed grid underneath it.
    if (terrain.roadSurface) {
      let roads = roadIndexes.get(terrain);
      if (!roads) {
        roads = new SurfaceIndex(terrain.roadSurface);
        roadIndexes.set(terrain, roads);
      }
      const height = roads.height(x, z);
      if (height !== undefined) return height;
    }
  }
  // The same b-c diagonal as the rendered grid and Rapier heightfield.
  return tx + tz <= 1
    ? value(column0, row0) * (1 - tx - tz) +
        value(column1, row0) * tx +
        value(column0, row1) * tz
    : value(column1, row1) * (tx + tz - 1) +
        value(column1, row0) * (1 - tz) +
        value(column0, row1) * (1 - tx);
}
