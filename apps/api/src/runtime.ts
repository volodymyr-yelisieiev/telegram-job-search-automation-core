import {
  buildDedupKey,
  CoverLetterEngine,
  DedupEngine,
  makeApplicationDraftContentHash,
  makeApplicationIdempotencyKey,
  PolicyEngine,
  ResumeRouter,
  ScoringEngine
} from "@job-search/domain";
import type { RuntimeConfig } from "@job-search/config";
import { evaluateApplicationRateLimits, PostgresRuntimeDatabase, type InMemoryDatabase } from "@job-search/db";
import type { ProviderRegistry } from "@job-search/providers";

export async function runLocalPipeline(input: {
  db: InMemoryDatabase;
  registry: ProviderRegistry;
  config: RuntimeConfig;
}): Promise<{ normalized: number; shortlisted: number; prepared: number; manualReview: number }> {
  if (!(input.db instanceof PostgresRuntimeDatabase) && input.db.systemMode === "review_first" && input.config.app.mode !== "review_first") {
    input.db.systemMode = input.config.app.mode;
  }
  const scoring = new ScoringEngine();
  const dedup = new DedupEngine();
  const router = new ResumeRouter();
  const coverLetters = new CoverLetterEngine();
  const policy = new PolicyEngine();
  let normalized = 0;
  let shortlisted = 0;
  let prepared = 0;
  let manualReview = 0;

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
    const refs = await provider.discoverJobs(plan);
    const runStart = {
      rawCount: refs.length,
      normalizedCount: 0,
      rejectedCount: 0,
      shortlistedCount: 0,
      errors: [] as string[]
    };
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
      input.db.upsertJob(job);
      normalized += 1;
      runStart.normalizedCount += 1;

      const existing = [...input.db.jobs.values()]
        .filter((existingJob) => existingJob.id !== job.id)
        .map((existingJob) => ({ entityId: existingJob.id, key: buildDedupKey(existingJob) }));
      const dedupDecision = dedup.decide(job, existing);
      input.db.saveDedupDecision(job, dedupDecision);

      const score = scoring.score(job, input.db.candidateProfile);
      input.db.saveScore(job.id, score);
      if (score.decision !== "shortlisted" || dedupDecision.status !== "new" || !provider.capabilities.autoApply) {
        if (score.decision === "rejected") {
          runStart.rejectedCount += 1;
        }
        continue;
      }
      shortlisted += 1;
      runStart.shortlistedCount += 1;

      if (input.db.systemMode === "read_only") {
        continue;
      }

      const resumeRoute = router.select(job, input.db.candidateProfile);
      const coverLetter = coverLetters.generate(job, input.db.candidateProfile, resumeRoute);
      if (!resumeRoute.resumeId || coverLetter.validationStatus !== "passed") {
        input.db.createManualReview({
          userId: input.db.candidateProfile.userId,
          entityType: "job",
          entityId: job.id,
          reasonCode: "application_draft_validation_failed",
          severity: "high",
          recommendedAction: "Review resume routing and cover letter validation"
        });
        manualReview += 1;
        continue;
      }

      const draft = await provider.prepareApplication({
        job,
        profile: input.db.candidateProfile,
        score,
        resumeRoute,
        coverLetter
      });
      const dryRun = await provider.dryRunApplication(draft);
      for (const errorCode of dryRun.errors) {
        if (["captcha_required", "provider_rate_limited", "provider_terms_block", "anti_automation_detected"].includes(errorCode)) {
          input.db.markProviderNeedsReview({ providerId: provider.providerId, errorCode, entityId: draft.draftId });
        }
      }
      const proofPack = input.db.recordDryRunProof({
        result: dryRun,
        entityType: "application_draft",
        entityId: draft.draftId,
        actor: "application-orchestrator"
      });
      const rateLimit = evaluateApplicationRateLimits({
        profile: input.db.candidateProfile,
        applications: input.db.applications.values(),
        jobs: input.db.jobs.values(),
        job,
        providerId: provider.providerId,
        includePrepared: true
      });
      const policyResult = policy.check({
        action: "send_application",
        mode: input.db.systemMode,
        providerStatus: health.status,
        candidateProfile: input.db.candidateProfile,
        score,
        dedupDecision,
        idempotencyKey: draft.idempotencyKey,
        proofReady: Boolean(proofPack.auditEventId),
        validationPassed: dryRun.status === "passed" && coverLetter.validationStatus === "passed",
        irreversibleActionsEnabled: input.config.app.irreversibleActionsEnabled,
        rateLimitAvailable: rateLimit.allowed
      });
      input.db.recordPolicyCheck({
        entityType: "application_draft",
        entityId: draft.draftId,
        result: policyResult
      });

      const applicationStatus =
        policyResult.decision === "deny"
          ? "apply_blocked_by_policy"
          : policyResult.requiresUserApproval
            ? "manual_review_required"
            : "application_prepared";

      const applicationIdempotencyKey = makeApplicationIdempotencyKey({
        userId: input.db.candidateProfile.userId,
        provider: provider.providerId,
        externalJobId: job.externalId
      });
      const application = input.db.createApplication({
        userId: input.db.candidateProfile.userId,
        jobId: job.id,
        providerId: provider.providerId,
        externalJobId: job.externalId,
        candidateProfileId: input.db.candidateProfile.id,
        resumeId: resumeRoute.resumeId,
        coverLetterId: draft.coverLetterId,
        status: applicationStatus,
        idempotencyKey: applicationIdempotencyKey,
        dedupKey: buildDedupKey(job).providerJobKey,
        draftVariantKey: makeApplicationDraftContentHash({
          jobId: draft.jobId,
          providerId: draft.providerId,
          externalJobId: draft.externalJobId,
          candidateProfileId: draft.candidateProfileId,
          resumeId: draft.resumeId,
          coverLetterId: draft.coverLetterId,
          coverLetterText: draft.coverLetterText,
          idempotencyKey: applicationIdempotencyKey
        }),
        proofPackId: proofPack.proofPackId,
        policyDecision: policyResult.decision,
        policyVersion: policyResult.policyVersion
      });
      prepared += 1;

      if (policyResult.requiresUserApproval) {
        const review = input.db.createManualReview({
          userId: input.db.candidateProfile.userId,
          entityType: "application",
          entityId: application.id,
          reasonCode: "review_first_requires_approval",
          severity: "medium",
          recommendedAction: "Approve or reject prepared application draft"
        });
        input.db.createApprovalRequest({
          userId: input.db.candidateProfile.userId,
          entityType: "application",
          entityId: application.id,
          requestedAction: "send_application",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          policyDecisionId: null,
          draftHash: application.draftVariantKey ?? null,
          manualReviewId: review.id
        });
        manualReview += 1;
      }
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

  await flushRuntimePersistence(input.db);
  return { normalized, shortlisted, prepared, manualReview };
}

async function flushRuntimePersistence(db: InMemoryDatabase): Promise<void> {
  if ("flushPersistence" in db && typeof db.flushPersistence === "function") {
    await db.flushPersistence();
  }
}
