import { loadConfig } from "@job-search/config";
import { createRuntimeDatabase, PostgresRuntimeDatabase } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { buildServer } from "./server";

const config = loadConfig();
const logger = createLogger("api");
const db = await createRuntimeDatabase({
  stateBackend: config.persistence.stateBackend,
  postgresUrl: config.postgres.url
});
const server = await buildServer({ config, db });

const shutdown = async (): Promise<void> => {
  await server.close();
  if (db instanceof PostgresRuntimeDatabase) {
    await db.close();
  }
};

process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});

try {
  await server.listen({ host: config.api.host, port: config.api.port });
  logger.info("api_started", {
    host: config.api.host,
    port: config.api.port,
    mode: config.app.mode,
    stateBackend: config.persistence.stateBackend
  });
} catch (error) {
  logger.error("api_failed_to_start", { error: String(error) });
  await shutdown();
  process.exitCode = 1;
}
