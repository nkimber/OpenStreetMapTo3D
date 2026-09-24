import { describe, expect, it } from "vitest";
import {
  isVehiclePoseSafe,
  neutralVehicleInput,
  racerProximityBrake,
  shouldRecoverVehicle,
  smoothVehicleInput,
  speedAdjustedSteeringAngle,
  speedLimitedEngineForce,
  standardGamepadInput,
} from "./index.js";

describe("vehicle input smoothing", () => {
  it("moves steering toward its target without overshooting", () => {
    const next = smoothVehicleInput(
      neutralVehicleInput,
      {
        throttle: 1,
        brake: 0,
        steering: 1,
        handbrake: false,
      },
      0.1,
    );
    expect(next.throttle).toBeCloseTo(0.3);
    expect(next.steering).toBeCloseTo(0.45);
  });

  it("accepts stable ground poses and rejects overturned vehicles", () => {
    expect(
      isVehiclePoseSafe({ uprightDot: 0.99, height: 1.2, insideWorld: true }),
    ).toBe(true);
    expect(
      isVehiclePoseSafe({ uprightDot: -0.2, height: 1.2, insideWorld: true }),
    ).toBe(false);
    expect(shouldRecoverVehicle(2.51, 1.2)).toBe(true);
    expect(shouldRecoverVehicle(0.1, -9)).toBe(true);
  });

  it("maps standard gamepad triggers and steering with a dead zone", () => {
    expect(
      standardGamepadInput({
        steeringAxis: 0.01,
        throttle: 0,
        reverse: 0,
        handbrake: false,
      }),
    ).toBeUndefined();
    expect(
      standardGamepadInput(
        {
          steeringAxis: 0.5,
          throttle: 0.8,
          reverse: 0,
          handbrake: false,
        },
        1.2,
      ),
    ).toEqual({
      throttle: 0.8,
      brake: 0,
      steering: -0.6,
      handbrake: false,
    });
  });

  it("tapers engine force at neighborhood-friendly speed limits", () => {
    expect(speedLimitedEngineForce(1, 0)).toBe(-2_300);
    expect(speedLimitedEngineForce(1, 45)).toBeCloseTo(-1_725);
    expect(speedLimitedEngineForce(1, 90)).toBe(-0);
    expect(speedLimitedEngineForce(-1, 32)).toBe(0);
  });

  it("softens abrupt steering only at higher road speeds", () => {
    expect(speedAdjustedSteeringAngle(1, 20)).toBeCloseTo(0.48);
    expect(speedAdjustedSteeringAngle(1, 90)).toBeCloseTo(0.336);
    expect(speedAdjustedSteeringAngle(-1, 90)).toBeCloseTo(-0.336);
  });

  it("brakes for a car ahead without blocking a neighboring lane or a car behind", () => {
    expect(
      racerProximityBrake({
        forwardX: 0,
        forwardZ: -1,
        offsetX: 0,
        offsetZ: -4.5,
      }),
    ).toBe(1);
    expect(
      racerProximityBrake({
        forwardX: 0,
        forwardZ: -1,
        offsetX: 0,
        offsetZ: -8,
      }),
    ).toBeGreaterThan(0);
    expect(
      racerProximityBrake({
        forwardX: 0,
        forwardZ: -1,
        offsetX: 2.5,
        offsetZ: 0,
      }),
    ).toBe(0);
    expect(
      racerProximityBrake({
        forwardX: 0,
        forwardZ: -1,
        offsetX: 0,
        offsetZ: 5,
      }),
    ).toBe(0);
  });
});
