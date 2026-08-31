import { describe, expect, it } from "vitest";
import { neutralVehicleInput, smoothVehicleInput } from "./index.js";

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
});
