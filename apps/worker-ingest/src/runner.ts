import type { RuntimeConfig } from "@job-search/config";
import type { InMemoryDatabase } from "@job-search/db";
import { DedupEngine, ScoringEngine, buildDedupKey } from "@job-search/domain";
import type { ProviderRegistry } from "@job-search/providers";

export async function runIngestWorker(input: {
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
    const plan = await provider.compileSearchPlan(input.db.searchProfile);
    const refs = await provider.discoverJobs(plan);
    for (const ref of refs) {
      const raw = await provider.fetchJob(ref);
      const job = await provider.normalizeJob(raw);
      const existing = [...input.db.jobs.values()]
        .filter((existingJob) => existingJob.id !== job.id)
        .map((existingJob) => ({ entityId: existingJob.id, key: buildDedupKey(existingJob) }));
      input.db.upsertJob(job);
      input.db.saveDedupDecision(job, dedup.decide(job, existing));
      input.db.saveScore(job.id, scoring.score(job, input.db.candidateProfile));
      processed += 1;
    }
  }

  return { processed };
}
