import { describe, expect, it } from "vitest";
import {
  BuildingCustomizationSchema,
  SceneEnhancementTileSchema,
  footprintSignature,
  openingWidth,
  validateBuildingOpenings,
} from "./customizations.js";
const ring = [
  [-75, 40],
  [-74.9998, 40],
  [-74.9998, 40.0002],
  [-75, 40.0002],
  [-75, 40],
];
const geometry = { type: "Polygon", coordinates: [ring] };
const draft = () =>
  BuildingCustomizationSchema.parse({
    sourceId: "osm:way:1",
    footprint: footprintSignature(geometry),
    openings: [
      {
        id: "door",
        kind: "garage",
        wall: ring.slice(0, 2),
        fraction: 0.5,
        cars: 3,
      },
    ],
  });
describe("reusable building customizations", () => {
  it("keeps footprint identity across ring reversal and starting vertex", () => {
    const shifted = [...ring.slice(2, -1), ...ring.slice(0, 2), ring[2]!];
    expect(
      footprintSignature({ type: "Polygon", coordinates: [shifted.reverse()] }),
    ).toBe(footprintSignature(geometry));
    expect(
      footprintSignature({
        type: "Polygon",
        coordinates: [ring.map(([x, y]) => [x! + 0.0001, y])],
      }),
    ).not.toBe(footprintSignature(geometry));
  });
  it("supports precisely 1, 2, or 3 garage bays", () => {
    const opening = draft().openings[0]!;
    expect(
      [1, 2, 3].map((cars) =>
        openingWidth({ ...opening, cars: cars as 1 | 2 | 3 }),
      ),
    ).toEqual([2.7, 5.4, 8.1]);
    expect(
      BuildingCustomizationSchema.safeParse({
        ...draft(),
        openings: [{ ...opening, cars: 4 }],
      }).success,
    ).toBe(false);
  });
  it("rejects openings extending beyond a wall or on a different footprint", () => {
    const value = draft();
    expect(validateBuildingOpenings(geometry, value)).toBeUndefined();
    value.openings[0]!.fraction = 0;
    expect(validateBuildingOpenings(geometry, value)).toMatch(/does not fit/);
    value.openings[0]!.wall[0][0] = -76;
    expect(validateBuildingOpenings(geometry, value)).toMatch(/exterior wall/);
  });
  it("requires unique IDs and makes reset an empty customization", () => {
    const value = draft();
    expect(
      BuildingCustomizationSchema.safeParse({
        ...value,
        openings: [...value.openings, ...value.openings],
      }).success,
    ).toBe(false);
    expect(
      BuildingCustomizationSchema.safeParse({ ...value, footprint: "" })
        .success,
    ).toBe(false);
  });
  it("rejects overlapping openings even when a wall is reversed", () => {
    const value = draft();
    value.openings.push({
      ...value.openings[0]!,
      id: "front",
      kind: "front-door",
      wall: [
        ...value.openings[0]!.wall,
      ].reverse() as (typeof value.openings)[0]["wall"],
    });
    expect(validateBuildingOpenings(geometry, value)).toMatch(/overlap/);
    value.openings[1]!.kind = "window";
    value.openings[1]!.sill = 3;
    expect(validateBuildingOpenings(geometry, value)).toBeUndefined();
  });
  it("accepts aerial evidence and landscaping while preserving safe defaults", () => {
    const value = draft();
    expect(value.landscaping).toEqual([]);
    const enhanced = BuildingCustomizationSchema.parse({
      ...value,
      appearance: { roof: "gabled", roofOrientation: "across" },
      landscaping: [
        {
          id: "tree-1",
          kind: "tree",
          point: [-74.9999, 40.0001],
          crownRadius: 2.4,
          height: 7,
          confidence: 0.78,
        },
      ],
      enhancement: {
        provider: "usgs-naip",
        analyzedAt: "2026-09-24T12:00:00.000Z",
        bufferMeters: 30,
        sourceUrl: "https://imagery.nationalmap.gov/",
        attribution: "USGS The National Map — NAIP imagery",
        license: "Public domain",
        roofConfidence: 0.72,
      },
    });
    expect(enhanced.landscaping[0]?.kind).toBe("tree");
    expect(enhanced.appearance.roofOrientation).toBe("across");
  });
  it("validates a bounded driving-scene enhancement result", () => {
    expect(
      SceneEnhancementTileSchema.safeParse({
        center: [-84.2, 34.05],
        sizeMeters: 200,
        analyzedAt: "2026-09-25T12:00:00.000Z",
        imagery: {
          provider: "usgs-naip",
          attribution: "USGS",
          license: "Public domain",
          sourceUrl: "https://example.test/ImageServer",
        },
        customizations: [draft()],
        analyzedBuildings: 1,
        skippedBuildings: 0,
        failedSourceIds: [],
      }).success,
    ).toBe(true);
  });
});
