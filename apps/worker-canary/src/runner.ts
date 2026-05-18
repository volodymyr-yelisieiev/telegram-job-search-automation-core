import { CanaryRunner } from "@job-search/automation";
import { executeQueueTask, queuePolicies, type InMemoryDatabase, type QueueAdapter, type TaskRunStore } from "@job-search/db";
import type { ProviderRegistry } from "@job-search/providers";
import { pageFingerprints, selectorPacks } from "@job-search/providers";

export async function runCanaryWorker(input: {
  registry: ProviderRegistry;
  canary?: CanaryRunner;
  db?: InMemoryDatabase;
  queue?: QueueAdapter;
  taskRunStore?: TaskRunStore;
}): Promise<Array<{ providerId: string; status: "passed" | "failed"; checks: string[]; failures: string[] }> & { queueRuntime?: { taskRunId: string; status: string; errorCode: string | null } }> {
  if (input.queue && input.taskRunStore) {
    const task = await input.queue.enqueue(
      "canary_queue",
      { providerId: "all" },
      { idempotencyKey: "canary:all", deduplicationKey: "all" }
    );
    const execution = await executeQueueTask({
      taskRunStore: input.taskRunStore,
      task,
      noRetryErrorCodes: queuePolicies.canary_queue.noRetryErrorCodes,
      handler: async () => processCanaries(input)
    });
    const results = (execution.result ?? []) as Array<{ providerId: string; status: "passed" | "failed"; checks: string[]; failures: string[] }> & {
      queueRuntime?: { taskRunId: string; status: string; errorCode: string | null };
    };
    results.queueRuntime = {
      taskRunId: task.id,
      status: execution.status,
      errorCode: execution.errorCode
    };
    return results;
  }
  return processCanaries(input);
}

async function processCanaries(input: {
  registry: ProviderRegistry;
  canary?: CanaryRunner;
  db?: InMemoryDatabase;
}): Promise<Array<{ providerId: string; status: "passed" | "failed"; checks: string[]; failures: string[] }>> {
  const canary = input.canary ?? new CanaryRunner();
  const results = [];
  for (const provider of input.registry.list()) {
    const canaryInput: { selectorPack?: { selectors: Record<string, unknown> }; fingerprints?: Array<{ id?: string }> } = {};
    const selectorPack = selectorPacks[provider.providerId];
    const fingerprints = pageFingerprints[provider.providerId];
    if (selectorPack) {
      canaryInput.selectorPack = selectorPack;
    }
    if (fingerprints) {
      canaryInput.fingerprints = fingerprints;
    }
    const result = await canary.runProviderCanary(provider.providerId, canaryInput);
    input.db?.recordCanaryRun(result);
    results.push(result);
  }
  return results;
}
