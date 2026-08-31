import type {
  ElevationSnapshot,
  Wgs84Bounds,
  Wgs84Position,
} from "@osm3d/contracts";
import { localToWgs84, wgs84ToLocal } from "@osm3d/geo";

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
}

export interface TerrainRoadProfile {
  points: TerrainPoint[];
  width: number;
  tunnel: boolean;
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

function closestProfileHeight(
  road: TerrainRoadProfile,
  x: number,
  z: number,
): { distance: number; height: number } {
  let result = { distance: Number.POSITIVE_INFINITY, height: 0 };
  for (let index = 0; index < road.points.length - 1; index += 1) {
    const start = road.points[index];
    const end = road.points[index + 1];
    if (!start || !end) continue;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const ratio =
      lengthSquared === 0
        ? 0
        : clamp(
            ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared,
            0,
            1,
          );
    const candidateX = start.x + dx * ratio;
    const candidateZ = start.z + dz * ratio;
    const distance = Math.hypot(x - candidateX, z - candidateZ);
    if (distance < result.distance) {
      result = {
        distance,
        height: start.y + (end.y - start.y) * ratio,
      };
    }
  }
  return result;
}

export function buildTerrainPlan(input: {
  bounds: Wgs84Bounds;
  anchor: Wgs84Position;
  elevation: ElevationSnapshot;
  chunkSize: number;
  cellsPerChunk?: number;
  tunnelRoads?: TerrainRoadProfile[];
}): TerrainPlan {
  const cellsPerChunk = input.cellsPerChunk ?? 64;
  const sampler = createElevationSampler(input.elevation, input.anchor);
  const bounds = localBounds(input.bounds, input.anchor);
  const padding = 40;
  const minChunkX = Math.floor((bounds.minX - padding) / input.chunkSize);
  const maxChunkX = Math.floor((bounds.maxX + padding) / input.chunkSize);
  const minChunkZ = Math.floor((bounds.minZ - padding) / input.chunkSize);
  const maxChunkZ = Math.floor((bounds.maxZ + padding) / input.chunkSize);
  const chunks: TerrainChunkPlan[] = [];

  for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
      const minX = chunkX * input.chunkSize;
      const minZ = chunkZ * input.chunkSize;
      const heights: number[] = [];
      for (let xIndex = 0; xIndex <= cellsPerChunk; xIndex += 1) {
        const x = minX + (xIndex / cellsPerChunk) * input.chunkSize;
        for (let zIndex = 0; zIndex <= cellsPerChunk; zIndex += 1) {
          const z = minZ + (zIndex / cellsPerChunk) * input.chunkSize;
          let height = sampler.atLocal(x, z);
          for (const road of input.tunnelRoads ?? []) {
            if (!road.tunnel) continue;
            const closest = closestProfileHeight(road, x, z);
            const halfWidth = road.width / 2;
            const shoulderWidth = 6;
            if (closest.distance > halfWidth + shoulderWidth) continue;
            const blend =
              closest.distance <= halfWidth
                ? 1
                : 1 - (closest.distance - halfWidth) / shoulderWidth;
            const cutHeight = closest.height - 0.05;
            height = Math.min(height, height + (cutHeight - height) * blend);
          }
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
  };
}

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
  const west = value(column0, row0) * (1 - tz) + value(column0, row1) * tz;
  const east = value(column1, row0) * (1 - tz) + value(column1, row1) * tz;
  return west * (1 - tx) + east * tx;
}
