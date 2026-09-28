import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CombatEffects, debrisCells, insideFootprint } from "./combat.js";

const square = (size: number) => [
  { x: 0, z: 0 },
  { x: size, z: 0 },
  { x: size, z: size },
  { x: 0, z: size },
  { x: 0, z: 0 },
];

describe("building destruction", () => {
  it("respects courtyards when testing footprint points", () => {
    const building = {
      rings: [
        square(20),
        square(6).map((point) => ({ x: point.x + 7, z: point.z + 7 })),
      ],
    };
    expect(insideFootprint(building, { x: 2, z: 2 })).toBe(true);
    expect(insideFootprint(building, { x: 10, z: 10 })).toBe(false);
    expect(insideFootprint(building, { x: 25, z: 2 })).toBe(false);
  });

  it("splits a house into stacked pieces inside its footprint", () => {
    const cells = debrisCells(
      { rings: [square(10)], height: 9, baseHeight: 2 },
      80,
    );
    expect(cells.length).toBeGreaterThan(8);
    expect(cells.length).toBeLessThanOrEqual(80);
    for (const cell of cells) {
      expect(cell.center.x).toBeGreaterThan(0);
      expect(cell.center.x).toBeLessThan(10);
      expect(cell.center.y).toBeGreaterThan(2);
      expect(cell.center.y).toBeLessThan(11);
    }
    expect(cells.some((cell) => cell.top)).toBe(true);
  });

  it("scatters debris that settles on the ground and is cleaned up", () => {
    const scene = new THREE.Scene();
    const effects = new CombatEffects(scene, () => 0);
    const before = scene.children.length;
    effects.shatter(
      { rings: [square(8)], height: 6, baseHeight: 0 },
      new THREE.Vector3(4, 3, 0),
      "#aa8877",
      "#444444",
    );
    expect(scene.children.length).toBeGreaterThan(before + 10);
    expect(effects.shake).toBeGreaterThan(0);
    for (let t = 0; t < 12; t += 0.05) effects.update(0.05);
    expect(scene.children.length).toBe(before);
    effects.dispose();
  });
});
