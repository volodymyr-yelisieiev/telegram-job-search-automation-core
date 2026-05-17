import { createLogger } from "@job-search/observability";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { runCanaryWorker } from "./runner";

const logger = createLogger("worker-canary");
const registry = createFixtureProviderRegistry();

for (const result of await runCanaryWorker({ registry })) {
  logger.info("provider_canary_completed", result);
  if (result.status !== "passed") {
    process.exitCode = 1;
  }
}
