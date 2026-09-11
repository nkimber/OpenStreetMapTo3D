/** Run inside the API container: pnpm exec tsx tests/integration/building-customizations.ts */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BuildingCustomizationSchema,
  footprintSignature,
  type NormalizedFeature,
} from "../../packages/contracts/src/index.js";
import {
  createDatabasePool,
  type DatabasePool,
} from "../../apps/api/src/database.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { buildApp } from "../../apps/api/src/app.js";

const config = loadConfig();
const pool = createDatabasePool(config.DATABASE_URL);
const client = await pool.connect();
const app = await buildApp({
  config: { ...config, NODE_ENV: "test", LOG_LEVEL: "silent" },
  pool: client as unknown as DatabasePool,
});
try {
  await client.query("BEGIN");
  const seed = await client.query<{ id: string; source_snapshot_id: string }>(
    "SELECT id, source_snapshot_id FROM world_projects ORDER BY created_at LIMIT 1",
  );
  assert.ok(
    seed.rows[0],
    "Import the offline sample and create a world before running this integration test.",
  );
  const snapshots = [randomUUID(), randomUUID(), randomUUID()];
  const worlds = [randomUUID(), randomUUID(), randomUUID()];
  const provider = `editor-test-${randomUUID()}`;
  for (let i = 0; i < snapshots.length; i++) {
    await client.query(
      `INSERT INTO source_snapshots (id,provider,query_version,bounds,query,retrieved_at,content_hash,cache_path,attribution,license_url)
      SELECT $1::uuid,$2,query_version,bounds,query,now(),$1::text,cache_path,attribution,license_url FROM source_snapshots WHERE id=$3`,
      [
        snapshots[i],
        i === 2 ? `${provider}-other` : provider,
        seed.rows[0].source_snapshot_id,
      ],
    );
    await client.query(
      `INSERT INTO osm_features SELECT $1,source_id,source_type,feature_kind,geometry,tags,facts,warnings,geometry_hash FROM osm_features WHERE snapshot_id=$2`,
      [snapshots[i], seed.rows[0].source_snapshot_id],
    );
    await client.query(
      `INSERT INTO world_projects (id,name,boundary,anchor,source_snapshot_id,settings,generator_version)
      SELECT $1,'Editor integration',boundary,ST_Translate(anchor,$3,0),$2,settings,generator_version FROM world_projects WHERE id=$4`,
      [worlds[i], snapshots[i], i * 0.0001, seed.rows[0].id],
    );
  }
  const first = (
    await app.inject({
      method: "GET",
      url: `/api/worlds/${worlds[0]}/definition`,
    })
  ).json();
  const feature = (first.features as NormalizedFeature[]).find(
    (item) => item.kind === "building" && item.geometry.type === "Polygon",
  )!;
  assert.ok(feature);
  const value = BuildingCustomizationSchema.parse({
    sourceId: feature.sourceId,
    footprint: footprintSignature(feature.geometry),
    appearance: { wallColor: "#aa4433" },
    openings: [
      {
        id: "garage",
        kind: "garage",
        cars: 3,
        fraction: 0.5,
        wall:
          feature.geometry.type === "Polygon"
            ? feature.geometry.coordinates[0]!.slice(0, 2).map((p) =>
                p.slice(0, 2),
              )
            : [],
      },
    ],
  });
  const save = await app.inject({
    method: "PUT",
    url: `/api/worlds/${worlds[0]}/building-customization`,
    payload: value,
  });
  assert.equal(save.statusCode, 200, save.body);
  assert.equal(save.json().revision, 1);
  const reused = (
    await app.inject({
      method: "GET",
      url: `/api/worlds/${worlds[1]}/definition`,
    })
  ).json();
  assert.equal(
    reused.buildingCustomizations[0].appearance.wallColor,
    "#aa4433",
  );
  const isolated =
    // A provider namespace must not inherit another provider's feature IDs.
    (
      await app.inject({
        method: "GET",
        url: `/api/worlds/${worlds[2]}/definition`,
      })
    ).json();
  assert.deepEqual(isolated.buildingCustomizations, []);
  assert.equal(reused.buildingCustomizations[0].openings[0].cars, 3);
  const conflict = await app.inject({
    method: "PUT",
    url: `/api/worlds/${worlds[1]}/building-customization`,
    payload: value,
  });
  assert.equal(conflict.statusCode, 409);
  const changed = await app.inject({
    method: "PUT",
    url: `/api/worlds/${worlds[0]}/building-customization`,
    payload: { ...value, revision: 1, footprint: "different" },
  });
  assert.equal(changed.statusCode, 409);
  const reset = await app.inject({
    method: "PUT",
    url: `/api/worlds/${worlds[0]}/building-customization`,
    payload: {
      ...value,
      revision: 1,
      footprint: "",
      appearance: {},
      openings: [],
    },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().revision, 2);
  const afterReset = (
    await app.inject({
      method: "GET",
      url: `/api/worlds/${worlds[1]}/definition`,
    })
  ).json();
  assert.deepEqual(afterReset.buildingCustomizations[0].appearance, {});
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/worlds/${worlds[0]}/building-customization`,
        payload: { ...value, revision: 1 },
      })
    ).statusCode,
    409,
  );
  console.log(
    "PASS: save, separate snapshot reuse, shifted world origin, provider isolation, stale revision conflict, changed footprint rejection, versioned reset.",
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await app.close();
  await pool.end();
}
