import { loadConfig } from "@job-search/config";
import { createBullMqQueueWorker, createRuntimeDatabase, createRuntimeQueue, InMemoryTaskRunStore, PostgresRuntimeDatabase } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { createRuntimeProviderRegistryWithOverrides } from "@job-search/providers";
import { runInboxWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-inbox");
const registry = createRuntimeProviderRegistryWithOverrides(config.providers.map((provider) => JSON.parse(JSON.stringify(provider))));
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
    queueName: "inbox_sync_queue",
    redisUrl: config.queue.redisUrl,
    taskRunStore,
    handler: async () => runInboxWorker({ config, db, registry })
  });
  await worker.waitUntilReady();
  logger.info("bullmq_worker_started", { queueName: "inbox_sync_queue", redisUrl: config.queue.redisUrl });
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
    logger.info("inbox_sync_completed", await runInboxWorker({ config, db, registry, queue, taskRunStore }));
  } finally {
    await queue.close?.();
    if (db instanceof PostgresRuntimeDatabase) {
      await db.close();
    }
  }
}
