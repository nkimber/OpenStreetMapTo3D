import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { processQueuedImports } from "./import-queue.js";

const config = loadConfig();
const pool = createDatabasePool(config.DATABASE_URL);
const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());
process.on("SIGINT", () => stop.abort());

// The API migrates first; Compose starts this worker after API readiness.
// A session lock prevents two worker containers from importing concurrently.
const leader = await pool.connect();
leader.on("error", () => {
  // Losing the lock must stop in-flight work before a replacement takes over.
  process.exit(1);
});

try {
  const lock = await leader.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(173824, 1) AS acquired",
  );
  if (!lock.rows[0]?.acquired) {
    throw new Error("Another StreetRove import worker is already running");
  }

  // Only the lock owner may recover jobs interrupted by a previous process.
  await leader.query(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
       stage = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued-after-restart' END,
       progress = 0,
       error_code = CASE WHEN attempts >= 3 THEN 'IMPORT_INTERRUPTED' ELSE NULL END,
       error_message = CASE WHEN attempts >= 3
         THEN 'Import interrupted repeatedly; please retry with a smaller area.' ELSE NULL END,
       completed_at = CASE WHEN attempts >= 3 THEN now() ELSE NULL END
     WHERE job_type = 'osm-import' AND status = 'running'`,
  );

  await processQueuedImports(leader, pool, config, stop.signal);
} finally {
  leader.release(true);
  await pool.end();
}
