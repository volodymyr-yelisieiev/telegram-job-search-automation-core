import { loadConfig } from "@job-search/config";
import { createBullMqQueueWorker, createRuntimeDatabase, createRuntimeQueue, InMemoryTaskRunStore, PostgresRuntimeDatabase } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { createRuntimeProviderRegistryWithOverrides } from "@job-search/providers";
import { runCanaryWorker } from "./runner";

const config = loadConfig();
const logger = createLogger("worker-canary");
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
    queueName: "canary_queue",
    redisUrl: config.queue.redisUrl,
    taskRunStore,
    handler: async () => runCanaryWorker({ registry, db })
  });
  await worker.waitUntilReady();
  logger.info("bullmq_worker_started", { queueName: "canary_queue", redisUrl: config.queue.redisUrl });
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
    const results = await runCanaryWorker({ registry, db, queue, taskRunStore });
    logger.info("provider_canary_queue_completed", { queueRuntime: results.queueRuntime ?? null });
    for (const result of results) {
      logger.info("provider_canary_completed", result);
      if (result.status !== "passed") {
        process.exitCode = 1;
      }
    }
  } finally {
    await queue.close?.();
    if (db instanceof PostgresRuntimeDatabase) {
      await db.close();
    }
  }
}
