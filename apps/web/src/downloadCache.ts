import type { ImportJob, ImportRequest, Wgs84Bounds } from "@osm3d/contracts";

export const downloadCacheStorageKey = "osm3d.download-cache.v1";
export const downloadCacheLimit = 10;

export interface DownloadCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface DownloadCacheEntry {
  request: ImportRequest;
  job: ImportJob;
  cachedAt: number;
}

function localBrowserStorage(): DownloadCacheStorage | undefined {
  if (typeof window === "undefined") return;
  try {
    return window.localStorage;
  } catch {
    return;
  }
}

function asBounds(value: unknown): Wgs84Bounds | undefined {
  if (!value || typeof value !== "object") return;
  const bounds = value as Record<string, unknown>;
  const west = bounds.west;
  const south = bounds.south;
  const east = bounds.east;
  const north = bounds.north;
  if (
    typeof west !== "number" ||
    !Number.isFinite(west) ||
    typeof south !== "number" ||
    !Number.isFinite(south) ||
    typeof east !== "number" ||
    !Number.isFinite(east) ||
    typeof north !== "number" ||
    !Number.isFinite(north) ||
    west >= east ||
    south >= north
  )
    return;
  return { west, south, east, north };
}

function asRequest(value: unknown): ImportRequest | undefined {
  if (!value || typeof value !== "object") return;
  const request = value as Record<string, unknown>;
  const provider = request.provider;
  const queryVersion = request.queryVersion;
  const bounds = asBounds(request.bounds);
  if (
    (provider !== "fixture" && provider !== "overpass") ||
    typeof queryVersion !== "number" ||
    !Number.isInteger(queryVersion) ||
    queryVersion < 1 ||
    !bounds
  )
    return;
  return { provider, queryVersion, bounds };
}

function asCompletedJob(value: unknown): ImportJob | undefined {
  if (!value || typeof value !== "object") return;
  const job = value as Record<string, unknown>;
  if (
    typeof job.id !== "string" ||
    job.status !== "complete" ||
    job.progress !== 100 ||
    typeof job.stage !== "string" ||
    typeof job.snapshotId !== "string" ||
    !Array.isArray(job.diagnostics) ||
    (job.featureCount !== undefined &&
      (typeof job.featureCount !== "number" ||
        !Number.isInteger(job.featureCount) ||
        job.featureCount < 0))
  )
    return;
  return {
    id: job.id,
    status: "complete",
    progress: 100,
    stage: job.stage,
    snapshotId: job.snapshotId,
    diagnostics: job.diagnostics as ImportJob["diagnostics"],
    ...(typeof job.featureCount === "number"
      ? { featureCount: job.featureCount }
      : {}),
  };
}

function requestKey(request: ImportRequest): string {
  const { bounds } = request;
  return [
    request.provider,
    request.queryVersion,
    bounds.west,
    bounds.south,
    bounds.east,
    bounds.north,
  ].join(":");
}

function loadEntries(
  storage: DownloadCacheStorage | undefined,
): DownloadCacheEntry[] {
  if (!storage) return [];
  try {
    const stored = JSON.parse(storage.getItem(downloadCacheStorageKey) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const entries: DownloadCacheEntry[] = [];
    const keys = new Set<string>();
    for (const value of stored) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Record<string, unknown>;
      const request = asRequest(candidate.request);
      const job = asCompletedJob(candidate.job);
      const cachedAt = candidate.cachedAt;
      if (
        !request ||
        !job ||
        typeof cachedAt !== "number" ||
        !Number.isFinite(cachedAt)
      )
        continue;
      const key = requestKey(request);
      if (keys.has(key)) continue;
      keys.add(key);
      entries.push({ request, job, cachedAt });
    }
    return entries.slice(0, downloadCacheLimit);
  } catch {
    return [];
  }
}

function saveEntries(
  entries: DownloadCacheEntry[],
  storage: DownloadCacheStorage | undefined,
): void {
  try {
    storage?.setItem(downloadCacheStorageKey, JSON.stringify(entries));
  } catch {
    // Browsers may deny or exhaust storage; server-side snapshot reuse still works.
  }
}

export function findCachedDownload(
  request: ImportRequest,
  storage: DownloadCacheStorage | undefined = localBrowserStorage(),
): ImportJob | undefined {
  const key = requestKey(request);
  return loadEntries(storage).find((entry) => requestKey(entry.request) === key)
    ?.job;
}

export function rememberDownloadedData(
  request: ImportRequest,
  job: ImportJob,
  storage: DownloadCacheStorage | undefined = localBrowserStorage(),
): void {
  const completed = asCompletedJob(job);
  if (!completed) return;
  const key = requestKey(request);
  const entries = [
    { request, job: completed, cachedAt: Date.now() },
    ...loadEntries(storage).filter(
      (entry) => requestKey(entry.request) !== key,
    ),
  ].slice(0, downloadCacheLimit);
  saveEntries(entries, storage);
}

export function forgetDownloadedData(
  request: ImportRequest,
  storage: DownloadCacheStorage | undefined = localBrowserStorage(),
): void {
  const key = requestKey(request);
  saveEntries(
    loadEntries(storage).filter((entry) => requestKey(entry.request) !== key),
    storage,
  );
}
