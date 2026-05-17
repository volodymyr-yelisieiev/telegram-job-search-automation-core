import { loadConfig } from "@job-search/config";
import { localDb } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { runDigestWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-digest");
const digest = runDigestWorker(localDb);

logger.info("digest_generated", { mode: config.app.mode, digest });
