import { z } from "zod";

export const MapPointSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);
export type MapPoint = z.infer<typeof MapPointSchema>;
export const OpeningSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(["front-door", "garage", "window"]),
  wall: z.tuple([MapPointSchema, MapPointSchema]),
  fraction: z.number().min(0).max(1),
  cars: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  width: z.number().min(0.5).max(4).default(1),
  sill: z.number().min(0).max(100).default(1),
  roadId: z.string().max(200).optional(),
  path: z.array(MapPointSchema).max(100).default([]),
});
export type BuildingOpening = z.infer<typeof OpeningSchema>;
export const LandscapingFeatureSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(["tree", "bush"]),
  point: MapPointSchema,
  crownRadius: z.number().min(0.4).max(15),
  height: z.number().min(0.4).max(30),
  confidence: z.number().min(0).max(1),
});
export type LandscapingFeature = z.infer<typeof LandscapingFeatureSchema>;

export const BuildingEnhancementEvidenceSchema = z.object({
  provider: z.literal("usgs-naip"),
  analyzedAt: z.iso.datetime(),
  bufferMeters: z.number().min(10).max(60),
  sourceUrl: z.url(),
  attribution: z.string().min(1),
  license: z.string().min(1),
  roofConfidence: z.number().min(0).max(1),
  drivewayConfidence: z.number().min(0).max(1).optional(),
  vegetationConfidence: z.number().min(0).max(1).optional(),
});
export type BuildingEnhancementEvidence = z.infer<
  typeof BuildingEnhancementEvidenceSchema
>;

export const BuildingCustomizationSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    revision: z.number().int().nonnegative().default(0),
    footprint: z.string().max(200_000),
    openings: z.array(OpeningSchema).max(100).default([]),
    appearance: z
      .object({
        roof: z.enum(["gabled", "hipped", "flat"]).optional(),
        roofOrientation: z.enum(["along", "across"]).optional(),
        wallColor: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .optional(),
        roofColor: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .optional(),
        material: z.enum(["brick", "siding", "stucco"]).optional(),
      })
      .default({}),
    boundaries: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          kind: z.enum(["fence", "gate", "garden"]),
          points: z.array(MapPointSchema).min(2).max(100),
        }),
      )
      .max(100)
      .default([]),
    landscaping: z.array(LandscapingFeatureSchema).max(40).default([]),
    enhancement: BuildingEnhancementEvidenceSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      !value.footprint &&
      (value.openings.length ||
        value.boundaries.length ||
        value.landscaping.length ||
        value.enhancement ||
        Object.keys(value.appearance).length)
    )
      context.addIssue({
        code: "custom",
        message: "Only a reset can have an empty footprint.",
      });
    const ids = [
      ...value.openings,
      ...value.boundaries,
      ...value.landscaping,
    ].map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Item IDs must be unique." });
  });
export type BuildingCustomization = z.infer<typeof BuildingCustomizationSchema>;

export const BuildingEnhancementProposalSchema = z.object({
  sourceId: z.string().min(1).max(200),
  bufferMeters: z.number().min(10).max(60),
  imagery: z.object({
    previewDataUrl: z.string().startsWith("data:image/"),
    analyzedAt: z.iso.datetime(),
    provider: z.literal("usgs-naip"),
    attribution: z.string().min(1),
    license: z.string().min(1),
    sourceUrl: z.url(),
  }),
  observations: z.object({
    roof: z.object({
      shape: z.enum(["gabled", "hipped", "flat"]),
      orientation: z.enum(["along", "across"]),
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      confidence: z.number().min(0).max(1),
    }),
    driveway: z
      .object({
        detected: z.boolean(),
        confidence: z.number().min(0).max(1),
      })
      .optional(),
    landscaping: z.object({
      trees: z.number().int().nonnegative(),
      bushes: z.number().int().nonnegative(),
      confidence: z.number().min(0).max(1),
    }),
  }),
  proposedCustomization: BuildingCustomizationSchema,
  warnings: z.array(z.string()).max(20),
});
export type BuildingEnhancementProposal = z.infer<
  typeof BuildingEnhancementProposalSchema
>;

export const SceneEnhancementTileSchema = z.object({
  center: MapPointSchema,
  sizeMeters: z.number().min(100).max(400),
  analyzedAt: z.iso.datetime(),
  imagery: z.object({
    provider: z.literal("usgs-naip"),
    attribution: z.string().min(1),
    license: z.string().min(1),
    sourceUrl: z.url(),
  }),
  customizations: z.array(BuildingCustomizationSchema).max(60),
  analyzedBuildings: z.number().int().nonnegative(),
  skippedBuildings: z.number().int().nonnegative(),
  failedSourceIds: z.array(z.string().min(1).max(200)).max(60),
});
export type SceneEnhancementTile = z.infer<typeof SceneEnhancementTileSchema>;

/** Stable across ring order, starting vertex, winding, and world origin changes. */
export function footprintSignature(geometry: {
  type: string;
  coordinates: unknown;
}): string {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return JSON.stringify(
    (polygons as number[][][][])
      .map((polygon) =>
        polygon
          .map((ring) => {
            const vertices = ring.map(
              (p) => `${p[0]!.toFixed(7)},${p[1]!.toFixed(7)}`,
            );
            return vertices
              .slice(0, -1)
              .map((a, i) => [a, vertices[i + 1]!].sort().join(":"))
              .sort();
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

export function openingWidth(opening: BuildingOpening): number {
  return opening.kind === "garage"
    ? { 1: 2.7, 2: 5.4, 3: 8.1 }[opening.cars]
    : opening.width;
}

export function validateBuildingOpenings(
  geometry: { type: string; coordinates: unknown },
  value: BuildingCustomization,
): string | undefined {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  const key = (p: number[]) => `${p[0]!.toFixed(7)},${p[1]!.toFixed(7)}`;
  const walls = (polygons as number[][][][]).flatMap((polygon) =>
    (polygon[0] ?? []).slice(0, -1).map((a, i) => [a, polygon[0]![i + 1]!]),
  );
  for (const opening of value.openings) {
    const [a, b] = opening.wall;
    if (
      !walls.some(
        ([c, d]) =>
          (key(a) === key(c!) && key(b) === key(d!)) ||
          (key(a) === key(d!) && key(b) === key(c!)),
      )
    )
      return "An opening is no longer attached to an exterior wall.";
    const length = Math.hypot(
      (b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180),
      (b[1] - a[1]) * 111320,
    );
    const margin = (openingWidth(opening) / 2 + 0.1) / length;
    if (opening.fraction < margin || opening.fraction > 1 - margin)
      return "The door or window does not fit on this wall. Choose a wider wall or a smaller opening.";
  }
  for (let i = 0; i < value.openings.length; i++) {
    const a = value.openings[i]!;
    for (const b of value.openings.slice(i + 1)) {
      const same =
        key(a.wall[0]) === key(b.wall[0]) && key(a.wall[1]) === key(b.wall[1]);
      const reversed =
        key(a.wall[0]) === key(b.wall[1]) && key(a.wall[1]) === key(b.wall[0]);
      if (!same && !reversed) continue;
      const length = Math.hypot(
        (a.wall[1][0] - a.wall[0][0]) *
          111320 *
          Math.cos((a.wall[0][1] * Math.PI) / 180),
        (a.wall[1][1] - a.wall[0][1]) * 111320,
      );
      const sillA = a.kind === "window" ? a.sill : 0,
        sillB = b.kind === "window" ? b.sill : 0;
      const height = (kind: string) =>
        kind === "window" ? 1.3 : kind === "garage" ? 2.3 : 2.1;
      if (
        Math.abs(a.fraction - (same ? b.fraction : 1 - b.fraction)) * length <
          (openingWidth(a) + openingWidth(b)) / 2 + 0.1 &&
        sillA < sillB + height(b.kind) &&
        sillB < sillA + height(a.kind)
      )
        return "Doors and windows must not overlap. Move an opening along its wall.";
    }
  }
  return undefined;
}
