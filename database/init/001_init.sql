CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  job_type text NOT NULL,
  status text NOT NULL,
  input jsonb NOT NULL,
  progress integer NOT NULL DEFAULT 0,
  stage text NOT NULL,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS jobs_queued_import_idx
  ON jobs (created_at, id) WHERE job_type = 'osm-import' AND status = 'queued';

CREATE TABLE IF NOT EXISTS source_snapshots (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  query_version integer NOT NULL,
  bounds geometry(Polygon, 4326) NOT NULL,
  query jsonb NOT NULL,
  retrieved_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  cache_path text NOT NULL,
  attribution text NOT NULL,
  license_url text NOT NULL,
  raw_schema_version integer NOT NULL DEFAULT 1,
  normalized_schema_version integer NOT NULL DEFAULT 1,
  elevation_snapshot jsonb,
  elevation_content_hash text,
  UNIQUE (provider, content_hash)
);

-- migrateDatabase executes this idempotent file on every API start, so these
-- additions also upgrade development volumes created before elevation support.
ALTER TABLE source_snapshots
  ADD COLUMN IF NOT EXISTS elevation_snapshot jsonb;

ALTER TABLE source_snapshots
  ADD COLUMN IF NOT EXISTS elevation_content_hash text;

CREATE TABLE IF NOT EXISTS osm_features (
  snapshot_id uuid NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  source_type text NOT NULL,
  feature_kind text NOT NULL,
  geometry geometry(Geometry, 4326) NOT NULL,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  geometry_hash text NOT NULL,
  PRIMARY KEY (snapshot_id, source_id)
);

CREATE INDEX IF NOT EXISTS osm_features_geometry_idx
  ON osm_features USING gist (geometry);

CREATE TABLE IF NOT EXISTS world_projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  boundary geometry(Polygon, 4326) NOT NULL,
  anchor geometry(Point, 4326) NOT NULL,
  source_snapshot_id uuid NOT NULL REFERENCES source_snapshots(id),
  settings jsonb NOT NULL,
  generator_version text NOT NULL,
  spawn jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS world_overrides (
  id uuid PRIMARY KEY,
  world_project_id uuid NOT NULL REFERENCES world_projects(id) ON DELETE CASCADE,
  target_id text NOT NULL,
  operation text NOT NULL,
  payload_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS world_overrides_world_idx
  ON world_overrides (world_project_id);

-- Shared across worlds and snapshots from the same source. Reset is a versioned
-- tombstone so stale editors cannot restore deleted customizations silently.
CREATE TABLE IF NOT EXISTS building_customizations (
  provider text NOT NULL,
  source_id text NOT NULL,
  revision integer NOT NULL,
  payload jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, source_id)
);

CREATE TABLE IF NOT EXISTS world_builds (
  id uuid PRIMARY KEY,
  world_project_id uuid NOT NULL REFERENCES world_projects(id) ON DELETE CASCADE,
  source_snapshot_id uuid NOT NULL REFERENCES source_snapshots(id),
  generator_version text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL,
  statistics jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  artifact_cache_key text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
