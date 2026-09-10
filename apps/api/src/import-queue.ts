import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import { ImportRequestSchema } from "@osm3d/contracts";
import type { AppConfig } from "./config.js";
import type { DatabasePool } from "./database.js";
import { executeImportJob } from "./imports.js";

export async function processQueuedImports(
  leader: Pick<PoolClient, "query">,
  pool: DatabasePool,
  config: AppConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const next = await leader.query<{ id: string; input: unknown }>(
      `UPDATE jobs SET status = 'running', stage = 'starting',
         started_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE job_type = 'osm-import' AND status = 'queued'
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING id, input`,
    );
    const job = next.rows[0];
    if (job) {
      const parsed = ImportRequestSchema.safeParse(job.input);
      if (!parsed.success) {
        await leader.query(
          `UPDATE jobs SET status = 'failed', stage = 'failed', completed_at = now(),
             error_code = 'INVALID_IMPORT', error_message = 'Invalid queued import request.'
           WHERE id = $1`,
          [job.id],
        );
        continue;
      }
      await executeImportJob(pool, config, job.id, parsed.data);
    } else {
      await delay(1_000, undefined, { signal }).catch((error) => {
        if (!signal.aborted) throw error;
      });
    }
  }
}
