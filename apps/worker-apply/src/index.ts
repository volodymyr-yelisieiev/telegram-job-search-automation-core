import { loadConfig } from "@job-search/config";
import {
  createBullMqQueueWorker,
  createRuntimeDatabase,
  createRuntimeQueue,
  InMemoryTaskRunStore,
  PostgresRuntimeDatabase,
  QueueWorkerError
} from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { createRuntimeProviderRegistryWithOverrides } from "@job-search/providers";
import { runApplyWorker, runApprovedSubmitWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-apply");
const db = await createRuntimeDatabase({
  stateBackend: config.persistence.stateBackend,
  postgresUrl: config.postgres.url
});
const registry = createRuntimeProviderRegistryWithOverrides(config.providers.map((provider) => JSON.parse(JSON.stringify(provider))));
const taskRunStore = db instanceof PostgresRuntimeDatabase ? db.taskRunStore : new InMemoryTaskRunStore();
const queue = createRuntimeQueue({ backend: config.queue.backend, redisUrl: config.queue.redisUrl, taskRunStore });

if (process.env.WORKER_CONSUME_BULLMQ === "true") {
  if (config.queue.backend !== "bullmq") {
    throw new Error("WORKER_CONSUME_BULLMQ requires QUEUE_BACKEND=bullmq");
  }
  const worker = createBullMqQueueWorker({
    queueName: "auto_apply_queue",
    redisUrl: config.queue.redisUrl,
    taskRunStore,
    handler: async (payload) => {
      const submitPayload = payload as {
        applicationId?: string;
        approvalRequestId?: string;
        approvedDraftHash?: string | null;
        releaseEvidenceSource?: string;
        releaseEvidenceTtlHours?: number;
      };
      if (!submitPayload.applicationId) {
        throw new QueueWorkerError("application_missing", "BullMQ auto-apply job payload must include applicationId");
      }
      return runApprovedSubmitWorker({
        config,
        db,
        registry,
        applicationId: submitPayload.applicationId,
        ...(submitPayload.approvalRequestId ? { approvalRequestId: submitPayload.approvalRequestId } : {}),
        ...(submitPayload.approvedDraftHash !== undefined ? { approvedDraftHash: submitPayload.approvedDraftHash } : {}),
        ...(submitPayload.releaseEvidenceSource ? { releaseEvidenceSource: submitPayload.releaseEvidenceSource } : {}),
        ...(submitPayload.releaseEvidenceTtlHours ? { releaseEvidenceTtlHours: submitPayload.releaseEvidenceTtlHours } : {})
      });
    }
  });
  await worker.waitUntilReady();
  logger.info("bullmq_worker_started", { queueName: "auto_apply_queue", redisUrl: config.queue.redisUrl });
  const shutdown = async (): Promise<void> => {
    await worker.close();
    await queue.close?.();
    if (db instanceof PostgresRuntimeDatabase) {
      await db.close();
    }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} else if (process.env.APPROVED_SUBMIT_APPLICATION_ID) {
  const releaseEvidenceTtlHours = parsePositiveNumber(process.env.APPROVED_SUBMIT_RELEASE_EVIDENCE_TTL_HOURS);
  const approvalInput = {
    ...(process.env.APPROVED_SUBMIT_APPROVAL_REQUEST_ID ? { approvalRequestId: process.env.APPROVED_SUBMIT_APPROVAL_REQUEST_ID } : {}),
    ...(process.env.APPROVED_SUBMIT_DRAFT_HASH ? { approvedDraftHash: process.env.APPROVED_SUBMIT_DRAFT_HASH } : {}),
    ...(process.env.APPROVED_SUBMIT_RELEASE_EVIDENCE_SOURCE
      ? { releaseEvidenceSource: process.env.APPROVED_SUBMIT_RELEASE_EVIDENCE_SOURCE }
      : {}),
    ...(releaseEvidenceTtlHours !== null ? { releaseEvidenceTtlHours } : {})
  };
  const result = await runApprovedSubmitWorker({
    config,
    db,
    registry,
    applicationId: process.env.APPROVED_SUBMIT_APPLICATION_ID,
    ...approvalInput,
    queue,
    taskRunStore
  });

  logger.info("approved_submit_worker_completed", {
    mode: config.app.mode,
    applicationId: result.applicationId,
    status: result.status,
    queueRuntime: result.queueRuntime ?? null,
    providerResultStatus: result.providerResultStatus
  });

  if (result.status === "failed") {
    process.exitCode = 1;
  }
  await queue.close?.();
  if (db instanceof PostgresRuntimeDatabase) {
    await db.close();
  }
} else {
  const result = runApplyWorker({ db });

  logger.info("apply_dry_run_completed", {
    mode: config.app.mode,
    status: result.status,
    reachedSubmitBoundary: result.reachedSubmitBoundary,
    errorCode: result.errorCode
  });

  if (result.status !== "succeeded") {
    process.exitCode = 1;
  }
  await queue.close?.();
  if (db instanceof PostgresRuntimeDatabase) {
    await db.close();
  }
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
