import { describe, expect, it } from "vitest";
import {
  buildDedupKey,
  createDefaultCandidateProfile,
  DedupEngine,
  PolicyEngine,
  ScoringEngine
} from "@job-search/domain";
import { createFixtureRuntime } from "@job-search/testing";

describe("scoring, deduplication and policy", () => {
  it("shortlists a strong backend job and rejects a poor fit", async () => {
    const runtime = await createFixtureRuntime();
    const profile = createDefaultCandidateProfile();
    const scoring = new ScoringEngine();
    const strongJob = runtime.jobs.find((job) => job.externalId === "hh-1001");
    const poorFit = runtime.jobs.find((job) => job.externalId === "hh-1002");

    expect(strongJob).toBeDefined();
    expect(poorFit).toBeDefined();

    const strongScore = scoring.score(strongJob!, profile);
    const poorScore = scoring.score(poorFit!, profile);

    expect(strongScore.decision).toBe("shortlisted");
    expect(strongScore.score).toBeGreaterThanOrEqual(72);
    expect(poorScore.decision).toBe("rejected");
    expect(poorScore.hardRejections).toContain("Compensation is below minimum");
  });

  it("prevents exact duplicate applications by provider job key", async () => {
    const runtime = await createFixtureRuntime();
    const job = runtime.jobs[0]!;
    const engine = new DedupEngine();

    const decision = engine.decide(job, [{ entityId: "existing-app", key: buildDedupKey(job) }]);

    expect(decision.status).toBe("duplicate");
    expect(decision.actions).toContain("skip_apply");
  });

  it("requires approval in review-first local-safe mode", async () => {
    const runtime = await createFixtureRuntime();
    const profile = {
      ...runtime.profile,
      userConsent: { ...runtime.profile.userConsent, autoApply: true }
    };
    const job = runtime.jobs[0]!;
    const scoring = new ScoringEngine();
    const score = scoring.score(job, profile);
    const policy = new PolicyEngine();

    const output = policy.check({
      action: "send_application",
      mode: "review_first",
      providerStatus: "stable",
      candidateProfile: profile,
      score,
      dedupDecision: { status: "new", confidence: 1, matchedEntities: [], actions: ["continue"] },
      idempotencyKey: "apply:user-001:hh:hh-1001",
      proofReady: true,
      validationPassed: true,
      irreversibleActionsEnabled: false,
      rateLimitAvailable: true
    });

    expect(output.decision).toBe("requires_user_approval");
    expect(output.requiresUserApproval).toBe(true);
  });
});
