import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";
import {
  defaultVehicleConfig,
  speedLimitedEngineForce,
} from "@osm3d/simulation";

const fixedStep = 1 / 60;

interface ReplayResult {
  finalX: number;
  finalZ: number;
  peakSpeedKph: number;
  speedBeforeBrakingKph: number;
  speedAfterBrakingKph: number;
  uprightW: number;
}

function replayDrive(): ReplayResult {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = fixedStep;
  const ground = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.15, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(100, 0.15, 100).setFriction(1.1),
    ground,
  );

  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 1.4, 8)
      .setCanSleep(false)
      .setCcdEnabled(true),
  );
  const [halfX, halfY, halfZ] = defaultVehicleConfig.chassisHalfExtents;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
      .setMass(defaultVehicleConfig.chassisMass)
      .setFriction(0.6),
    chassis,
  );
  const vehicle = world.createVehicleController(chassis);
  vehicle.indexUpAxis = 1;
  vehicle.setIndexForwardAxis = 2;
  [
    { x: -0.92, y: -0.36, z: -1.42 },
    { x: 0.92, y: -0.36, z: -1.42 },
    { x: -0.92, y: -0.36, z: 1.38 },
    { x: 0.92, y: -0.36, z: 1.38 },
  ].forEach((connection, index) => {
    vehicle.addWheel(
      connection,
      { x: 0, y: -1, z: 0 },
      { x: -1, y: 0, z: 0 },
      defaultVehicleConfig.suspensionRestLength,
      defaultVehicleConfig.wheelRadius,
    );
    vehicle.setWheelSuspensionStiffness(
      index,
      defaultVehicleConfig.suspensionStiffness,
    );
    vehicle.setWheelSuspensionCompression(
      index,
      defaultVehicleConfig.suspensionCompression,
    );
    vehicle.setWheelSuspensionRelaxation(
      index,
      defaultVehicleConfig.suspensionRelaxation,
    );
    vehicle.setWheelMaxSuspensionForce(
      index,
      defaultVehicleConfig.maxSuspensionForce,
    );
    vehicle.setWheelFrictionSlip(index, defaultVehicleConfig.frictionSlip);
  });

  let peakSpeedKph = 0;
  for (let frame = 0; frame < 240; frame += 1) {
    const speedKph = Math.abs(vehicle.currentVehicleSpeed()) * 3.6;
    peakSpeedKph = Math.max(peakSpeedKph, speedKph);
    const engineForce = speedLimitedEngineForce(1, speedKph);
    vehicle.setWheelEngineForce(2, engineForce);
    vehicle.setWheelEngineForce(3, engineForce);
    vehicle.updateVehicle(fixedStep, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    world.step();
  }
  const speedBeforeBrakingKph = Math.abs(vehicle.currentVehicleSpeed()) * 3.6;

  for (let frame = 0; frame < 120; frame += 1) {
    vehicle.setWheelEngineForce(2, 0);
    vehicle.setWheelEngineForce(3, 0);
    for (let wheel = 0; wheel < 4; wheel += 1) {
      vehicle.setWheelBrake(wheel, defaultVehicleConfig.brakeForce);
    }
    vehicle.updateVehicle(fixedStep, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    world.step();
  }

  const position = chassis.translation();
  const rotation = chassis.rotation();
  const result = {
    finalX: position.x,
    finalZ: position.z,
    peakSpeedKph,
    speedBeforeBrakingKph,
    speedAfterBrakingKph: Math.abs(vehicle.currentVehicleSpeed()) * 3.6,
    uprightW: Math.abs(rotation.w),
  };
  world.free();
  return result;
}

describe("Rapier vehicle replay", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("crosses the origin chunk seam, respects the speed budget, and brakes deterministically", () => {
    const first = replayDrive();
    const second = replayDrive();

    expect(first.finalZ).toBeLessThan(0);
    expect(Math.abs(first.finalX)).toBeLessThan(1);
    expect(first.peakSpeedKph).toBeGreaterThan(25);
    expect(first.peakSpeedKph).toBeLessThan(105);
    expect(first.speedAfterBrakingKph).toBeLessThan(
      first.speedBeforeBrakingKph * 0.25,
    );
    expect(first.uprightW).toBeGreaterThan(0.9);
    expect(second.finalX).toBeCloseTo(first.finalX, 5);
    expect(second.finalZ).toBeCloseTo(first.finalZ, 5);
    expect(second.peakSpeedKph).toBeCloseTo(first.peakSpeedKph, 5);
  });
});
