import { loadConfig } from "./config.js";
import { createDatabasePool, migrateDatabase } from "./database.js";

const config = loadConfig();
const pool = createDatabasePool(config.DATABASE_URL);

try {
  await migrateDatabase(pool);
  process.stdout.write("Database migration complete.\n");
} finally {
  await pool.end();
}
