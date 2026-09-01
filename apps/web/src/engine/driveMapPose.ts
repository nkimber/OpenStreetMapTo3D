import type { Wgs84Position } from "@osm3d/contracts";
import { localToWgs84 } from "@osm3d/geo";

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface VehicleMapPose {
  longitude: number;
  latitude: number;
  headingDegrees: number;
}

export function vehicleHeadingDegrees(rotation: QuaternionLike): number {
  const forwardX = -2 * (rotation.x * rotation.z + rotation.w * rotation.y);
  const forwardZ = -(1 - 2 * (rotation.x ** 2 + rotation.y ** 2));
  const heading = (Math.atan2(forwardX, -forwardZ) * 180) / Math.PI;
  return (heading + 360) % 360;
}

export function vehicleMapPose(
  position: { x: number; z: number },
  rotation: QuaternionLike,
  anchor: Wgs84Position,
): VehicleMapPose {
  const location = localToWgs84(
    { east: position.x, north: -position.z, up: 0 },
    anchor,
  );
  return {
    longitude: location.longitude,
    latitude: location.latitude,
    headingDegrees: vehicleHeadingDegrees(rotation),
  };
}
