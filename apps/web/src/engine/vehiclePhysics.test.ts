import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";
import {
  defaultVehicleConfig,
  speedAdjustedSteeringAngle,
  speedLimitedEngineForce,
} from "@osm3d/simulation";
import {
  buildWorldPlan,
  sampleTerrainPlan,
  type WorldPlan,
} from "@osm3d/worldgen";
import type { ElevationSnapshot } from "@osm3d/contracts";
import { terrainCollider } from "./terrainRuntime.js";

const fixedStep = 1 / 60;

interface ReplayResult {
  finalX: number;
  finalZ: number;
  elevationGain: number;
  peakSpeedKph: number;
  speedBeforeBrakingKph: number;
  speedAfterBrakingKph: number;
  minimumUprightDot: number;
  uprightW: number;
}

function replayDrive(plan?: WorldPlan, cornering = false): ReplayResult {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = fixedStep;
  if (plan?.terrain) {
    for (const chunk of plan.terrain.chunks)
      if (!chunk.mesh || chunk.mesh.indices.length)
        world.createCollider(terrainCollider(chunk));
    for (const surface of [
      ...plan.roads.map((road) => road.mesh),
      ...plan.junctions.map((junction) => junction.mesh),
    ])
      world.createCollider(
        RAPIER.ColliderDesc.trimesh(
          new Float32Array(surface.positions),
          new Uint32Array(surface.indices),
        ),
      );
  } else {
    const ground = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.15, 0),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(100, 0.15, 100).setFriction(1.1),
      ground,
    );
  }
  const startZ = plan ? 40 : 8;
  const startY = sampleTerrainPlan(plan?.terrain, 0, startZ) + 1.4;

  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, startY, startZ)
      .setCanSleep(false)
      .setCcdEnabled(true),
  );
  const [halfX, halfY, halfZ] = defaultVehicleConfig.chassisHalfExtents;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
      .setTranslation(0, defaultVehicleConfig.chassisCenterOfMassOffsetY, 0)
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
  let minimumUprightDot = 1;
  for (let frame = 0; frame < (plan ? 480 : 240); frame += 1) {
    const speedKph = Math.abs(vehicle.currentVehicleSpeed()) * 3.6;
    peakSpeedKph = Math.max(peakSpeedKph, speedKph);
    const engineForce = speedLimitedEngineForce(1, speedKph);
    vehicle.setWheelEngineForce(2, engineForce);
    vehicle.setWheelEngineForce(3, engineForce);
    const steering =
      cornering && frame >= 90 ? speedAdjustedSteeringAngle(1, speedKph) : 0;
    vehicle.setWheelSteering(0, steering);
    vehicle.setWheelSteering(1, steering);
    vehicle.updateVehicle(fixedStep, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    world.step();
    const rotation = chassis.rotation();
    minimumUprightDot = Math.min(
      minimumUprightDot,
      1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z),
    );
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
    elevationGain: position.y - startY,
    peakSpeedKph,
    speedBeforeBrakingKph,
    speedAfterBrakingKph: Math.abs(vehicle.currentVehicleSpeed()) * 3.6,
    minimumUprightDot,
    uprightW: Math.abs(rotation.w),
  };
  world.free();
  return result;
}

describe("Rapier vehicle replay", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("drives uphill across a clipped terrain seam and a junction without falling through", () => {
    const bounds = {
      west: -75.001,
      south: 39.999,
      east: -74.999,
      north: 40.001,
    };
    const elevation: ElevationSnapshot = {
      schemaVersion: 1,
      provider: "fixture",
      dataset: "drive slope",
      retrievedAt: "2026-01-01T00:00:00Z",
      bounds,
      columns: 2,
      rows: 2,
      spacingMeters: { eastWest: 170, northSouth: 220 },
      heights: [100, 100, 112, 112],
      minHeight: 100,
      maxHeight: 112,
      verticalDatum: "test",
      units: "meters",
      contentHash: "f".repeat(64),
      attribution: {
        text: "test",
        url: "https://example.test",
        license: "test",
      },
    };
    const plan = buildWorldPlan(
      [
        {
          sourceId: "hill",
          sourceType: "way",
          kind: "road",
          geometry: {
            type: "LineString",
            coordinates: [
              [-75, 39.99915],
              [-75, 40],
              [-75, 40.00085],
            ],
          },
          tags: { highway: "residential" },
          facts: { width: 7 },
          warnings: [],
        },
        {
          sourceId: "junction",
          sourceType: "way",
          kind: "road",
          geometry: {
            type: "LineString",
            coordinates: [
              [-75, 40],
              [-74.9995, 40],
            ],
          },
          tags: { highway: "residential" },
          facts: { width: 7 },
          warnings: [],
        },
      ],
      { longitude: -75, latitude: 40, height: 0 },
      {
        buildingLevelHeight: 3,
        defaultBuildingHeight: 8,
        includeMinorPaths: true,
        buildingCollisions: true,
        seed: 1,
        visualStyle: "clean",
      },
      [],
      { bounds, elevation, chunkSize: 64, terrainCellsPerChunk: 16 },
    );
    const result = replayDrive(plan);
    expect(result.finalZ, JSON.stringify(result)).toBeLessThan(-10);
    expect(Math.abs(result.finalX)).toBeLessThan(1);
    expect(result.elevationGain).toBeGreaterThan(1);
    expect(result.uprightW).toBeGreaterThan(0.95);
    expect(result.speedAfterBrakingKph).toBeLessThan(
      result.speedBeforeBrakingKph * 0.25,
    );
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

  it("stays controllable through sustained full steering without forced-upright physics", () => {
    const result = replayDrive(undefined, true);
    expect(result.peakSpeedKph).toBeGreaterThan(25);
    expect(Math.abs(result.finalX)).toBeGreaterThan(5);
    expect(result.minimumUprightDot).toBeGreaterThan(0.55);
  });
});
