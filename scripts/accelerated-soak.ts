import { loadConfig, type RuntimeConfig } from "@job-search/config";
import { InMemoryDatabase } from "@job-search/db";
import { DataQualityService, AnalyticsService } from "@job-search/domain";
import { createFixtureProviderRegistry, type ProviderRegistry } from "@job-search/providers";
import { runLocalPipeline } from "../apps/api/src/runtime";
import { runApplyWorker } from "../apps/worker-apply/src/runner";
import { runCanaryWorker } from "../apps/worker-canary/src/runner";
import { runInboxWorker } from "../apps/worker-inbox/src/runner";

export interface SoakIteration {
  iteration: number;
  normalized: number;
  shortlisted: number;
  prepared: number;
  manualReview: number;
  canaryFailures: number;
  inboxClassified: number;
  applyDryRunStatus: string;
}

export interface AcceleratedSoakReport {
  startedAt: string;
  completedAt: string;
  iterations: number;
  duplicateApplicationCount: number;
  proofCoveragePercent: number;
  dataQuality: ReturnType<DataQualityService["evaluate"]>;
  analytics: ReturnType<AnalyticsService["funnel"]>;
  iterationResults: SoakIteration[];
  acceptance: {
    passed: boolean;
    failures: string[];
  };
}

export async function runAcceleratedSoak(input: {
  iterations: number;
  config?: RuntimeConfig;
  db?: InMemoryDatabase;
  registry?: ProviderRegistry;
}): Promise<AcceleratedSoakReport> {
  const startedAt = new Date().toISOString();
  const config = input.config ?? loadConfig({ APP_MODE: "review_first", API_TOKEN: "soak-token" });
  const db = input.db ?? new InMemoryDatabase();
  const registry = input.registry ?? createFixtureProviderRegistry();
  const iterationResults: SoakIteration[] = [];

  for (let iteration = 1; iteration <= input.iterations; iteration += 1) {
    const pipeline = await runLocalPipeline({ config, db, registry });
    const canaries = await runCanaryWorker({ registry, db });
    const inbox = await runInboxWorker({ config, db, registry });
    const apply = runApplyWorker({ db });
    iterationResults.push({
      iteration,
      normalized: pipeline.normalized,
      shortlisted: pipeline.shortlisted,
      prepared: pipeline.prepared,
      manualReview: pipeline.manualReview,
      canaryFailures: canaries.filter((canary) => canary.status === "failed").length,
      inboxClassified: inbox.classified,
      applyDryRunStatus: apply.status
    });
  }

  const applications = [...db.applications.values()];
  const uniqueIdempotencyKeys = new Set(applications.map((application) => application.idempotencyKey));
  const duplicateApplicationCount = applications.length - uniqueIdempotencyKeys.size;
  const proofCoveragePercent =
    applications.length === 0
      ? 100
      : Math.round((applications.filter((application) => Boolean(application.proofPackId)).length / applications.length) * 100);
  const dataQuality = new DataQualityService().evaluate({
    jobs: [...db.jobs.values()],
    dedupDecisions: db.dedupDecisions,
    scores: db.jobScores
  });
  const analytics = new AnalyticsService().funnel({
    jobs: [...db.jobs.values()],
    scores: db.jobScores,
    applications,
    responses: db.messageClassifications.size,
    interviews: db.interviewEvents.size
  });
  const failures = [
    duplicateApplicationCount > 0 ? "duplicate_applications_detected" : null,
    proofCoveragePercent < 100 ? "proof_coverage_below_100_percent" : null,
    iterationResults.some((result) => result.canaryFailures > 0) ? "canary_failures_detected" : null,
    iterationResults.some((result) => result.applyDryRunStatus !== "succeeded") ? "apply_dry_run_failed" : null
  ].filter((failure): failure is string => failure !== null);

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    iterations: input.iterations,
    duplicateApplicationCount,
    proofCoveragePercent,
    dataQuality,
    analytics,
    iterationResults,
    acceptance: {
      passed: failures.length === 0,
      failures
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const iterations = Number(process.env.SOAK_ITERATIONS ?? "7");
  const report = await runAcceleratedSoak({ iterations });
  console.log(JSON.stringify(report, null, 2));
  if (!report.acceptance.passed) {
    process.exitCode = 1;
  }
}
