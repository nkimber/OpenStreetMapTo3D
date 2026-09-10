import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://osm3d:osm3d-local@localhost:5432/osm3d"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  IMPORT_EXECUTION_MODE: z.enum(["inline", "worker"]).default("inline"),
  PUBLIC_APP_URL: z.url().default("http://localhost:5173"),
  NOMINATIM_BASE_URL: z.url().default("https://nominatim.openstreetmap.org"),
  OVERPASS_BASE_URL: z.url().default("https://overpass-api.de/api/interpreter"),
  USGS_ELEVATION_BASE_URL: z
    .url()
    .default(
      "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples",
    ),
  ELEVATION_SAMPLE_SPACING_METERS: z.coerce
    .number()
    .min(4)
    .max(100)
    .default(10),
  ELEVATION_MAX_GRID_DIMENSION: z.coerce
    .number()
    .int()
    .min(17)
    .max(257)
    .default(129),
  ELEVATION_SAMPLE_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(25)
    .max(950)
    .default(900),
  OSM_USER_AGENT: z.string().min(8).default("StreetRove/0.1 local-development"),
  OSM_CACHE_DIRECTORY: z.string().min(1).default(".data/osm"),
  MAX_IMPORT_AREA_SQUARE_KM: z.coerce.number().positive().default(4),
  MAX_IMPORT_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25_000_000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return ConfigSchema.parse(environment);
}
