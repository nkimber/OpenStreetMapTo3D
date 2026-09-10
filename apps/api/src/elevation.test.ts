import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import {
  createFixtureElevation,
  Usgs3depElevationProvider,
} from "./elevation.js";

const bounds = {
  west: -75.01,
  south: 39.99,
  east: -74.99,
  north: 40.01,
};

const config: AppConfig = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused",
  API_PORT: 3000,
  IMPORT_EXECUTION_MODE: "inline",
  PUBLIC_APP_URL: "http://localhost:5173",
  NOMINATIM_BASE_URL: "https://nominatim.openstreetmap.org",
  OVERPASS_BASE_URL: "https://overpass-api.de/api/interpreter",
  USGS_ELEVATION_BASE_URL: "https://example.test/getSamples",
  ELEVATION_SAMPLE_SPACING_METERS: 100,
  ELEVATION_MAX_GRID_DIMENSION: 17,
  ELEVATION_SAMPLE_BATCH_SIZE: 25,
  OSM_USER_AGENT: "StreetRove/test",
  OSM_CACHE_DIRECTORY: ".data/test-osm",
  MAX_IMPORT_AREA_SQUARE_KM: 4,
  MAX_IMPORT_RESPONSE_BYTES: 1_000_000,
  LOG_LEVEL: "silent",
};

describe("elevation providers", () => {
  it("creates a deterministic synthetic neighborhood slope", () => {
    const first = createFixtureElevation(bounds);
    const repeated = createFixtureElevation(bounds);
    expect(first.contentHash).toBe(repeated.contentHash);
    expect(first.maxHeight - first.minHeight).toBeGreaterThan(20);
    expect(first.heights).toHaveLength(first.columns * first.rows);
  });

  it("batches USGS multipoint samples into an immutable grid", async () => {
    const fetchImplementation = vi.fn(async (_input, init) => {
      const parameters = init?.body as URLSearchParams;
      const geometry = JSON.parse(parameters.get("geometry") ?? "{}") as {
        points: [number, number][];
      };
      return new Response(
        JSON.stringify({
          samples: geometry.points.map(([longitude, latitude], locationId) => ({
            locationId,
            value: String(100 + (longitude + 75) * 10 + (latitude - 40) * 20),
            resolution: 1,
            attributes: {
              VerticalDatum: "NAVD 88",
              ProductName: "USGS_3DEP",
            },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const snapshot = await new Usgs3depElevationProvider(
      config,
      fetchImplementation,
    ).fetch(bounds);
    expect(snapshot.provider).toBe("usgs-3dep");
    expect(snapshot.dataset).toBe("USGS_3DEP");
    expect(snapshot.heights).toHaveLength(snapshot.columns * snapshot.rows);
    expect(fetchImplementation).toHaveBeenCalledTimes(
      Math.ceil(snapshot.heights.length / config.ELEVATION_SAMPLE_BATCH_SIZE),
    );
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
