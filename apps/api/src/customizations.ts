import type { BuildingCustomization } from "@osm3d/contracts";
import type { DatabasePool } from "./database.js";

export async function loadCustomizations(
  pool: DatabasePool,
  snapshotId: string,
): Promise<BuildingCustomization[]> {
  const result = await pool.query<{
    source_id: string;
    revision: number;
    payload: BuildingCustomization | null;
  }>(
    `SELECT c.source_id, c.revision, c.payload FROM building_customizations c
     JOIN source_snapshots s ON s.provider = c.provider
     JOIN osm_features f ON f.snapshot_id = s.id AND f.source_id = c.source_id
     WHERE s.id = $1 AND f.feature_kind = 'building'`,
    [snapshotId],
  );
  return result.rows.map((row) => ({
    ...(row.payload ?? {
      sourceId: row.source_id,
      footprint: "",
      openings: [],
      appearance: {},
      boundaries: [],
    }),
    revision: row.revision,
  }));
}

export async function saveCustomization(
  pool: DatabasePool,
  snapshotId: string,
  value: BuildingCustomization,
) {
  // The predicate is evaluated atomically, including simultaneous first saves.
  const result = await pool.query<{ revision: number }>(
    `INSERT INTO building_customizations (provider, source_id, revision, payload)
     SELECT s.provider, $2, 1, $3::jsonb FROM source_snapshots s
     JOIN osm_features f ON f.snapshot_id = s.id AND f.source_id = $2
     WHERE s.id = $1 AND f.feature_kind = 'building'
       AND ($4 = 0 OR EXISTS (SELECT 1 FROM building_customizations c WHERE c.provider = s.provider AND c.source_id = $2))
     ON CONFLICT (provider, source_id) DO UPDATE
     SET revision = building_customizations.revision + 1, payload = EXCLUDED.payload, updated_at = now()
     WHERE building_customizations.revision = $4
     RETURNING revision`,
    [snapshotId, value.sourceId, JSON.stringify(value), value.revision],
  );
  const row = result.rows[0];
  return row ? { ...value, revision: row.revision } : undefined;
}
