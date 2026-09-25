import type { Wgs84Bounds, Wgs84Position } from "@osm3d/contracts";
import { localToWgs84, wgs84ToLocal } from "@osm3d/geo";
import type { VehicleMapPose } from "./engine/driveMapPose.js";

export const DRIVE_ENHANCEMENT_TILE_METERS = 200;
export const DRIVE_ENHANCEMENT_PREFETCH_METERS = 100;

export interface EnhancementTile {
  x: number;
  north: number;
}

export function enhancementTileKey(tile: EnhancementTile): string {
  return `${tile.x}:${tile.north}`;
}

export function enhancementTileCenter(
  tile: EnhancementTile,
  anchor: Wgs84Position,
  tileMeters = DRIVE_ENHANCEMENT_TILE_METERS,
): [number, number] {
  const center = localToWgs84(
    {
      east: (tile.x + 0.5) * tileMeters,
      north: (tile.north + 0.5) * tileMeters,
      up: 0,
    },
    anchor,
  );
  return [center.longitude, center.latitude];
}

export function centerInsideBounds(
  center: [number, number],
  bounds: Wgs84Bounds,
): boolean {
  return (
    center[0] >= bounds.west &&
    center[0] <= bounds.east &&
    center[1] >= bounds.south &&
    center[1] <= bounds.north
  );
}

/** Current tile plus the tile ahead once the car is within the prefetch band. */
export function enhancementTilesForPose(
  pose: VehicleMapPose,
  anchor: Wgs84Position,
  tileMeters = DRIVE_ENHANCEMENT_TILE_METERS,
  prefetchMeters = DRIVE_ENHANCEMENT_PREFETCH_METERS,
): EnhancementTile[] {
  const local = wgs84ToLocal(
    { longitude: pose.longitude, latitude: pose.latitude, height: 0 },
    anchor,
  );
  const current: EnhancementTile = {
    x: Math.floor(local.east / tileMeters),
    north: Math.floor(local.north / tileMeters),
  };
  const heading = (pose.headingDegrees * Math.PI) / 180;
  const eastward = Math.sin(heading);
  const northward = Math.cos(heading);
  let next: EnhancementTile;
  let distanceToEdge: number;
  if (Math.abs(eastward) > Math.abs(northward)) {
    const step = eastward >= 0 ? 1 : -1;
    next = { x: current.x + step, north: current.north };
    distanceToEdge =
      step > 0
        ? (current.x + 1) * tileMeters - local.east
        : local.east - current.x * tileMeters;
  } else {
    const step = northward >= 0 ? 1 : -1;
    next = { x: current.x, north: current.north + step };
    distanceToEdge =
      step > 0
        ? (current.north + 1) * tileMeters - local.north
        : local.north - current.north * tileMeters;
  }
  return distanceToEdge <= prefetchMeters ? [current, next] : [current];
}
