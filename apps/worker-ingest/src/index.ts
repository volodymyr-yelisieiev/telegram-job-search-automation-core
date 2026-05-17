import { loadConfig } from "@job-search/config";
import { localDb } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { runIngestWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-ingest");
const registry = createFixtureProviderRegistry();

const result = await runIngestWorker({ config, db: localDb, registry });
logger.info("ingest_completed", result);
