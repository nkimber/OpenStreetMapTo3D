import { describe, expect, it } from "vitest";
import {
  isVehiclePoseSafe,
  neutralVehicleInput,
  shouldRecoverVehicle,
  smoothVehicleInput,
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
});
