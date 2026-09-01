import { describe, expect, it, vi } from "vitest";
import type { ImportRequest } from "@osm3d/contracts";
import type { DatabasePool } from "./database.js";
import { createImportJob } from "./imports.js";

const request: ImportRequest = {
  provider: "overpass",
  queryVersion: 1,
  bounds: { west: -75.2, south: 39.9, east: -75.19, north: 39.91 },
};

describe("import snapshot cache", () => {
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
    expect(query.mock.calls[1]?.[1]).toContain("queued");
  });
});
