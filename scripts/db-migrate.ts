import { loadConfig } from "@job-search/config";
import { createPool, runMigrations } from "@job-search/db";
import { createLogger } from "@job-search/observability";

const config = loadConfig();
const logger = createLogger("db-migrate");
const pool = createPool(config.postgres.url);

try {
  await runMigrations(pool);
  logger.info("db_migrate_completed", { databaseUrlConfigured: Boolean(config.postgres.url) });
} finally {
  await pool.end();
}
