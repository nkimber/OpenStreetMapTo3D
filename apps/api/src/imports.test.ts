import { describe, expect, it, vi } from "vitest";
import type { ImportRequest } from "@osm3d/contracts";
import type { DatabasePool } from "./database.js";
import { areaCovers, createImportJob, importAreaRing } from "./imports.js";

const request: ImportRequest = {
  provider: "overpass",
  queryVersion: 1,
  bounds: { west: -75.2, south: 39.9, east: -75.19, north: 39.91 },
};

describe("import snapshot cache", () => {
  it("includes the rotation in the database cache identity", async () => {
    const selection = {
      center: { longitude: -75.2, latitude: 39.9, height: 0 },
      sizeMeters: 1000,
      bearingDegrees: 30,
    };
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await createImportJob({ query } as unknown as DatabasePool, {
      ...request,
      selection,
    });
    expect(query.mock.calls[0]?.[0]).toContain("snapshot.query->'selection'");
    expect(query.mock.calls[0]?.[1]).toContain(JSON.stringify(selection));
  });
  it("returns a completed job when an identical snapshot is already stored", async () => {
    const snapshotId = "10000000-0000-4000-8000-000000000001";
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: snapshotId, feature_count: 37 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = await createImportJob(
      { query } as unknown as DatabasePool,
      request,
    );

    expect(job).toMatchObject({
      status: "complete",
      progress: 100,
      stage: "cached",
      snapshotId,
      featureCount: 37,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toContain("complete");
  });

  it("queues a new import when no matching snapshot exists", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = await createImportJob(
      { query } as unknown as DatabasePool,
      request,
    );

    expect(job).toMatchObject({
      status: "queued",
      progress: 0,
      stage: "queued",
    });
    expect(job.snapshotId).toBeUndefined();
    expect(query.mock.calls[2]?.[1]).toContain("queued");
  });

  it("only considers the five most recent downloads for area reuse", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await createImportJob({ query } as unknown as DatabasePool, request);
    expect(query.mock.calls[1]?.[0]).toContain("LIMIT 5");
    expect(query.mock.calls[1]?.[0]).toContain("derivedFrom");
  });

  it("builds a smaller selection from a larger earlier download", async () => {
    const parentId = "20000000-0000-4000-8000-000000000002";
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: parentId,
            query: {
              query: "overpass",
              bounds: { west: -75.3, south: 39.8, east: -75.1, north: 40 },
            },
            content_hash: "a".repeat(64),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const clientQuery = vi
      .fn()
      .mockImplementation((sql: string) =>
        Promise.resolve(
          sql.startsWith("SELECT COUNT")
            ? { rows: [{ count: 12 }], rowCount: 1 }
            : { rows: [], rowCount: 1 },
        ),
      );
    const release = vi.fn();
    const pool = {
      query,
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
    } as unknown as DatabasePool;

    const job = await createImportJob(pool, request);

    expect(job).toMatchObject({
      status: "complete",
      stage: "cached-area",
      featureCount: 12,
    });
    const copy = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO osm_features"),
    );
    expect(copy?.[0]).toContain("ST_Intersects");
    expect(copy?.[1]).toContain(parentId);
    expect(release).toHaveBeenCalled();
  });
});

describe("downloaded area coverage", () => {
  const outer = importAreaRing({
    bounds: { west: 0, south: 0, east: 10, north: 10 },
  });

  it("accepts areas inside or matching an earlier download", () => {
    expect(
      areaCovers(
        outer,
        importAreaRing({ bounds: { west: 2, south: 2, east: 8, north: 8 } }),
      ),
    ).toBe(true);
    expect(areaCovers(outer, outer)).toBe(true);
  });

  it("rejects areas that extend beyond it", () => {
    expect(
      areaCovers(
        outer,
        importAreaRing({ bounds: { west: 5, south: 5, east: 11, north: 8 } }),
      ),
    ).toBe(false);
  });

  it("uses the rotated selection rather than its bounding box", () => {
    const rotated = importAreaRing({
      bounds: { west: -75.21, south: 39.89, east: -75.19, north: 39.91 },
      selection: {
        center: { longitude: -75.2, latitude: 39.9, height: 0 },
        sizeMeters: 1000,
        bearingDegrees: 45,
      },
    });
    const corner = importAreaRing({
      bounds: {
        west: -75.2058,
        south: 39.8943,
        east: -75.2052,
        north: 39.8947,
      },
    });
    expect(areaCovers(rotated, corner)).toBe(false);
  });
});
