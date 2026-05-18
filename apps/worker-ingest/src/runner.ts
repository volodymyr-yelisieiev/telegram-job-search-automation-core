import type { RuntimeConfig } from "@job-search/config";
import { executeQueueTask, queuePolicies, type InMemoryDatabase, type QueueAdapter, type TaskRunStore } from "@job-search/db";
import { DedupEngine, ScoringEngine, buildDedupKey } from "@job-search/domain";
import type { ProviderRegistry } from "@job-search/providers";

export async function runIngestWorker(input: {
  config: RuntimeConfig;
  db: InMemoryDatabase;
  registry: ProviderRegistry;
  queue?: QueueAdapter;
  taskRunStore?: TaskRunStore;
}): Promise<{ processed: number; queueRuntime?: { taskRunId: string; status: string; errorCode: string | null } }> {
  if (input.queue && input.taskRunStore) {
    const task = await input.queue.enqueue(
      "source_poll_queue",
      { searchProfileId: input.db.searchProfile.searchProfileId },
      { idempotencyKey: `source_poll:${input.db.searchProfile.searchProfileId}`, deduplicationKey: input.db.searchProfile.searchProfileId }
    );
    const execution = await executeQueueTask({
      taskRunStore: input.taskRunStore,
      task,
      noRetryErrorCodes: queuePolicies.source_poll_queue.noRetryErrorCodes,
      handler: async () => processIngest(input)
    });
    return {
      processed: execution.result?.processed ?? 0,
      queueRuntime: {
        taskRunId: task.id,
        status: execution.status,
        errorCode: execution.errorCode
      }
    };
  }
  return processIngest(input);
}

async function processIngest(input: {
  config: RuntimeConfig;
  db: InMemoryDatabase;
  registry: ProviderRegistry;
}): Promise<{ processed: number }> {
  const scoring = new ScoringEngine();
  const dedup = new DedupEngine();
  let processed = 0;

  for (const provider of input.registry.list()) {
    const health = await provider.healthcheck({ now: new Date(), environment: input.config.app.environment });
    input.db.updateProviderHealth(health);
    if (health.status === "blocked" || health.status === "deprecated") {
      input.db.recordSearchRun({
        providerId: provider.providerId,
        searchProfileId: input.db.searchProfile.searchProfileId,
        query: "",
        filters: {},
        rawCount: 0,
        normalizedCount: 0,
        rejectedCount: 0,
        shortlistedCount: 0,
        stopCondition: `provider_${health.status}`,
        errors: [health.message]
      });
      continue;
    }
    const plan = await provider.compileSearchPlan(input.db.searchProfile);
    const runStart = {
      rawCount: 0,
      normalizedCount: 0,
      rejectedCount: 0,
      shortlistedCount: 0,
      errors: [] as string[]
    };
    let refs;
    try {
      refs = await provider.discoverJobs(plan);
      runStart.rawCount = refs.length;
    } catch (error) {
      input.db.recordSearchRun({
        providerId: provider.providerId,
        searchProfileId: plan.searchProfileId,
        query: plan.query,
        filters: plan.filters,
        rawCount: 0,
        normalizedCount: 0,
        rejectedCount: 0,
        shortlistedCount: 0,
        stopCondition: "completed_with_errors",
        errors: [String(error)]
      });
      continue;
    }
    for (const ref of refs) {
      let raw;
      let job;
      try {
        raw = await provider.fetchJob(ref);
        job = await provider.normalizeJob(raw);
      } catch (error) {
        runStart.errors.push(String(error));
        continue;
      }
      const existing = [...input.db.jobs.values()]
        .filter((existingJob) => existingJob.id !== job.id)
        .map((existingJob) => ({ entityId: existingJob.id, key: buildDedupKey(existingJob) }));
      input.db.upsertJob(job);
      input.db.saveDedupDecision(job, dedup.decide(job, existing));
      const score = scoring.score(job, input.db.candidateProfile);
      input.db.saveScore(job.id, score);
      runStart.normalizedCount += 1;
      if (score.decision === "shortlisted") {
        runStart.shortlistedCount += 1;
      } else {
        runStart.rejectedCount += 1;
      }
      processed += 1;
    }
    input.db.recordSearchRun({
      providerId: provider.providerId,
      searchProfileId: plan.searchProfileId,
      query: plan.query,
      filters: plan.filters,
      rawCount: runStart.rawCount,
      normalizedCount: runStart.normalizedCount,
      rejectedCount: runStart.rejectedCount,
      shortlistedCount: runStart.shortlistedCount,
      stopCondition: runStart.errors.length > 0 ? "completed_with_errors" : "completed",
      errors: runStart.errors
    });
  }

  return { processed };
}
