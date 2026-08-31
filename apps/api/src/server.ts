import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabasePool, migrateDatabase } from "./database.js";

const config = loadConfig();
const pool = createDatabasePool(config.DATABASE_URL);

await migrateDatabase(pool);
const app = await buildApp({ config, pool });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: "0.0.0.0", port: config.API_PORT });
