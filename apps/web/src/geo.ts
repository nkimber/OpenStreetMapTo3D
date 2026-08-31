import type { Wgs84Bounds, Wgs84Position } from "@osm3d/contracts";

export function boundsFromCenter(
  center: Wgs84Position,
  sizeMeters: number,
): Wgs84Bounds {
  const half = sizeMeters / 2;
  const latitudeDelta = half / 111_320;
  const longitudeScale = Math.max(
    0.15,
    Math.cos((center.latitude * Math.PI) / 180),
  );
  const longitudeDelta = half / (111_320 * longitudeScale);
  return {
    west: center.longitude - longitudeDelta,
    south: center.latitude - latitudeDelta,
    east: center.longitude + longitudeDelta,
    north: center.latitude + latitudeDelta,
  };
}

export function formatArea(sizeMeters: number): string {
  const area = (sizeMeters * sizeMeters) / 1_000_000;
  return `${area.toFixed(2)} km²`;
}
