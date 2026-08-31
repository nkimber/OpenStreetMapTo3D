import { describe, expect, it } from "vitest";
import { ElevationSnapshotSchema } from "./index.js";

describe("elevation snapshot contract", () => {
  it("requires the DEM dimensions to match the stored height count", () => {
    const parsed = ElevationSnapshotSchema.safeParse({
      schemaVersion: 1,
      provider: "fixture",
      dataset: "test",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      bounds: { west: -75.1, south: 39.9, east: -75, north: 40 },
      columns: 2,
      rows: 2,
      spacingMeters: { eastWest: 10, northSouth: 10 },
      heights: [1, 2, 3],
      verticalDatum: "test",
      units: "meters",
      minHeight: 1,
      maxHeight: 3,
      contentHash: "a".repeat(64),
      attribution: {
        text: "test",
        url: "https://example.test",
        license: "test",
      },
    });
    expect(parsed.success).toBe(false);
  });
});
