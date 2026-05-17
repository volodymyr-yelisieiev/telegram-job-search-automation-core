import {
  buildDedupKey,
  createDefaultCandidateProfile,
  createDefaultSearchProfile,
  ScoringEngine,
  type CandidateProfile,
  type NormalizedJob,
  type SearchProfile
} from "@job-search/domain";
import { createFixtureProviderRegistry } from "@job-search/providers";

export interface FixtureRuntime {
  profile: CandidateProfile;
  searchProfile: SearchProfile;
  jobs: NormalizedJob[];
}

export async function createFixtureRuntime(): Promise<FixtureRuntime> {
  const profile = createDefaultCandidateProfile();
  const searchProfile = createDefaultSearchProfile();
  const registry = createFixtureProviderRegistry();
  const jobs: NormalizedJob[] = [];

  for (const provider of registry.list()) {
    const plan = await provider.compileSearchPlan(searchProfile);
    const refs = await provider.discoverJobs(plan);
    for (const ref of refs) {
      const raw = await provider.fetchJob(ref);
      jobs.push(await provider.normalizeJob(raw));
    }
  }

  return { profile, searchProfile, jobs };
}

export async function createScoredFixtureJobs() {
  const runtime = await createFixtureRuntime();
  const scoring = new ScoringEngine();
  return runtime.jobs.map((job) => ({
    job,
    dedupKey: buildDedupKey(job),
    score: scoring.score(job, runtime.profile)
  }));
}
