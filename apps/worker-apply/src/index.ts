import { loadConfig } from "@job-search/config";
import { createLogger } from "@job-search/observability";
import { runApplyWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-apply");
const result = runApplyWorker();

logger.info("apply_dry_run_completed", {
  mode: config.app.mode,
  status: result.status,
  reachedSubmitBoundary: result.reachedSubmitBoundary,
  errorCode: result.errorCode
});

if (result.status !== "succeeded") {
  process.exitCode = 1;
}
