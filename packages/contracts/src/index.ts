import { z } from "zod";

export const Wgs84PositionSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  height: z.number().finite().default(0),
});

export type Wgs84Position = z.infer<typeof Wgs84PositionSchema>;

export const Wgs84BoundsSchema = z
  .object({
    west: z.number().min(-180).max(180),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
  })
  .refine((bounds) => bounds.east > bounds.west, {
    message: "East must be greater than west",
    path: ["east"],
  })
  .refine((bounds) => bounds.north > bounds.south, {
    message: "North must be greater than south",
    path: ["north"],
  });

export type Wgs84Bounds = z.infer<typeof Wgs84BoundsSchema>;

export type GeoJsonPosition = [number, number] | [number, number, number];

export type GeoJsonGeometry =
  | { type: "Point"; coordinates: GeoJsonPosition }
  | { type: "LineString"; coordinates: GeoJsonPosition[] }
  | { type: "Polygon"; coordinates: GeoJsonPosition[][] }
  | { type: "MultiPolygon"; coordinates: GeoJsonPosition[][][] };

export const DiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1),
  sourceId: z.string().optional(),
});

export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const AttributionSchema = z.object({
  text: z.string().min(1),
  url: z.url(),
  license: z.string().min(1),
});

export type Attribution = z.infer<typeof AttributionSchema>;

export const FeatureKindSchema = z.enum([
  "road",
  "building",
  "land",
  "water",
  "barrier",
]);

export type FeatureKind = z.infer<typeof FeatureKindSchema>;

export const NormalizedFeatureSchema = z.object({
  sourceId: z.string().min(1),
  sourceType: z.enum(["node", "way", "relation"]),
  sourceVersion: z.number().int().nonnegative().optional(),
  kind: FeatureKindSchema,
  geometry: z.custom<GeoJsonGeometry>((value) => {
    if (!value || typeof value !== "object") return false;
    return "type" in value && "coordinates" in value;
  }),
  tags: z.record(z.string(), z.string()),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  warnings: z.array(DiagnosticSchema),
});

export type NormalizedFeature = z.infer<typeof NormalizedFeatureSchema>;

export const GeocodeRequestSchema = z.object({
  query: z.string().trim().min(2).max(250),
});

export const GeocodeResultSchema = z.object({
  displayName: z.string(),
  longitude: z.number(),
  latitude: z.number(),
  bounds: Wgs84BoundsSchema.optional(),
  type: z.string().optional(),
});

export type GeocodeResult = z.infer<typeof GeocodeResultSchema>;

export const ImportRequestSchema = z.object({
  provider: z.enum(["overpass", "fixture"]),
  bounds: Wgs84BoundsSchema,
  queryVersion: z.number().int().positive().default(1),
});

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ImportJobSchema = z.object({
  id: z.uuid(),
  status: JobStatusSchema,
  progress: z.number().int().min(0).max(100),
  stage: z.string(),
  snapshotId: z.uuid().optional(),
  featureCount: z.number().int().nonnegative().optional(),
  diagnostics: z.array(DiagnosticSchema).default([]),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

export type ImportJob = z.infer<typeof ImportJobSchema>;

export const SnapshotPreviewSchema = z.object({
  snapshotId: z.uuid(),
  attribution: z.array(AttributionSchema),
  features: z.array(NormalizedFeatureSchema),
  diagnostics: z.array(DiagnosticSchema),
  stats: z.object({
    roads: z.number().int().nonnegative(),
    buildings: z.number().int().nonnegative(),
    land: z.number().int().nonnegative(),
    water: z.number().int().nonnegative(),
    barriers: z.number().int().nonnegative(),
    estimatedBuildingHeights: z.number().int().nonnegative(),
  }),
});

export type SnapshotPreview = z.infer<typeof SnapshotPreviewSchema>;

export const GenerationSettingsSchema = z.object({
  buildingLevelHeight: z.number().min(2).max(6).default(3),
  defaultBuildingHeight: z.number().min(2).max(100).default(8),
  includeMinorPaths: z.boolean().default(true),
  buildingCollisions: z.boolean().default(true),
  seed: z.number().int().default(1),
  visualStyle: z.enum(["clean", "colorful", "night"]).default("clean"),
});

export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;

export const WorldOverrideSchema = z.object({
  id: z.uuid().optional(),
  targetId: z.string().min(1),
  operation: z.enum(["set-height", "set-width", "set-visible", "set-spawn"]),
  payloadVersion: z.number().int().positive().default(1),
  payload: z.record(z.string(), z.unknown()),
});

export type WorldOverride = z.infer<typeof WorldOverrideSchema>;

export const WorldCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  snapshotId: z.uuid(),
  bounds: Wgs84BoundsSchema,
  anchor: Wgs84PositionSchema,
  settings: GenerationSettingsSchema,
});

export type WorldCreateRequest = z.infer<typeof WorldCreateRequestSchema>;

export const WorldSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  snapshotId: z.uuid(),
  bounds: Wgs84BoundsSchema,
  anchor: Wgs84PositionSchema,
  settings: GenerationSettingsSchema,
  generatorVersion: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type WorldSummary = z.infer<typeof WorldSummarySchema>;

export const WorldDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive(),
  world: WorldSummarySchema,
  attribution: z.array(AttributionSchema),
  features: z.array(NormalizedFeatureSchema),
  overrides: z.array(WorldOverrideSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export type WorldDefinition = z.infer<typeof WorldDefinitionSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
