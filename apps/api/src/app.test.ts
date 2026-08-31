import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { DatabasePool } from "./database.js";

const config: AppConfig = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused",
  API_PORT: 3000,
  PUBLIC_APP_URL: "http://localhost:5173",
  NOMINATIM_BASE_URL: "https://nominatim.openstreetmap.org",
  OVERPASS_BASE_URL: "https://overpass-api.de/api/interpreter",
  OSM_USER_AGENT: "OpenStreetMapTo3D/test",
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
