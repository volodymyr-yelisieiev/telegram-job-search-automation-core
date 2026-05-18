import { DedupEngine, ScoringEngine, buildDedupKey, createDefaultCandidateProfile } from "@job-search/domain";
import {
  FixtureProviderModule,
  generateStressFixtureJobs,
  hhCapabilities,
  robotaCapabilities,
  telegramCapabilities,
  type FixtureJob
} from "@job-search/providers";

export interface ReadOnlyStressReport {
  targetJobs: number;
  processedJobs: number;
  schemaViolations: number;
  duplicateDecisions: number;
  shortlisted: number;
  rejected: number;
  providerBreakdown: Record<string, number>;
  acceptance: {
    passed: boolean;
    failures: string[];
  };
}

export async function runReadOnlyStress(input: { targetJobs?: number } = {}): Promise<ReadOnlyStressReport> {
  const targetJobs = input.targetJobs ?? 10_000;
  const fixtures = generateStressFixtureJobs(targetJobs);
  const grouped = groupByProvider(fixtures);
  const profile = createDefaultCandidateProfile();
  const dedup = new DedupEngine();
  const scoring = new ScoringEngine();
  const existing: Array<{ entityId: string; key: ReturnType<typeof buildDedupKey> }> = [];
  let processedJobs = 0;
  let schemaViolations = 0;
  let duplicateDecisions = 0;
  let shortlisted = 0;
  let rejected = 0;
  const providerBreakdown: Record<string, number> = {};

  for (const [providerId, providerFixtures] of Object.entries(grouped)) {
    const provider = new FixtureProviderModule(providerId, capabilitiesFor(providerId), providerFixtures);
    providerBreakdown[providerId] = providerFixtures.length;
    for (const fixture of providerFixtures) {
      try {
        const normalized = await provider.normalizeJob(fixture.raw);
        const decision = dedup.decide(normalized, existing);
        if (decision.status !== "new") {
          duplicateDecisions += 1;
        }
        existing.push({ entityId: normalized.id, key: buildDedupKey(normalized) });
        const score = scoring.score(normalized, profile);
        if (score.decision === "shortlisted") {
          shortlisted += 1;
        } else {
          rejected += 1;
        }
        processedJobs += 1;
      } catch {
        schemaViolations += 1;
      }
    }
  }

  const failures = [
    processedJobs !== targetJobs ? "processed_job_count_mismatch" : null,
    schemaViolations > 0 ? "schema_violations_detected" : null,
    shortlisted + rejected !== processedJobs ? "scoring_state_loss_detected" : null
  ].filter((failure): failure is string => failure !== null);

  return {
    targetJobs,
    processedJobs,
    schemaViolations,
    duplicateDecisions,
    shortlisted,
    rejected,
    providerBreakdown,
    acceptance: {
      passed: failures.length === 0,
      failures
    }
  };
}

function groupByProvider(fixtures: FixtureJob[]): Record<string, FixtureJob[]> {
  const grouped: Record<string, FixtureJob[]> = {};
  for (const fixture of fixtures) {
    grouped[fixture.ref.providerId] = [...(grouped[fixture.ref.providerId] ?? []), fixture];
  }
  return grouped;
}

function capabilitiesFor(providerId: string) {
  if (providerId === "robota") {
    return robotaCapabilities;
  }
  if (providerId === "telegram") {
    return telegramCapabilities;
  }
  return hhCapabilities;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runReadOnlyStress({ targetJobs: Number(process.env.STRESS_JOBS ?? "10000") });
  console.log(JSON.stringify(report, null, 2));
  if (!report.acceptance.passed) {
    process.exitCode = 1;
  }
}
