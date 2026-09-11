import { describe, expect, it } from "vitest";
import type { ImportJob, ImportRequest } from "@osm3d/contracts";
import {
  downloadCacheLimit,
  downloadCacheStorageKey,
  findCachedDownload,
  forgetDownloadedData,
  rememberDownloadedData,
  type DownloadCacheStorage,
} from "./downloadCache.js";

function memoryStorage(): DownloadCacheStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function request(index = 0): ImportRequest {
  return {
    provider: "overpass",
    queryVersion: 1,
    bounds: {
      west: -75.2 + index / 1_000,
      south: 39.9,
      east: -75.19 + index / 1_000,
      north: 39.91,
    },
  };
}

function completedJob(index = 0): ImportJob {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    status: "complete",
    progress: 100,
    stage: "complete",
    snapshotId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    featureCount: index,
    diagnostics: [],
  };
}

describe("download cache", () => {
  it("does not reuse another orientation with the same envelope", () => {
    const storage = memoryStorage();
    const selection = {
      center: { longitude: -75.2, latitude: 39.9, height: 0 },
      sizeMeters: 1000,
      bearingDegrees: 30,
    };
    const rotated = { ...request(), selection };
    rememberDownloadedData(rotated, completedJob(8), storage);
    expect(findCachedDownload(rotated, storage)?.featureCount).toBe(8);
    expect(
      findCachedDownload(
        {
          ...rotated,
          selection: {
            ...selection,
            center: { latitude: 39.9, longitude: -75.2, height: 0 },
          },
        },
        storage,
      )?.featureCount,
    ).toBe(8);
    expect(
      findCachedDownload(
        { ...rotated, selection: { ...selection, bearingDegrees: 60 } },
        storage,
      ),
    ).toBeUndefined();
    expect(findCachedDownload(request(), storage)).toBeUndefined();
  });
  it("reuses a successful import only for the exact request", () => {
    const storage = memoryStorage();
    rememberDownloadedData(request(), completedJob(4), storage);

    expect(findCachedDownload(request(), storage)?.featureCount).toBe(4);
    expect(findCachedDownload(request(1), storage)).toBeUndefined();
    expect(
      findCachedDownload({ ...request(), queryVersion: 2 }, storage),
    ).toBeUndefined();
  });

  it("stores only complete imports and can invalidate a stale reference", () => {
    const storage = memoryStorage();
    rememberDownloadedData(
      request(),
      { ...completedJob(), status: "failed", stage: "failed" },
      storage,
    );
    expect(findCachedDownload(request(), storage)).toBeUndefined();

    rememberDownloadedData(request(), completedJob(), storage);
    forgetDownloadedData(request(), storage);
    expect(findCachedDownload(request(), storage)).toBeUndefined();
  });

  it("keeps the ten most recently cached areas", () => {
    const storage = memoryStorage();
    for (let index = 0; index < downloadCacheLimit + 2; index += 1) {
      rememberDownloadedData(request(index), completedJob(index), storage);
    }

    expect(findCachedDownload(request(0), storage)).toBeUndefined();
    expect(findCachedDownload(request(1), storage)).toBeUndefined();
    expect(findCachedDownload(request(2), storage)).toBeDefined();
    expect(
      findCachedDownload(request(downloadCacheLimit + 1), storage),
    ).toBeDefined();
  });

  it("ignores malformed browser data", () => {
    const storage = memoryStorage();
    storage.setItem(downloadCacheStorageKey, "not json");
    expect(findCachedDownload(request(), storage)).toBeUndefined();
  });
});
