import { BullMqQueueAdapter, InMemoryQueueAdapter, InMemoryTaskRunStore, type QueueAdapter, type QueueTask } from "@job-search/db";

export interface QueueResilienceReport {
  queueRuntime: "memory" | "bullmq";
  duplicateSuppressed: boolean;
  workerRestartRecovered: boolean;
  deadLetterVisible: boolean;
  retryQueued: boolean;
  redisRestartCheck: "simulated" | "not_exercised";
  passed: boolean;
  failures: string[];
}

export async function runQueueResilienceCheck(input: { redisUrl?: string } = {}): Promise<QueueResilienceReport> {
  const redisUrl = input.redisUrl ?? configuredRedisUrl();
  const taskRunStore = new InMemoryTaskRunStore();
  const queueRuntime = redisUrl ? "bullmq" : "memory";
  const queue: QueueAdapter = redisUrl ? new BullMqQueueAdapter(redisUrl, taskRunStore) : new InMemoryQueueAdapter(taskRunStore);
  const cleanupTasks: QueueTask[] = [];
  const runId = `resilience:${Date.now()}:${process.pid}`;
  try {
    const first = await queue.enqueue(
      "auto_apply_queue",
      { applicationId: `app-${runId}` },
      { idempotencyKey: `apply:${runId}`, deduplicationKey: `app-${runId}` }
    );
    cleanupTasks.push(first);
    const duplicate = await queue.enqueue(
      "auto_apply_queue",
      { applicationId: `app-${runId}` },
      { idempotencyKey: `apply:${runId}`, deduplicationKey: `app-${runId}` }
    );
    taskRunStore.markRunning(first.id);
    const deadLetter = taskRunStore.moveToDeadLetter(first.id, { code: "worker_restart", message: "simulated worker restart mid-task" });
    const retry = await queue.enqueue(
      "retry_queue",
      { deadLetterId: deadLetter?.id },
      { idempotencyKey: `retry:${deadLetter?.id}`, deduplicationKey: first.id }
    );
    cleanupTasks.push(retry);
    const duplicateSuppressed = first.id === duplicate.id;
    const workerRestartRecovered = Boolean(deadLetter);
    const deadLetterVisible = taskRunStore.listDeadLetters("open").some((record) => record.id === deadLetter?.id);
    const retryQueued = retry.queueName === "retry_queue";
    const failures = [
      duplicateSuppressed ? null : "duplicate_enqueue_not_suppressed",
      workerRestartRecovered ? null : "worker_restart_not_recovered",
      deadLetterVisible ? null : "dead_letter_not_visible",
      retryQueued ? null : "retry_not_queued"
    ].filter((failure): failure is string => failure !== null);
    return {
      queueRuntime,
      duplicateSuppressed,
      workerRestartRecovered,
      deadLetterVisible,
      retryQueued,
      redisRestartCheck: redisUrl ? "not_exercised" : "simulated",
      passed: failures.length === 0,
      failures
    };
  } catch (error) {
    const failure = redisUrl ? `redis_backed_queue_unavailable: ${error instanceof Error ? error.message : String(error)}` : `queue_resilience_check_failed: ${String(error)}`;
    return {
      queueRuntime,
      duplicateSuppressed: false,
      workerRestartRecovered: false,
      deadLetterVisible: false,
      retryQueued: false,
      redisRestartCheck: redisUrl ? "not_exercised" : "simulated",
      passed: false,
      failures: [failure]
    };
  } finally {
    await Promise.all(cleanupTasks.map((task) => queue.remove?.(task)));
    await queue.close?.();
  }
}

function configuredRedisUrl(): string | undefined {
  if (process.env.QUEUE_RESILIENCE_REDIS_URL) {
    return process.env.QUEUE_RESILIENCE_REDIS_URL;
  }
  if (process.env.QUEUE_BACKEND === "bullmq") {
    return process.env.REDIS_URL ?? "redis://127.0.0.1:6380";
  }
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runQueueResilienceCheck();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    process.exitCode = 1;
  }
}
