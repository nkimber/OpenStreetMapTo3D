import { describe, expect, it } from "vitest";
import { vehicleHeadingDegrees, vehicleMapPose } from "./driveMapPose.js";

const anchor = { longitude: -75.1652, latitude: 39.9526, height: 0 };

describe("drive map pose", () => {
  it("keeps the world origin at the geographic anchor", () => {
    const pose = vehicleMapPose(
      { x: 0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      anchor,
    );

    expect(pose.longitude).toBeCloseTo(anchor.longitude, 7);
    expect(pose.latitude).toBeCloseTo(anchor.latitude, 7);
    expect(pose.headingDegrees).toBeCloseTo(0, 7);
  });

  it("converts local east and north movement into map movement", () => {
    const east = vehicleMapPose(
      { x: 100, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      anchor,
    );
    const north = vehicleMapPose(
      { x: 0, z: -100 },
      { x: 0, y: 0, z: 0, w: 1 },
      anchor,
    );

    expect(east.longitude).toBeGreaterThan(anchor.longitude);
    expect(north.latitude).toBeGreaterThan(anchor.latitude);
  });

  it("reports an east-facing vehicle as a 90 degree map bearing", () => {
    const halfTurn = Math.sqrt(0.5);
    expect(
      vehicleHeadingDegrees({ x: 0, y: -halfTurn, z: 0, w: halfTurn }),
    ).toBeCloseTo(90, 7);
  });
});
