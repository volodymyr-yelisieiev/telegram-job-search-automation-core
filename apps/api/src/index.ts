import { loadConfig } from "@job-search/config";
import { createLogger } from "@job-search/observability";
import { buildServer } from "./server";

const config = loadConfig();
const logger = createLogger("api");
const server = await buildServer({ config });

try {
  await server.listen({ host: config.api.host, port: config.api.port });
  logger.info("api_started", { host: config.api.host, port: config.api.port, mode: config.app.mode });
} catch (error) {
  logger.error("api_failed_to_start", { error: String(error) });
  process.exitCode = 1;
}
