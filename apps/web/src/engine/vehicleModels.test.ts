import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultVehicleChoice,
  parseVehicleChoice,
  rivalVehicleChoices,
  vehicles,
} from "./vehicleModels.js";

describe("vehicle catalog", () => {
  it("validates persisted choices and rejects corrupt or obsolete preferences", () => {
    for (const value of [
      null,
      "broken",
      '{"id":"unknown","color":"#ffffff"}',
      '{"id":"sedan","color":"red"}',
    ])
      expect(parseVehicleChoice(value)).toEqual(defaultVehicleChoice);
    expect(parseVehicleChoice('{"id":"suv","color":"#123abc"}')).toEqual({
      id: "suv",
      color: "#123abc",
    });
  });
  it("gives every rival the selected model with a distinct paint color", () => {
    const choices = rivalVehicleChoices({ id: "suv", color: "#2F8FEA" });
    expect(choices).toHaveLength(3);
    expect(choices.every((choice) => choice.id === "suv")).toBe(true);
    expect(new Set(choices.map((choice) => choice.color)).size).toBe(3);
    expect(choices.some((choice) => choice.color === "#2f8fea")).toBe(false);
  });
  for (const vehicle of vehicles)
    it(`${vehicle.id} is a local GLB with four named drive wheels`, () => {
      const file = readFileSync(
        new URL(
          `../../public/models/vehicles/${vehicle.id}.glb`,
          import.meta.url,
        ),
      );
      expect(file.toString("utf8", 0, 4)).toBe("glTF");
      const json = JSON.parse(
        file.toString("utf8", 20, 20 + file.readUInt32LE(12)),
      ) as {
        nodes: { name: string; mesh: number }[];
        meshes: { primitives: { attributes: { TEXCOORD_0: number } }[] }[];
        accessors: { bufferView: number; count: number; byteOffset?: number }[];
        bufferViews: { byteOffset?: number; byteStride?: number }[];
        images: { uri?: string; bufferView?: number }[];
      };
      const body = json.nodes.find((node) => node.name === "body")!;
      const accessor =
        json.accessors[
          json.meshes[body.mesh]!.primitives[0]!.attributes.TEXCOORD_0
        ]!;
      const view = json.bufferViews[accessor.bufferView]!;
      let paintVertices = 0;
      for (let i = 0; i < accessor.count; i++) {
        const offset =
          28 +
          file.readUInt32LE(12) +
          (view.byteOffset ?? 0) +
          (accessor.byteOffset ?? 0) +
          i * (view.byteStride ?? 8);
        if (
          Math.floor(file.readFloatLE(offset) * 8) === vehicle.paintColumn &&
          file.readFloatLE(offset + 4) > 0.25 &&
          file.readFloatLE(offset + 4) < 0.5
        )
          paintVertices++;
      }
      expect(paintVertices).toBeGreaterThan(100);
      for (const axle of ["front", "back"])
        for (const side of ["left", "right"])
          expect(
            json.nodes.some((node) => node.name === `wheel-${axle}-${side}`),
          ).toBe(true);
      expect(
        json.images.every(
          (image) =>
            image.bufferView !== undefined ||
            (image.uri === "Textures/colormap.png" &&
              readFileSync(
                new URL(
                  "../../public/models/vehicles/Textures/colormap.png",
                  import.meta.url,
                ),
              ).length > 0),
        ),
      ).toBe(true);
    });
});
