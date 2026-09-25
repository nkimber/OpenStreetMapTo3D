import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  BuildingEnhancementProposalSchema,
  type MapPoint,
  type NormalizedFeature,
} from "@osm3d/contracts";
import { analyzeAerialImage } from "./aerial.js";

const bounds = {
  west: -75.001,
  south: 39.999,
  east: -74.999,
  north: 40.001,
};

function fromPixel(x: number, y: number): MapPoint {
  return [
    bounds.west + (x / 511) * (bounds.east - bounds.west),
    bounds.north - (y / 511) * (bounds.north - bounds.south),
  ];
}

const ring = [
  fromPixel(230, 230),
  fromPixel(282, 230),
  fromPixel(282, 282),
  fromPixel(230, 282),
  fromPixel(230, 230),
];

const building: NormalizedFeature = {
  sourceId: "osm:way:building",
  sourceType: "way",
  kind: "building",
  geometry: { type: "Polygon", coordinates: [ring] },
  tags: { building: "house" },
  facts: {},
  warnings: [],
};

const road: NormalizedFeature = {
  sourceId: "osm:way:road",
  sourceType: "way",
  kind: "road",
  geometry: {
    type: "LineString",
    coordinates: [fromPixel(332, 170), fromPixel(332, 340)],
  },
  tags: { highway: "residential" },
  facts: {},
  warnings: [],
};

describe("aerial building analysis", () => {
  it("derives a bounded, schema-valid enhancement proposal", async () => {
    const svg =
      Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" fill="#c8b99b"/>
      <rect x="230" y="230" width="52" height="52" fill="#786f68"/>
      <path d="M232 236 L280 276 M232 246 L270 282" stroke="#ded6cb" stroke-width="4"/>
      <rect x="282" y="250" width="52" height="14" fill="#999999"/>
      <rect x="328" y="165" width="10" height="180" fill="#777777"/>
      <circle cx="185" cy="220" r="17" fill="#276f31"/>
      <circle cx="345" cy="305" r="8" fill="#3f8a42"/>
    </svg>`);
    const bytes = await sharp(svg).jpeg().toBuffer();
    const proposal = await analyzeAerialImage(
      bytes,
      bounds,
      building,
      [building, road],
      undefined,
      30,
      "https://example.test/ImageServer",
    );

    expect(BuildingEnhancementProposalSchema.safeParse(proposal).success).toBe(
      true,
    );
    expect(proposal.proposedCustomization.appearance.roofColor).toMatch(
      /^#[0-9a-f]{6}$/,
    );
    expect(proposal.observations.driveway?.detected).toBe(true);
    expect(proposal.proposedCustomization.openings).toHaveLength(1);
    const drivewayEnd =
      proposal.proposedCustomization.openings[0]!.path.at(-1)!;
    const roadLongitude = fromPixel(332, 250)[0];
    const longitudeScale = 111_320 * Math.cos((drivewayEnd[1] * Math.PI) / 180);
    expect(
      Math.abs(drivewayEnd[0] - roadLongitude) * longitudeScale,
    ).toBeCloseTo(3.53, 1);
    expect(proposal.proposedCustomization.landscaping.length).toBeGreaterThan(
      0,
    );
    proposal.proposedCustomization.landscaping.forEach((item) => {
      const distanceToRoad =
        Math.abs(item.point[0] - roadLongitude) *
        111_320 *
        Math.cos((item.point[1] * Math.PI) / 180);
      expect(distanceToRoad).toBeGreaterThanOrEqual(
        3.5 + item.crownRadius + 0.34,
      );
    });
    expect(proposal.imagery.previewDataUrl).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });
});
