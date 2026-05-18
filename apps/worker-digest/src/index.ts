import { loadConfig } from "@job-search/config";
import { createBullMqQueueWorker, createRuntimeDatabase, createRuntimeQueue, InMemoryTaskRunStore, PostgresRuntimeDatabase } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { runDigestWorker, runQueuedDigestWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-digest");
const db = await createRuntimeDatabase({
  stateBackend: config.persistence.stateBackend,
  postgresUrl: config.postgres.url
});
const taskRunStore = db instanceof PostgresRuntimeDatabase ? db.taskRunStore : new InMemoryTaskRunStore();
const queue = createRuntimeQueue({ backend: config.queue.backend, redisUrl: config.queue.redisUrl, taskRunStore });

if (process.env.WORKER_CONSUME_BULLMQ === "true") {
  if (config.queue.backend !== "bullmq") {
    throw new Error("WORKER_CONSUME_BULLMQ requires QUEUE_BACKEND=bullmq");
  }
  const worker = createBullMqQueueWorker({
    queueName: "digest_queue",
    redisUrl: config.queue.redisUrl,
    taskRunStore,
    handler: async () => runDigestWorker(db)
  });
  await worker.waitUntilReady();
  logger.info("bullmq_worker_started", { queueName: "digest_queue", redisUrl: config.queue.redisUrl });
  const shutdown = async (): Promise<void> => {
    await worker.close();
    await queue.close?.();
    if (db instanceof PostgresRuntimeDatabase) {
      await db.close();
    }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} else {
  try {
    const result = await runQueuedDigestWorker({ db, queue, taskRunStore });
    logger.info("digest_generated", { mode: config.app.mode, digest: result.digest, queueRuntime: result.queueRuntime });
  } finally {
    await queue.close?.();
    if (db instanceof PostgresRuntimeDatabase) {
      await db.close();
    }
  }
}
