import type { Wgs84Bounds, Wgs84Position } from "@osm3d/contracts";

const WGS84_A = 6_378_137;
const WGS84_E2 = 6.694_379_990_14e-3;

export interface LocalPosition {
  east: number;
  north: number;
  up: number;
}

interface EcefPosition {
  x: number;
  y: number;
  z: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

function geodeticToEcef(position: Wgs84Position): EcefPosition {
  const latitude = toRadians(position.latitude);
  const longitude = toRadians(position.longitude);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);

  return {
    x: (radius + position.height) * cosLatitude * cosLongitude,
    y: (radius + position.height) * cosLatitude * sinLongitude,
    z: (radius * (1 - WGS84_E2) + position.height) * sinLatitude,
  };
}

function ecefToGeodetic(position: EcefPosition): Wgs84Position {
  const longitude = Math.atan2(position.y, position.x);
  const horizontal = Math.hypot(position.x, position.y);
  let latitude = Math.atan2(position.z, horizontal * (1 - WGS84_E2));
  let height = 0;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const sinLatitude = Math.sin(latitude);
    const radius =
      WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
    height = horizontal / Math.cos(latitude) - radius;
    latitude = Math.atan2(
      position.z,
      horizontal * (1 - (WGS84_E2 * radius) / (radius + height)),
    );
  }

  return {
    longitude: toDegrees(longitude),
    latitude: toDegrees(latitude),
    height,
  };
}

export function wgs84ToLocal(
  position: Wgs84Position,
  anchor: Wgs84Position,
): LocalPosition {
  const point = geodeticToEcef(position);
  const origin = geodeticToEcef(anchor);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;
  const latitude = toRadians(anchor.latitude);
  const longitude = toRadians(anchor.longitude);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);

  return {
    east: -sinLongitude * dx + cosLongitude * dy,
    north:
      -sinLatitude * cosLongitude * dx -
      sinLatitude * sinLongitude * dy +
      cosLatitude * dz,
    up:
      cosLatitude * cosLongitude * dx +
      cosLatitude * sinLongitude * dy +
      sinLatitude * dz,
  };
}

export function localToWgs84(
  position: LocalPosition,
  anchor: Wgs84Position,
): Wgs84Position {
  const origin = geodeticToEcef(anchor);
  const latitude = toRadians(anchor.latitude);
  const longitude = toRadians(anchor.longitude);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);

  const dx =
    -sinLongitude * position.east -
    sinLatitude * cosLongitude * position.north +
    cosLatitude * cosLongitude * position.up;
  const dy =
    cosLongitude * position.east -
    sinLatitude * sinLongitude * position.north +
    cosLatitude * sinLongitude * position.up;
  const dz = cosLatitude * position.north + sinLatitude * position.up;

  return ecefToGeodetic({
    x: origin.x + dx,
    y: origin.y + dy,
    z: origin.z + dz,
  });
}

export function boundsCenter(bounds: Wgs84Bounds): Wgs84Position {
  return {
    longitude: (bounds.west + bounds.east) / 2,
    latitude: (bounds.south + bounds.north) / 2,
    height: 0,
  };
}

export function boundsAreaSquareKm(bounds: Wgs84Bounds): number {
  const anchor = boundsCenter(bounds);
  const southwest = wgs84ToLocal(
    { longitude: bounds.west, latitude: bounds.south, height: 0 },
    anchor,
  );
  const northeast = wgs84ToLocal(
    { longitude: bounds.east, latitude: bounds.north, height: 0 },
    anchor,
  );
  return (
    (Math.abs(northeast.east - southwest.east) *
      Math.abs(northeast.north - southwest.north)) /
    1_000_000
  );
}
