import { loadConfig } from "@job-search/config";
import { localDb } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { runInboxWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-inbox");
const registry = createFixtureProviderRegistry();

logger.info("inbox_sync_completed", await runInboxWorker({ config, db: localDb, registry }));
