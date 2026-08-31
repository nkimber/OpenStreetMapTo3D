import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type {
  Diagnostic,
  ImportJob,
  ImportRequest,
  Wgs84Bounds,
} from "@osm3d/contracts";
import { normalizeOverpass } from "@osm3d/osm";
import type { AppConfig } from "./config.js";
import type { DatabasePool } from "./database.js";
import { fetchOsmData } from "./providers.js";

const gzipAsync = promisify(gzip);

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

export async function createImportJob(
  pool: DatabasePool,
  request: ImportRequest,
): Promise<ImportJob> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, job_type, status, input, progress, stage)
     VALUES ($1, 'osm-import', 'queued', $2::jsonb, 0, 'queued')`,
    [id, JSON.stringify(request)],
  );
  return {
    id,
    status: "queued",
    progress: 0,
    stage: "queued",
    diagnostics: [],
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
    await updateJob(pool, id, "running", 10, "downloading");
    const { raw, query } = await fetchOsmData(
      request.provider,
      request.bounds,
      config,
    );
    await updateJob(pool, id, "running", 40, "normalizing");
    const normalized = normalizeOverpass(raw);
    const rawJson = JSON.stringify(raw);
    const contentHash = createHash("sha256").update(rawJson).digest("hex");
    const compressed = await gzipAsync(Buffer.from(rawJson));
    await mkdir(config.OSM_CACHE_DIRECTORY, { recursive: true });
    const cachePath = join(
      config.OSM_CACHE_DIRECTORY,
      `${contentHash}.json.gz`,
    );
    await writeFile(cachePath, compressed, { flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await updateJob(pool, id, "running", 65, "persisting");

    const client = await pool.connect();
    let snapshotId: string = randomUUID();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO source_snapshots
           (id, provider, query_version, bounds, query, retrieved_at, content_hash, cache_path, attribution, license_url)
         VALUES
           ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5::jsonb, now(), $6, $7,
            '© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright')
         ON CONFLICT (provider, content_hash) DO NOTHING
         RETURNING id`,
        [
          snapshotId,
          request.provider,
          request.queryVersion,
          JSON.stringify(boundsPolygon(request.bounds)),
          JSON.stringify({ query, bounds: request.bounds }),
          contentHash,
          cachePath,
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
      diagnostics: normalized.diagnostics,
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
