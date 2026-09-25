import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { selectionBounds } from "@osm3d/geo";
import type { AppConfig } from "./config.js";
import type { DatabasePool } from "./database.js";

const config: AppConfig = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused",
  API_PORT: 3000,
  IMPORT_EXECUTION_MODE: "inline",
  PUBLIC_APP_URL: "http://localhost:5173",
  NOMINATIM_BASE_URL: "https://nominatim.openstreetmap.org",
  OVERPASS_BASE_URL: "https://overpass-api.de/api/interpreter",
  USGS_ELEVATION_BASE_URL:
    "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples",
  USGS_NAIP_BASE_URL: "https://example.test/exportImage",
  ELEVATION_SAMPLE_SPACING_METERS: 10,
  ELEVATION_MAX_GRID_DIMENSION: 129,
  ELEVATION_SAMPLE_BATCH_SIZE: 900,
  OSM_USER_AGENT: "StreetRove/test",
  OSM_CACHE_DIRECTORY: ".data/test-osm",
  MAX_IMPORT_AREA_SQUARE_KM: 4,
  MAX_IMPORT_RESPONSE_BYTES: 1_000_000,
  LOG_LEVEL: "silent",
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function mockPool(): DatabasePool {
  return {
    query: vi.fn(async () => ({ rows: [{ value: 1 }], rowCount: 1 })),
  } as unknown as DatabasePool;
}

describe("API boundary behavior", () => {
  it("rejects an inconsistent rotated selection envelope", async () => {
    app = await buildApp({ config, pool: mockPool() });
    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: {
        provider: "fixture",
        bounds: { west: -75.2, south: 39.9, east: -75.19, north: 39.91 },
        selection: {
          center: { longitude: -75.2, latitude: 39.9, height: 0 },
          sizeMeters: 1000,
          bearingDegrees: 45,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_SELECTION");
  });
  it("allows a 4 square km rotated square even though its envelope is larger", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    app = await buildApp({
      config: { ...config, IMPORT_EXECUTION_MODE: "worker" },
      pool: { query } as unknown as DatabasePool,
    });
    const selection = {
      center: { longitude: -84, latitude: 34, height: 0 },
      sizeMeters: 2000,
      bearingDegrees: 45,
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: {
        provider: "fixture",
        bounds: selectionBounds(selection),
        selection,
      },
    });
    expect(response.statusCode).toBe(202);
  });
  it("reports liveness and database readiness", async () => {
    app = await buildApp({ config, pool: mockPool() });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", database: "connected" });
  });

  it("returns structured validation errors", async () => {
    app = await buildApp({ config, pool: mockPool() });
    const response = await app.inject({
      method: "POST",
      url: "/api/geocode",
      payload: { query: "x" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("enforces import area limits before provider or database work", async () => {
    app = await buildApp({ config, pool: mockPool() });
    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: {
        provider: "fixture",
        queryVersion: 1,
        bounds: { west: -75.2, south: 39.9, east: -75.1, north: 40 },
      },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("IMPORT_AREA_TOO_LARGE");
  });
});
