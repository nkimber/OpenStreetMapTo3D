import { randomUUID } from "node:crypto";
import type {
  NormalizedFeature,
  SnapshotPreview,
  WorldCreateRequest,
  WorldDefinition,
  WorldOverride,
  WorldSummary,
} from "@osm3d/contracts";
import type { DatabasePool } from "./database.js";

const GENERATOR_VERSION = "0.1.0";

interface WorldRow {
  id: string;
  name: string;
  snapshot_id: string;
  west: number;
  south: number;
  east: number;
  north: number;
  longitude: number;
  latitude: number;
  settings: WorldSummary["settings"];
  generator_version: string;
  created_at: Date;
  updated_at: Date;
}

interface FeatureRow {
  source_id: string;
  source_type: NormalizedFeature["sourceType"];
  feature_kind: NormalizedFeature["kind"];
  geometry: NormalizedFeature["geometry"];
  tags: NormalizedFeature["tags"];
  facts: NormalizedFeature["facts"];
  warnings: NormalizedFeature["warnings"];
}

function featureRowToDto(row: FeatureRow): NormalizedFeature {
  return {
    sourceId: row.source_id,
    sourceType: row.source_type,
    kind: row.feature_kind,
    geometry: row.geometry,
    tags: row.tags,
    facts: row.facts,
    warnings: row.warnings,
  };
}

async function getSnapshotFeatures(
  pool: DatabasePool,
  snapshotId: string,
): Promise<NormalizedFeature[]> {
  const result = await pool.query<FeatureRow>(
    `SELECT source_id, source_type, feature_kind,
      ST_AsGeoJSON(geometry)::json AS geometry, tags, facts, warnings
     FROM osm_features WHERE snapshot_id = $1 ORDER BY source_id`,
    [snapshotId],
  );
  return result.rows.map(featureRowToDto);
}

export async function getSnapshotPreview(
  pool: DatabasePool,
  snapshotId: string,
): Promise<SnapshotPreview | undefined> {
  const [snapshotResult, features] = await Promise.all([
    pool.query<{ attribution: string; license_url: string }>(
      "SELECT attribution, license_url FROM source_snapshots WHERE id = $1",
      [snapshotId],
    ),
    getSnapshotFeatures(pool, snapshotId),
  ]);
  const snapshot = snapshotResult.rows[0];
  if (!snapshot) return undefined;
  const count = (kind: NormalizedFeature["kind"]) =>
    features.filter((feature) => feature.kind === kind).length;
  return {
    snapshotId,
    attribution: [
      {
        text: snapshot.attribution,
        url: snapshot.license_url,
        license: "ODbL 1.0",
      },
    ],
    features,
    diagnostics: features.flatMap((feature) => feature.warnings),
    stats: {
      roads: count("road"),
      buildings: count("building"),
      land: count("land"),
      water: count("water"),
      barriers: count("barrier"),
      estimatedBuildingHeights: features.filter(
        (feature) =>
          feature.kind === "building" &&
          typeof feature.facts.height !== "number" &&
          typeof feature.facts.levels !== "number",
      ).length,
    },
  };
}

function rowToSummary(row: WorldRow): WorldSummary {
  return {
    id: row.id,
    name: row.name,
    snapshotId: row.snapshot_id,
    bounds: {
      west: row.west,
      south: row.south,
      east: row.east,
      north: row.north,
    },
    anchor: {
      longitude: row.longitude,
      latitude: row.latitude,
      height: 0,
    },
    settings: row.settings,
    generatorVersion: row.generator_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const worldSelect = `
  SELECT id, name, source_snapshot_id AS snapshot_id,
    ST_XMin(Box2D(boundary)) AS west,
    ST_YMin(Box2D(boundary)) AS south,
    ST_XMax(Box2D(boundary)) AS east,
    ST_YMax(Box2D(boundary)) AS north,
    ST_X(anchor) AS longitude,
    ST_Y(anchor) AS latitude,
    settings, generator_version, created_at, updated_at
  FROM world_projects`;

function boundaryGeoJson(request: WorldCreateRequest): object {
  const bounds = request.bounds;
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

export async function createWorld(
  pool: DatabasePool,
  request: WorldCreateRequest,
): Promise<WorldSummary> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO world_projects
       (id, name, boundary, anchor, source_snapshot_id, settings, generator_version)
     VALUES
       ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7::jsonb, $8)`,
    [
      id,
      request.name,
      JSON.stringify(boundaryGeoJson(request)),
      request.anchor.longitude,
      request.anchor.latitude,
      request.snapshotId,
      JSON.stringify(request.settings),
      GENERATOR_VERSION,
    ],
  );
  const created = await getWorld(pool, id);
  if (!created) throw new Error("Created world could not be loaded");
  return created;
}

export async function listWorlds(pool: DatabasePool): Promise<WorldSummary[]> {
  const result = await pool.query<WorldRow>(
    `${worldSelect} ORDER BY updated_at DESC`,
  );
  return result.rows.map(rowToSummary);
}

export async function getWorld(
  pool: DatabasePool,
  id: string,
): Promise<WorldSummary | undefined> {
  const result = await pool.query<WorldRow>(`${worldSelect} WHERE id = $1`, [
    id,
  ]);
  return result.rows[0] ? rowToSummary(result.rows[0]) : undefined;
}

export async function getWorldDefinition(
  pool: DatabasePool,
  id: string,
): Promise<WorldDefinition | undefined> {
  const world = await getWorld(pool, id);
  if (!world) return undefined;
  const [featureResult, overrideResult, snapshotResult] = await Promise.all([
    getSnapshotFeatures(pool, world.snapshotId),
    pool.query<{
      id: string;
      target_id: string;
      operation: WorldOverride["operation"];
      payload_version: number;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, target_id, operation, payload_version, payload
       FROM world_overrides WHERE world_project_id = $1 ORDER BY created_at`,
      [id],
    ),
    pool.query<{ attribution: string; license_url: string }>(
      `SELECT attribution, license_url FROM source_snapshots WHERE id = $1`,
      [world.snapshotId],
    ),
  ]);
  const features = featureResult;
  const overrides: WorldOverride[] = overrideResult.rows.map((row) => ({
    id: row.id,
    targetId: row.target_id,
    operation: row.operation,
    payloadVersion: row.payload_version,
    payload: row.payload,
  }));
  const snapshot = snapshotResult.rows[0];
  return {
    schemaVersion: 1,
    world,
    attribution: [
      {
        text: snapshot?.attribution ?? "© OpenStreetMap contributors",
        url: snapshot?.license_url ?? "https://www.openstreetmap.org/copyright",
        license: "ODbL 1.0",
      },
    ],
    features,
    overrides,
    diagnostics: features.flatMap((feature) => feature.warnings),
  };
}

export async function replaceOverrides(
  pool: DatabasePool,
  worldId: string,
  overrides: WorldOverride[],
): Promise<WorldOverride[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM world_overrides WHERE world_project_id = $1",
      [worldId],
    );
    const saved: WorldOverride[] = [];
    for (const override of overrides) {
      const id = override.id ?? randomUUID();
      await client.query(
        `INSERT INTO world_overrides
           (id, world_project_id, target_id, operation, payload_version, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          id,
          worldId,
          override.targetId,
          override.operation,
          override.payloadVersion,
          JSON.stringify(override.payload),
        ],
      );
      saved.push({ ...override, id });
    }
    await client.query(
      "UPDATE world_projects SET updated_at = now() WHERE id = $1",
      [worldId],
    );
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
