import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type {
  AreaSelection,
  Diagnostic,
  ImportJob,
  ImportRequest,
  Wgs84Bounds,
} from "@osm3d/contracts";
import { selectionRing } from "@osm3d/geo";
import { normalizeOverpass } from "@osm3d/osm";
import type { AppConfig } from "./config.js";
import type { DatabasePool } from "./database.js";
import { fetchElevationData } from "./elevation.js";
import { fetchOsmData } from "./providers.js";

const gzipAsync = promisify(gzip);

interface CachedSnapshot {
  id: string;
  feature_count: number;
}

function boundsPolygon(bounds: Wgs84Bounds): object {
  return {
    type: "Polygon",
    coordinates: [
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.south],
        [bounds.east, bounds.north],
        [bounds.west, bounds.north],
        [bounds.west, bounds.south],
      ],
    ],
  };
}

/** Downloaded areas kept available for reuse by later, overlapping selections. */
export const REUSABLE_DOWNLOAD_AREAS = 5;

type Ring = [number, number][];

/** The exact area an import covers: the rotated selection, or its bounds. */
export function importAreaRing(
  request: Pick<ImportRequest, "bounds" | "selection">,
): Ring {
  if (request.selection) return selectionRing(request.selection);
  const { west, south, east, north } = request.bounds;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

function onSegment(
  point: [number, number],
  a: [number, number],
  b: [number, number],
) {
  const [px, py] = point;
  const [ax, ay] = a;
  const [bx, by] = b;
  const length = Math.hypot(bx - ax, by - ay) || 1;
  const cross =
    Math.abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / length;
  const within =
    px >= Math.min(ax, bx) - 1e-9 &&
    px <= Math.max(ax, bx) + 1e-9 &&
    py >= Math.min(ay, by) - 1e-9 &&
    py <= Math.max(ay, by) + 1e-9;
  return cross < 1e-9 && within;
}

function ringContainsPoint(ring: Ring, point: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (onSegment(point, a, b)) return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** Selection areas are convex quadrilaterals, so corner containment suffices. */
export function areaCovers(outer: Ring, inner: Ring): boolean {
  return inner.every((point) => ringContainsPoint(outer, point));
}

interface ReusableSnapshot {
  id: string;
  query: {
    query?: string;
    bounds: Wgs84Bounds;
    selection?: AreaSelection;
    elevationProvider?: string;
    elevationDataset?: string;
  };
  content_hash: string;
  cache_path: string;
  attribution: string;
  license_url: string;
  elevation_snapshot: unknown | null;
  elevation_content_hash: string | null;
}

/**
 * Serves an import from one of the most recent downloads when that area fully
 * contains the new one: features are trimmed to the new area exactly as the
 * Overpass query would have selected them, and the georeferenced elevation grid
 * is shared, so neither OpenStreetMap nor USGS is contacted again.
 */
async function deriveFromDownloadedArea(
  pool: DatabasePool,
  request: ImportRequest,
): Promise<{ snapshotId: string; featureCount: number } | undefined> {
  const recent = await pool.query<ReusableSnapshot>(
    `SELECT id, query, content_hash, cache_path, attribution, license_url,
            elevation_snapshot, elevation_content_hash
     FROM source_snapshots
     WHERE provider = $1 AND query_version = $2 AND NOT (query ? 'derivedFrom')
     ORDER BY retrieved_at DESC
     LIMIT ${REUSABLE_DOWNLOAD_AREAS}`,
    [request.provider, request.queryVersion],
  );
  const area = importAreaRing(request);
  const parent = recent?.rows.find((row) =>
    areaCovers(importAreaRing(row.query), area),
  );
  if (!parent) return undefined;

  const areaJson = JSON.stringify({ type: "Polygon", coordinates: [area] });
  const contentHash = createHash("sha256")
    .update(
      `${parent.content_hash}:${JSON.stringify(request.bounds)}:${JSON.stringify(request.selection ?? null)}`,
    )
    .digest("hex");
  const client = await pool.connect();
  let snapshotId: string = randomUUID();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO source_snapshots
         (id, provider, query_version, bounds, query, retrieved_at, content_hash, cache_path, attribution, license_url,
          elevation_snapshot, elevation_content_hash)
       SELECT $1, provider, query_version, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4::jsonb,
              retrieved_at, $5, cache_path, attribution, license_url, elevation_snapshot, elevation_content_hash
       FROM source_snapshots WHERE id = $2
       ON CONFLICT (provider, content_hash) DO NOTHING`,
      [
        snapshotId,
        parent.id,
        JSON.stringify(boundsPolygon(request.bounds)),
        JSON.stringify({
          ...(parent.query.query ? { query: parent.query.query } : {}),
          bounds: request.bounds,
          ...(request.selection ? { selection: request.selection } : {}),
          ...(parent.query.elevationProvider
            ? { elevationProvider: parent.query.elevationProvider }
            : {}),
          ...(parent.query.elevationDataset
            ? { elevationDataset: parent.query.elevationDataset }
            : {}),
          derivedFrom: parent.id,
        }),
        contentHash,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM source_snapshots WHERE provider = $1 AND content_hash = $2",
        [request.provider, contentHash],
      );
      snapshotId = existing.rows[0]?.id ?? snapshotId;
    }
    // Overpass returns every way intersecting the query area with its full
    // geometry, so the same intersection test reproduces a fresh download.
    await client.query(
      `INSERT INTO osm_features
         (snapshot_id, source_id, source_type, feature_kind, geometry, tags, facts, warnings, geometry_hash)
       SELECT $1, source_id, source_type, feature_kind, geometry, tags, facts, warnings, geometry_hash
       FROM osm_features
       WHERE snapshot_id = $2
         AND ST_Intersects(geometry, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))
       ON CONFLICT (snapshot_id, source_id) DO NOTHING`,
      [snapshotId, parent.id, areaJson],
    );
    const counted = await client.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM osm_features WHERE snapshot_id = $1",
      [snapshotId],
    );
    await client.query("COMMIT");
    return { snapshotId, featureCount: counted.rows[0]?.count ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createImportJob(
  pool: DatabasePool,
  request: ImportRequest,
): Promise<ImportJob> {
  const id = randomUUID();
  const cached = await pool.query<CachedSnapshot>(
    `SELECT snapshot.id, COUNT(feature.source_id)::integer AS feature_count
     FROM source_snapshots snapshot
     LEFT JOIN osm_features feature ON feature.snapshot_id = snapshot.id
     WHERE snapshot.provider = $1
       AND snapshot.query_version = $2
       AND snapshot.query->'bounds' = $3::jsonb
       AND COALESCE(snapshot.query->'selection', 'null'::jsonb) = $4::jsonb
     GROUP BY snapshot.id, snapshot.retrieved_at
     ORDER BY snapshot.retrieved_at DESC
     LIMIT 1`,
    [
      request.provider,
      request.queryVersion,
      JSON.stringify(request.bounds),
      JSON.stringify(request.selection ?? null),
    ],
  );
  const snapshot =
    cached.rows[0] ??
    (await deriveFromDownloadedArea(pool, request).then((derived) =>
      derived
        ? { id: derived.snapshotId, feature_count: derived.featureCount }
        : undefined,
    ));
  const reusedArea = !cached.rows[0] && Boolean(snapshot);
  const stage = snapshot ? (reusedArea ? "cached-area" : "cached") : "queued";
  const result = snapshot
    ? {
        snapshotId: snapshot.id,
        featureCount: snapshot.feature_count,
        diagnostics: [],
      }
    : undefined;
  await pool.query(
    `INSERT INTO jobs
       (id, job_type, status, input, progress, stage, result, completed_at)
     VALUES
       ($1, 'osm-import', $3, $2::jsonb, $4, $5, $6::jsonb,
        CASE WHEN $3 = 'complete' THEN now() ELSE NULL END)`,
    [
      id,
      JSON.stringify(request),
      snapshot ? "complete" : "queued",
      snapshot ? 100 : 0,
      stage,
      result ? JSON.stringify(result) : null,
    ],
  );
  return {
    id,
    status: snapshot ? "complete" : "queued",
    progress: snapshot ? 100 : 0,
    stage,
    diagnostics: [],
    ...(snapshot
      ? { snapshotId: snapshot.id, featureCount: snapshot.feature_count }
      : {}),
  };
}

async function updateJob(
  pool: DatabasePool,
  id: string,
  status: ImportJob["status"],
  progress: number,
  stage: string,
  result?: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = $2, progress = $3, stage = $4,
       result = COALESCE($5::jsonb, result),
       started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
       completed_at = CASE WHEN $2 IN ('complete', 'failed', 'cancelled') THEN now() ELSE completed_at END
     WHERE id = $1`,
    [id, status, progress, stage, result ? JSON.stringify(result) : null],
  );
}

export async function executeImportJob(
  pool: DatabasePool,
  config: AppConfig,
  id: string,
  request: ImportRequest,
): Promise<void> {
  try {
    await updateJob(pool, id, "running", 10, "downloading-map-and-elevation");
    const [{ raw, query }, elevation] = await Promise.all([
      fetchOsmData(request.provider, request.bounds, config, request.selection),
      fetchElevationData(request.provider, request.bounds, config),
    ]);
    await updateJob(pool, id, "running", 45, "normalizing");
    const normalized = normalizeOverpass(raw);
    const rawJson = JSON.stringify(raw);
    const osmContentHash = createHash("sha256").update(rawJson).digest("hex");
    const contentHash = createHash("sha256")
      .update(
        `${osmContentHash}:${elevation.snapshot.contentHash}${request.selection ? `:${JSON.stringify(request.selection)}` : ""}`,
      )
      .digest("hex");
    const compressed = await gzipAsync(Buffer.from(rawJson));
    await mkdir(config.OSM_CACHE_DIRECTORY, { recursive: true });
    const cachePath = join(
      config.OSM_CACHE_DIRECTORY,
      `${osmContentHash}.json.gz`,
    );
    // Publish complete gzip files atomically so a killed worker cannot leave a
    // partial snapshot that its replacement mistakes for a reusable cache file.
    const temporaryPath = `${cachePath}.${id}.tmp`;
    await writeFile(temporaryPath, compressed);
    await rename(temporaryPath, cachePath);
    await updateJob(pool, id, "running", 65, "persisting");

    const client = await pool.connect();
    let snapshotId: string = randomUUID();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO source_snapshots
           (id, provider, query_version, bounds, query, retrieved_at, content_hash, cache_path, attribution, license_url,
            elevation_snapshot, elevation_content_hash)
         VALUES
           ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5::jsonb, now(), $6, $7,
            '© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright', $8::jsonb, $9)
         ON CONFLICT (provider, content_hash) DO NOTHING
         RETURNING id`,
        [
          snapshotId,
          request.provider,
          request.queryVersion,
          JSON.stringify(boundsPolygon(request.bounds)),
          JSON.stringify({
            query,
            bounds: request.bounds,
            ...(request.selection ? { selection: request.selection } : {}),
            elevationProvider: elevation.snapshot.provider,
            elevationDataset: elevation.snapshot.dataset,
          }),
          contentHash,
          cachePath,
          JSON.stringify(elevation.snapshot),
          elevation.snapshot.contentHash,
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM source_snapshots WHERE provider = $1 AND content_hash = $2",
          [request.provider, contentHash],
        );
        const existingId = existing.rows[0]?.id;
        if (!existingId)
          throw new Error(
            "Snapshot conflict did not resolve to an existing record",
          );
        snapshotId = existingId;
      }

      for (const feature of normalized.features) {
        const geometryJson = JSON.stringify(feature.geometry);
        const geometryHash = createHash("sha256")
          .update(geometryJson)
          .digest("hex");
        await client.query(
          `INSERT INTO osm_features
             (snapshot_id, source_id, source_type, feature_kind, geometry, tags, facts, warnings, geometry_hash)
           VALUES
             ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), $6::jsonb, $7::jsonb, $8::jsonb, $9)
           ON CONFLICT (snapshot_id, source_id) DO NOTHING`,
          [
            snapshotId,
            feature.sourceId,
            feature.sourceType,
            feature.kind,
            geometryJson,
            JSON.stringify(feature.tags),
            JSON.stringify(feature.facts),
            JSON.stringify(feature.warnings),
            geometryHash,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await updateJob(pool, id, "complete", 100, "complete", {
      snapshotId,
      featureCount: normalized.features.length,
      diagnostics: [...normalized.diagnostics, ...elevation.diagnostics],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown import failure";
    await pool.query(
      `UPDATE jobs SET status = 'failed', progress = 100, stage = 'failed',
       error_code = 'IMPORT_FAILED', error_message = $2, completed_at = now()
       WHERE id = $1`,
      [id, message],
    );
  }
}

export async function getImportJob(
  pool: DatabasePool,
  id: string,
): Promise<ImportJob | undefined> {
  const result = await pool.query<{
    id: string;
    status: ImportJob["status"];
    progress: number;
    stage: string;
    result: {
      snapshotId?: string;
      featureCount?: number;
      diagnostics?: Diagnostic[];
    } | null;
    error_code: string | null;
    error_message: string | null;
  }>(
    `SELECT id, status, progress, stage, result, error_code, error_message
     FROM jobs WHERE id = $1 AND job_type = 'osm-import'`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    diagnostics: row.result?.diagnostics ?? [],
    ...(row.result?.snapshotId ? { snapshotId: row.result.snapshotId } : {}),
    ...(row.result?.featureCount === undefined
      ? {}
      : { featureCount: row.result.featureCount }),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
  };
}
