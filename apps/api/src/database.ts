import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

export type DatabasePool = pg.Pool;

export function createDatabasePool(connectionString: string): DatabasePool {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export async function migrateDatabase(pool: DatabasePool): Promise<void> {
  const migrationCandidates = [
    resolve(process.cwd(), "database/init/001_init.sql"),
    resolve(process.cwd(), "../../database/init/001_init.sql"),
  ];
  let migration: string | undefined;
  for (const migrationPath of migrationCandidates) {
    try {
      migration = await readFile(migrationPath, "utf8");
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  if (!migration) {
    throw new Error(`Database migration was not found from ${process.cwd()}`);
  }
  await pool.query(migration);
}
