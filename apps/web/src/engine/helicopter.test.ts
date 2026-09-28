import { describe, expect, it } from "vitest";
import {
  boundaryPush,
  createFlightState,
  createHelicopterKit,
  headingDegrees,
  neutralFlightInput,
  stepFlight,
  type FlightInput,
  type FlightState,
} from "./helicopter.js";

function fly(input: FlightInput, seconds: number, state = createFlightState()) {
  let next: FlightState = state;
  for (let t = 0; t < seconds; t += 1 / 60)
    next = stepFlight(next, input, 1 / 60);
  return next;
}

describe("helicopter flight", () => {
  it("hovers in place with no input", () => {
    const state = fly(neutralFlightInput, 3);
    expect(
      Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z),
    ).toBe(0);
  });

  it("flies toward -Z when pushing forward at yaw 0 and tilts nose down", () => {
    const state = fly({ forward: 1, yaw: 0, lift: 0 }, 4);
    expect(state.velocity.z).toBeLessThan(-30);
    expect(Math.abs(state.velocity.x)).toBeLessThan(1e-6);
    expect(state.pitch).toBeLessThan(0);
  });

  it("climbs, turns left and levels out again", () => {
    const climbing = fly({ forward: 0, yaw: 1, lift: 1 }, 2);
    expect(climbing.velocity.y).toBeGreaterThan(7);
    expect(climbing.yaw).toBeGreaterThan(1);
    const settled = fly(neutralFlightInput, 5, climbing);
    expect(Math.abs(settled.velocity.y)).toBeLessThan(0.1);
    expect(Math.abs(settled.roll)).toBeLessThan(0.01);
  });

  it("pushes back toward the map outside its bounds", () => {
    const state = createFlightState();
    const bounds = { centerX: 0, centerZ: 0, halfWidth: 100, halfDepth: 100 };
    expect(boundaryPush(state, { x: 50, z: 0 }, bounds, 0.1)).toBe(false);
    expect(boundaryPush(state, { x: 130, z: 0 }, bounds, 0.1)).toBe(true);
    expect(state.velocity.x).toBeLessThan(0);
  });

  it("reports compass headings with left turns going counter-clockwise", () => {
    expect(headingDegrees(0)).toBe(0);
    expect(headingDegrees(Math.PI / 2)).toBe(270);
    expect(headingDegrees(-Math.PI / 2)).toBe(90);
  });

  it("hides the kit as a car and unfolds it fully as a helicopter", () => {
    const kit = createHelicopterKit("#e87939");
    expect(kit.root.visible).toBe(false);
    expect(kit.wheelFold(0)).toBe(0);
    kit.update(1, 1, 1 / 60);
    expect(kit.root.visible).toBe(true);
    expect(kit.wheelFold(1)).toBe(1);
    kit.dispose();
  });
});
