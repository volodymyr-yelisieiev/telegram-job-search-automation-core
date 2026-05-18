import { executeQueueTask, queuePolicies, type InMemoryDatabase, type QueueAdapter, type TaskRunStore } from "@job-search/db";
import { renderDigest, renderPipeline } from "@job-search/telegram-ui";

export async function runQueuedDigestWorker(input: {
  db: InMemoryDatabase;
  queue: QueueAdapter;
  taskRunStore: TaskRunStore;
  userId?: string;
}): Promise<{ digest: string; queueRuntime: { taskRunId: string; status: string; errorCode: string | null } }> {
  const userId = input.userId ?? input.db.candidateProfile.userId;
  const task = await input.queue.enqueue(
    "digest_queue",
    { userId },
    { idempotencyKey: `digest:${userId}`, deduplicationKey: userId }
  );
  const execution = await executeQueueTask({
    taskRunStore: input.taskRunStore,
    task,
    noRetryErrorCodes: queuePolicies.digest_queue.noRetryErrorCodes,
    handler: async () => runDigestWorker(input.db)
  });
  return {
    digest: execution.result ?? "",
    queueRuntime: {
      taskRunId: task.id,
      status: execution.status,
      errorCode: execution.errorCode
    }
  };
}

export function runDigestWorker(db: InMemoryDatabase): string {
  const scores = [...db.jobScores.values()];
  return renderDigest({
    responses: db.messageClassifications.size,
    manualReviewItems: db.manualReviewItems.size,
    interviews: db.interviewEvents.size,
    providerIssues: [...db.providerHealth.values()].filter((health) => health.status !== "stable").map((health) => health.providerId),
    pipelineStats: renderPipeline({
      discovered: db.jobs.size,
      normalized: db.jobs.size,
      shortlisted: scores.filter((score) => score.decision === "shortlisted").length,
      rejected: scores.filter((score) => score.decision === "rejected").length,
      prepared: db.applications.size,
      applied: [...db.applications.values()].filter((application) => application.status === "applied").length,
      interviews: db.interviewEvents.size
    })
  });
}
