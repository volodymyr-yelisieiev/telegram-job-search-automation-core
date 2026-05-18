import { describe, expect, it } from "vitest";
import {
  buildDedupKey,
  AnalyticsService,
  ArtifactAccessPolicy,
  AutoApplyRampController,
  canonicalizeUrl,
  ClassificationEvalService,
  ConversationEngine,
  ConversationLinker,
  ControlledAutoApplyEligibility,
  CoverLetterEngine,
  createDefaultCandidateProfile,
  DataQualityService,
  DedupEngine,
  DependencyAuditService,
  FollowUpScheduler,
  HistoricalInterviewLikelihoodModel,
  InterviewCoordinator,
  LowQualityFeedbackModel,
  makeInterviewConfirmIdempotencyKey,
  makeApplicationDraftVariantKey,
  makeApplicationIdempotencyKey,
  PolicyEngine,
  ResponsePriorityService,
  RetentionEnforcementPlanner,
  RetentionPolicyEngine,
  ReplyAdaptationService,
  ReplyTemplateEngine,
  ResumeRouter,
  ScoringEngine,
  scoreWeightProfiles,
  SnippetGovernanceService,
  SubmitApprovalOrchestrator,
  ThreadContradictionChecker,
  type NormalizedJob
} from "@job-search/domain";
import { createFixtureRuntime } from "@job-search/testing";

function cloneJob(job: NormalizedJob, patch: Partial<NormalizedJob>): NormalizedJob {
  return { ...job, ...patch };
}

describe("domain hardening matrix", () => {
  it("canonicalizes URLs for deduplication", async () => {
    const runtime = await createFixtureRuntime();
    const job = runtime.jobs[0]!;
    const base = cloneJob(job, {
      canonicalUrl: "https://www.hh.example/vacancy/1001/?utm_source=x&b=2&a=1#fragment"
    });
    const variant = cloneJob(job, {
      id: "variant",
      canonicalUrl: "https://hh.example/vacancy/1001?a=1&b=2"
    });

    expect(canonicalizeUrl(base.canonicalUrl)).toBe("https://hh.example/vacancy/1001?a=1&b=2");
    expect(buildDedupKey(base).canonicalUrlKey).toBe(buildDedupKey(variant).canonicalUrlKey);
    expect(canonicalizeUrl("NOT A URL/")).toBe("not a url");
  });

  it("covers dedup new, canonical, content hash and company-role branches", async () => {
    const runtime = await createFixtureRuntime();
    const job = runtime.jobs[0]!;
    const engine = new DedupEngine();

    expect(engine.decide(job, []).status).toBe("new");
    expect(
      engine.decide(cloneJob(job, { id: "canonical", externalId: "different" }), [
        { entityId: "canonical-existing", key: buildDedupKey(job) }
      ]).status
    ).toBe("duplicate");

    const contentExisting = cloneJob(job, { externalId: "other", canonicalUrl: "https://other.example/job" });
    const contentIncoming = cloneJob(contentExisting, { id: "incoming", externalId: "incoming", canonicalUrl: null });
    expect(engine.decide(contentIncoming, [{ entityId: "content-existing", key: buildDedupKey(contentExisting) }]).status).toBe(
      "possible_duplicate"
    );

    const roleExisting = cloneJob(job, { description: "different existing description", canonicalUrl: "https://x.example/a" });
    const roleIncoming = cloneJob(roleExisting, {
      id: "role-incoming",
      externalId: "role-incoming",
      canonicalUrl: "https://x.example/b",
      description: "different incoming description"
    });
    expect(engine.decide(roleIncoming, [{ entityId: "role-existing", key: buildDedupKey(roleExisting) }])).toMatchObject({
      status: "possible_duplicate",
      matchedEntities: [{ entityId: "role-existing", matchType: "companyRoleKey" }],
      actions: ["link_to_existing_company_thread"]
    });
  });

  it("summarizes read-only data quality and score profiles", async () => {
    const runtime = await createFixtureRuntime();
    const jobs = runtime.jobs;
    const dedup = new DedupEngine();
    const decisions = new Map(jobs.map((job) => [job.id, dedup.decide(job, [])]));
    const profile = createDefaultCandidateProfile();
    const scores = new Map(jobs.map((job) => [job.id, new ScoringEngine().score(job, profile)]));
    const report = new DataQualityService().evaluate({ jobs, dedupDecisions: decisions, scores, lowConfidenceThreshold: 90 });
    const duplicateReport = new DataQualityService().evaluate({
      jobs,
      dedupDecisions: new Map([[jobs[0]!.id, { status: "duplicate", confidence: 1, matchedEntities: [], actions: ["skip_apply"] }]]),
      scores,
      lowConfidenceThreshold: 90
    });

    expect(report.totalJobs).toBeGreaterThan(0);
    expect(duplicateReport.duplicateLikeJobIds).toContain(jobs[0]!.id);
    expect(new DataQualityService().evaluate({ jobs: [], dedupDecisions: new Map(), scores: new Map() })).toMatchObject({
      averageExtractionConfidence: 0,
      providerBreakdown: {}
    });
    expect(report.providerBreakdown.hh?.jobs).toBeGreaterThan(0);
    expect(scoreWeightProfiles.balanced.shortlistThreshold).toBe(72);
    const borderline = cloneJob(jobs[0]!, { title: "Backend Developer", description: "Node.js TypeScript APIs.", requirements: ["Node.js"] });
    expect(new ScoringEngine().score(borderline, profile, "aggressive").decision).toBe("shortlisted");
    expect(new ScoringEngine().score(borderline, profile, "selective").decision).toBe("rejected");
    expect(new AnalyticsService().funnel({ jobs: [], scores: new Map(), applications: [], responses: 0, interviews: 0 })).toMatchObject({
      shortlistRate: 0,
      applyRate: 0,
      interviewRate: 0
    });
    const analytics = new AnalyticsService();
    const otherProvider = jobs.find((job) => job.sourceProvider !== jobs[0]!.sourceProvider)?.sourceProvider ?? "other-provider";
    const dimensioned = analytics.dimensionedFunnel({
      jobs,
      scores,
      applications: [
        { status: "applied", providerId: jobs[0]!.sourceProvider, jobId: jobs[0]!.id, resumeId: "resume-backend-node-main" }
      ],
      responses: [
        { providerId: jobs[0]!.sourceProvider, jobId: jobs[0]!.id, templateId: "acknowledgment", createdAt: "2026-05-18T00:00:00.000Z" },
        { providerId: otherProvider, templateId: "salary_range_v1", createdAt: "2026-05-18T00:00:00.000Z" }
      ],
      interviews: [{ providerId: jobs[0]!.sourceProvider, jobId: jobs[0]!.id }],
      dimensions: ["provider", "strategy", "company", "role", "resume", "template", "time_window"],
      strategyByJobId: new Map(jobs.map((job) => [job.id, job.sourceProvider === "telegram" ? "selective" : "balanced"]))
    });
    expect(Object.keys(dimensioned.dimensions)).toEqual(expect.arrayContaining([`provider:${jobs[0]!.sourceProvider}`, "strategy:balanced"]));
    expect(dimensioned.dimensions[`provider:${jobs[0]!.sourceProvider}`]?.responses).toBe(1);
    expect(dimensioned.dimensions["time_window:all"]?.responses).toBe(2);
    expect(dimensioned.dimensions["template:salary_range_v1"]?.responses).toBe(1);
    const reliability = analytics.providerReliability({
      providerId: "hh",
      jobVolume: 100,
      averageExtractionConfidence: 95,
      responseRate: 0.25,
      canaryRuns: [{ status: "passed" }, { status: "failed" }],
      flowFailures: 1,
      totalFlows: 10,
      blockingIncidents: 1
    });
    expect(reliability.signals.canarySuccessRate).toBe(0.5);
    expect(reliability.recommendedStatus).not.toBe("stable");
    expect(
      analytics.assignTemplateExperiment({
        experimentId: "reply-tone",
        templateId: "acknowledgment",
        variants: ["control", "concise"],
        entityKey: "conv-1",
        policyAllowed: true,
        validationPassed: true,
        unsupportedFacts: [],
        unsafeCategory: false
      }).eligible
    ).toBe(true);
    expect(
      analytics.assignTemplateExperiment({
        experimentId: "reply-tone",
        templateId: "salary",
        variants: ["control", "direct"],
        entityKey: "conv-2",
        policyAllowed: true,
        validationPassed: true,
        unsupportedFacts: ["citizenship"],
        unsafeCategory: false
      }).eligible
    ).toBe(false);
  });

  it("uses separate submit idempotency and draft variant keys", () => {
    const submitOne = makeApplicationIdempotencyKey({ userId: "u", provider: "hh", externalJobId: "1" });
    const submitTwo = makeApplicationIdempotencyKey({ userId: "u", provider: "hh", externalJobId: "1" });
    const draftOne = makeApplicationDraftVariantKey({
      userId: "u",
      provider: "hh",
      externalJobId: "1",
      resumeId: "resume-a",
      profileId: "profile-a"
    });
    const draftTwo = makeApplicationDraftVariantKey({
      userId: "u",
      provider: "hh",
      externalJobId: "1",
      resumeId: "resume-b",
      profileId: "profile-a"
    });

    expect(submitOne).toBe(submitTwo);
    expect(draftOne).not.toBe(draftTwo);
  });

  it("scores compensation and title grey zones defensively", async () => {
    const runtime = await createFixtureRuntime();
    const profile = createDefaultCandidateProfile();
    const scoring = new ScoringEngine();
    const base = runtime.jobs[0]!;

    expect(scoring.score(cloneJob(base, { compensationMax: 36_000, compensationPeriod: "year" }), profile).hardRejections).toContain(
      "Compensation is below minimum"
    );
    expect(scoring.score(cloneJob(base, { compensationMax: 20, compensationPeriod: "hour" }), profile).hardRejections).toContain(
      "Compensation is below minimum"
    );
    expect(scoring.score(cloneJob(base, { compensationMin: 7000, compensationMax: 5000 }), profile).hardRejections).toContain(
      "Compensation range is invalid"
    );
    expect(scoring.score(cloneJob(base, { title: "Backend Sales Manager" }), profile).reasons.join(" ")).not.toContain(
      "Title matches target role"
    );
    expect(
      scoring.score(cloneJob(base, { compensationMin: 5000, compensationMax: 6000, compensationCurrency: "USD" }), profile).risks
    ).toContain("Compensation currency is not EUR");
    expect(scoring.score(cloneJob(base, { companyName: "Blocked GmbH" }), { ...profile, blacklists: { ...profile.blacklists, companies: ["Blocked"] } }).hardRejections).toContain(
      "Company is blacklisted"
    );
    expect(scoring.score(cloneJob(base, { description: `${base.description} gambling` }), { ...profile, blacklists: { ...profile.blacklists, keywords: ["gambling"] } }).hardRejections).toContain(
      "Vacancy contains blacklisted keyword"
    );
    expect(scoring.score(cloneJob(base, { extractionConfidence: 50 }), profile).hardRejections).toContain(
      "Extraction confidence is below auto-apply threshold"
    );
    expect(scoring.score(cloneJob(base, { title: "Junior Node.js Backend Developer", seniority: "junior" }), profile).hardRejections).toContain(
      "Seniority is below target"
    );
    expect(scoring.score(cloneJob(base, { availabilityStatus: "closed" }), profile).hardRejections).toContain("Vacancy is closed");
    expect(scoring.score(cloneJob(base, { alreadyApplied: true }), profile).hardRejections).toContain("Vacancy is already applied");
    expect(scoring.score(cloneJob(base, { qualitySignals: ["agency_post"] }), profile).hardRejections).toContain(
      "Vacancy quality signal blocks auto-apply"
    );
    expect(scoring.score(cloneJob(base, { workFormat: "unknown", seniority: null }), profile).risks).toEqual(
      expect.arrayContaining(["Work format is unknown", "Seniority is not explicit"])
    );
    expect(scoring.score(cloneJob(base, { compensationPeriod: "unknown", compensationCurrency: "EUR" }), profile).risks).not.toContain(
      "Compensation currency is not EUR"
    );
    expect(scoring.score(cloneJob(base, { title: "Developer" }), { ...profile, targetTitles: ["developer"] }).reasons).toContain(
      "Title matches target role: Developer"
    );
    expect(new ResumeRouter().select(cloneJob(base, { sourceProvider: "missing-provider" }), profile)).toMatchObject({
      resumeId: null,
      confidence: 0
    });
  });

  it("hard-denies submit modes that are read-only or dry-run only", async () => {
    const runtime = await createFixtureRuntime();
    const profile = { ...createDefaultCandidateProfile(), userConsent: { autoApply: true, autoReply: true, interviewScheduling: true } };
    const score = new ScoringEngine().score(runtime.jobs[0]!, profile);
    const policy = new PolicyEngine();

    for (const mode of ["read_only", "dry_run_apply"] as const) {
      const result = policy.check({
        action: "send_application",
        mode,
        providerStatus: "stable",
        candidateProfile: profile,
        score,
        dedupDecision: { status: "new", confidence: 1, matchedEntities: [], actions: ["continue"] },
        idempotencyKey: "apply:user-001:hh:hh-1001",
        proofReady: true,
        validationPassed: true,
        irreversibleActionsEnabled: true,
        rateLimitAvailable: true
      });
      expect(result.decision).toBe("deny");
      expect(result.reasons).toContain(`Mode ${mode} does not allow submit`);
    }
  });

  it("validates cover-letter and reply grey zones", async () => {
    const runtime = await createFixtureRuntime();
    const profile = createDefaultCandidateProfile();
    const job = runtime.jobs[0]!;
    const cover = new CoverLetterEngine();

    expect(
      cover.validate({
        text: "TODO <company>",
        factsUsed: ["unknown_fact", "citizenship"],
        profile,
        maxLength: 5
      })
    ).toEqual({
      valid: false,
      riskFlags: expect.arrayContaining([
        "cover_letter_too_long",
        "cover_letter_contains_placeholder",
        "unsupported_fact:unknown_fact",
        "forbidden_fact:citizenship"
      ])
    });

    const generated = cover.generate(job, profile, { resumeId: null, confidence: 0, rationale: [] });
    expect(generated.resumeId).toBe("missing-resume");

    const conversation = new ConversationEngine();
    const outbound = conversation.validateOutbound(
      {
        conversationId: "conv",
        inboundMessageId: "msg",
        category: "request_for_details",
        language: "en",
        text: "x".repeat(1201),
        factsUsed: ["unknown_fact"],
        idempotencyKey: "reply:conv:msg:template"
      },
      profile
    );
    expect(outbound.riskFlags).toEqual(expect.arrayContaining(["unsupported_fact:unknown_fact", "reply_too_long"]));
    expect(makeInterviewConfirmIdempotencyKey({ conversationId: "conv", slotHash: "slot" })).toBe("interview_confirm:conv:slot");
  });

  it("handles conversation low-confidence, sensitive data, invalid/unavailable and valid interview slots", () => {
    const profile = createDefaultCandidateProfile();
    const conversation = new ConversationEngine();
    const coordinator = new InterviewCoordinator();

    const unknown = conversation.classify("Please handle this unusual request.", "Europe/Vienna");
    expect(unknown.category).toBe("unknown");
    expect(unknown.allowedAutoReply).toBe(false);

    const sensitive = conversation.classify("Please send passport and citizenship.", "Europe/Vienna");
    expect(sensitive.sensitiveDataRequested).toBe(true);
    expect(sensitive.allowedAutoReply).toBe(false);
    expect(conversation.classify("Please complete this test assignment.", "Europe/Vienna").category).toBe("test_assignment");
    expect(conversation.classify("What salary range do you expect?", "Europe/Vienna").category).toBe("request_for_salary_expectation");
    expect(conversation.classify("Where are you located?", "Europe/Vienna").category).toBe("request_for_location");
    expect(conversation.classify("Unfortunately we will not proceed.", "Europe/Vienna").category).toBe("rejection");
    expect(conversation.classify("Thanks, received.", "Europe/Vienna").category).toBe("acknowledgment");

    expect(coordinator.chooseSlot([{ date: "2026-05-18", time: "09:00", timezone: "Europe/Vienna" }], profile, new Date("2026-05-18T08:00:00+02:00"))).toBeNull();

    const chosen = coordinator.chooseSlot(
      [{ date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }],
      profile,
      new Date("2026-05-18T08:00:00+02:00")
    );
    expect(chosen).toMatchObject({ date: "2026-05-20", time: "10:30" });
  });

  it("covers roadmap-local reply, scheduling, apply eligibility and governance services", async () => {
    const runtime = await createFixtureRuntime();
    const job = runtime.jobs[0]!;
    const profile = { ...createDefaultCandidateProfile(), userConsent: { autoApply: true, autoReply: true, interviewScheduling: true } };
    const score = new ScoringEngine().score(job, profile, "selective");
    expect(score.scoreProfileVersion).toBe(scoreWeightProfiles.selective.version);
    expect(score.factorWeights?.primaryStack).toBeGreaterThan(0);

    expect(
      new CoverLetterEngine().validate({
        text: "Hello, I led a team and expect salary above the range.",
        factsUsed: [],
        profile,
        job: cloneJob(job, { compensationMax: profile.compensation.minMonthlyEur - 500, compensationCurrency: "EUR", compensationPeriod: "month" }),
        expectedLanguage: "de"
      }).riskFlags
    ).toEqual(expect.arrayContaining(["cover_letter_language_mismatch", "invented_claim_detected", "salary_policy_conflict"]));

    const classification = new ConversationEngine().classify("Can we meet on 2026-05-20 10:30 for 45 min by 2026-05-19?", "Europe/Vienna");
    expect(classification.priorityScore).toBeGreaterThan(80);
    expect(classification.proposedSlots[0]).toMatchObject({ durationMinutes: 45, confidence: 0.92 });
    const classificationWithoutPriority = { ...classification };
    delete classificationWithoutPriority.priorityScore;
    expect(
      new ResponsePriorityService().rank([
        { inboundMessageId: "msg-1", classification },
        {
          inboundMessageId: "msg-low",
          classification: {
            ...classificationWithoutPriority,
            requiresReply: true,
            proposedSlots: [],
            deadline: null,
            sensitiveDataRequested: true,
            confidence: 0.2
          }
        }
      ])[0]
    ).toMatchObject({ bucket: "urgent" });
    expect(new ClassificationEvalService().report([{ text: "Thanks, received.", expectedCategory: "acknowledgment" }])).toMatchObject({ accuracy: 1 });
    expect(new ClassificationEvalService().report([])).toMatchObject({ total: 0, accuracy: 1 });
    expect(new ClassificationEvalService().report([{ text: "Thanks, received.", expectedCategory: "rejection" }]).failures).toHaveLength(1);

    const profileWithStackFact = {
      ...profile,
      facts: {
        ...profile.facts,
        primary_stack: { value: profile.primaryStack, disclosure: "allowed" as const, categories: ["details_reply"] }
      }
    };
    const templates = new ReplyTemplateEngine();
    expect(templates.draft({ conversationId: "conv", inboundMessageId: "details", classification: { ...classification, category: "request_for_details" }, profile: profileWithStackFact }).templateId).toBe("details_request_v1");
    expect(templates.draft({ conversationId: "conv", inboundMessageId: "clarify", classification: { ...classification, category: "clarifying_question" }, profile }).templateId).toBe("clarifying_question_v1");
    expect(templates.draft({ conversationId: "conv", inboundMessageId: "outreach", classification: { ...classification, category: "recruiter_outreach" }, profile: profileWithStackFact }).templateId).toBe("recruiter_outreach_interest_v1");
    expect(templates.draft({ conversationId: "conv", inboundMessageId: "schedule", classification: { ...classification, category: "scheduling_request" }, profile }).templateId).toBe("scheduling_policy_safe_v1");

    const draft = new ReplyAdaptationService().adapt({ baseText: "I can review the details.", tone: "warm" });
    expect(draft.promptVersion).toContain("reply-adapt");
    expect(new ReplyAdaptationService().adapt({ baseText: "Please share details.", tone: "formal", maxLength: 12 }).text).toBe("Thank you fo");
    expect(new ReplyAdaptationService().adapt({ baseText: "Short.", tone: "concise" }).text).toBe("Short.");
    expect(
      new ThreadContradictionChecker().check({
        draft: {
          conversationId: "conv",
          inboundMessageId: "msg",
          category: "scheduling_request",
          language: "en",
          text: "I can attend and confirm.",
          factsUsed: [],
          idempotencyKey: "reply:conv:msg:scheduling"
        },
        previousMessages: [{ text: "I am not available then." }]
      }).riskFlags
    ).toContain("contradicts_previous_unavailability");
    expect(
      new ThreadContradictionChecker().check({
        draft: {
          conversationId: "conv",
          inboundMessageId: "msg",
          category: "request_for_salary_expectation",
          language: "en",
          text: "Salary can be discussed.",
          factsUsed: [],
          idempotencyKey: "reply:conv:msg:salary"
        },
        previousMessages: [{ text: "The recruiter asked about salary." }]
      }).riskFlags
    ).toContain("salary_reply_without_fact");
    expect(new FollowUpScheduler().plan({ conversationId: "conv", lastInboundAt: "2026-05-18T00:00:00.000Z", category: "recruiter_outreach", alreadyScheduledCount: 0 }).shouldSchedule).toBe(true);
    expect(new FollowUpScheduler().plan({ conversationId: "conv", lastInboundAt: "2026-05-18T00:00:00.000Z", category: "rejection", alreadyScheduledCount: 0 }).reason).toBe("category_not_follow_up_eligible");
    expect(new FollowUpScheduler().plan({ conversationId: "conv", lastInboundAt: "2026-05-18T00:00:00.000Z", category: "recruiter_outreach", alreadyScheduledCount: 2 }).reason).toBe("follow_up_cap_reached");
    expect(new FollowUpScheduler().plan({ conversationId: "conv", lastInboundAt: "2026-05-18T00:00:00.000Z", category: "recruiter_outreach", alreadyScheduledCount: 0, threadClosed: true }).reason).toBe("thread_closed");
    expect(new FollowUpScheduler().plan({ conversationId: "conv", lastInboundAt: "2026-05-18T00:00:00.000Z", category: "recruiter_outreach", alreadyScheduledCount: 0, recruiterRepliedAfterLastFollowUp: true }).reason).toBe("recruiter_replied_after_last_follow_up");
    expect(new FollowUpScheduler().plan({ conversationId: "conv", lastInboundAt: "2026-05-18T00:00:00.000Z", category: "recruiter_outreach", alreadyScheduledCount: 0, companyScheduledCount: 5 }).reason).toBe("company_follow_up_cap_reached");
    expect(new ResponsePriorityService().rank([{ inboundMessageId: "msg-2", classification: { ...classification, requiresReply: false, priorityScore: 10 } }])[0]).toMatchObject({ bucket: "fyi" });

    const dedup = new DedupEngine().decide(job, []);
    expect(
      new ControlledAutoApplyEligibility().evaluate({
        score: { ...score, score: 90, decision: "shortlisted" },
        dedupDecision: dedup,
        extractionConfidence: 95,
        riskFlags: [],
        recentCanaryPassed: true,
        providerStatus: "stable",
        dailyRemaining: 1,
        companyRemaining: 1,
        cloneGroupRemaining: 1,
        rampPercent: 100,
        entityKey: job.id
      }).eligible
    ).toBe(true);
    expect(
      new ControlledAutoApplyEligibility().evaluate({
        score: { ...score, score: 50, decision: "rejected" },
        dedupDecision: { status: "possible_duplicate", confidence: 0.8, matchedEntities: [], actions: ["skip_apply"] },
        extractionConfidence: 80,
        riskFlags: ["salary_missing"],
        recentCanaryPassed: false,
        providerStatus: "degraded",
        dailyRemaining: 0,
        companyRemaining: 0,
        cloneGroupRemaining: 0,
        rampPercent: 0,
        entityKey: job.id
      }).checks.filter((check) => !check.passed).map((check) => check.name)
    ).toEqual(expect.arrayContaining(["score_shortlisted", "dedup_new", "recent_canary_passed", "provider_stable", "ramp_bucket"]));
    expect(new AutoApplyRampController().decide({ currentRampPercent: 10, failureRate: 0.1, duplicateCount: 0, canaryPassed: true })).toMatchObject({ rollback: true });
    expect(new AutoApplyRampController().decide({ currentRampPercent: 10, failureRate: 0, duplicateCount: 1, canaryPassed: false })).toMatchObject({
      rollback: true,
      reasons: expect.arrayContaining(["canary_failed", "duplicate_detected"])
    });
    expect(new AutoApplyRampController().decide({ currentRampPercent: 3, failureRate: 0, duplicateCount: 0, canaryPassed: true })).toMatchObject({
      rollback: false,
      nextRampPercent: 6
    });

    const policy = new PolicyEngine().check({
      action: "send_application",
      mode: "controlled_auto_apply",
      providerStatus: "stable",
      candidateProfile: profile,
      score: { ...score, score: 90, decision: "shortlisted" },
      dedupDecision: dedup,
      idempotencyKey: "apply:user:hh:1",
      proofReady: true,
      validationPassed: true,
      irreversibleActionsEnabled: true,
      rateLimitAvailable: true
    });
    expect(
      new SubmitApprovalOrchestrator().plan({
        applicationId: "app-1",
        approvalRequest: { id: "apr-1", status: "approved", draftHash: "hash-1", requestedAction: "send_application", expiresAt: "2026-05-19T00:00:00.000Z" },
        currentDraftHash: "hash-1",
        policy,
        liveSubmitEnabled: true
      }).enqueue
    ).toBe(true);
    expect(
      new SubmitApprovalOrchestrator().plan({
        applicationId: "app-1",
        approvalRequest: null,
        currentDraftHash: "hash-1",
        policy,
        liveSubmitEnabled: true
      }).reasons
    ).toContain("approval_required");

    const slotDecision = new InterviewCoordinator().evaluateSlot({ date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }, profile, new Date("2026-05-18T08:00:00+02:00"));
    expect(slotDecision.proofHash).toBeDefined();
    const utcProfile = {
      ...profile,
      availability: {
        ...profile.availability,
        timezone: "UTC",
        defaultWindows: { wednesday: ["10:00-12:00"] },
        minNoticeHours: 0
      }
    };
    const existingUtcInterview = new InterviewCoordinator().createEvent({
      jobId: job.id,
      companyId: "c",
      conversationId: "conv-utc",
      slot: { date: "2026-05-20", time: "10:00", timezone: "UTC" }
    });
    expect(
      new InterviewCoordinator().evaluateSlot(
        { date: "2026-05-20", time: "10:30", timezone: "UTC" },
        utcProfile,
        new Date("2026-05-18T00:00:00.000Z"),
        [existingUtcInterview]
      ).noCalendarConflict
    ).toBe(false);
    expect(new InterviewCoordinator().createPendingConfirmation({ jobId: job.id, companyId: "c", conversationId: "conv", slot: { date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" } })).toMatchObject({
      status: "pending_confirmation"
    });
    const schedulingPolicy = new PolicyEngine().check({
      action: "confirm_interview_slot",
      mode: "controlled_auto_apply",
      providerStatus: "stable",
      candidateProfile: profile,
      schedulingDecision: { status: "confirm_slot", selectedSlot: { date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }, alternatives: [], reasons: [], policyProof: slotDecision },
      idempotencyKey: "interview_confirm:conv:slot",
      proofReady: true,
      validationPassed: true,
      irreversibleActionsEnabled: true,
      rateLimitAvailable: true
    });
    expect(schedulingPolicy.decision).not.toBe("deny");

    expect(new ConversationLinker().link({ messageText: `${job.companyName} ${job.title}`, senderName: "Recruiter", linkedJobExternalId: null, jobs: [job] })).toMatchObject({
      reason: "company_title_similarity",
      linkedJobExternalId: job.externalId
    });
    expect(new ConversationLinker().link({ messageText: "hello", senderName: null, linkedJobExternalId: "external-1", jobs: [] })).toMatchObject({ reason: "provider_linked_job_external_id" });
    expect(new ConversationLinker().link({ messageText: "unknown", senderName: null, linkedJobExternalId: null, jobs: [job] })).toMatchObject({ reason: "conversation_external_id_only" });
    expect(new ConversationLinker().link({ messageText: `${job.companyName} ${job.title}`, senderName: null, linkedJobExternalId: null, jobs: [job, { ...job, id: "job-2", externalId: "ext-2" }] })).toMatchObject({
      reason: "ambiguous_company_title_match",
      linkedJobExternalId: null
    });
    const retention = new RetentionPolicyEngine().evaluate([
      { artifactId: "a", artifactType: "trace", createdAt: "2026-01-01T00:00:00.000Z", retentionUntil: null, legalHold: false },
      { artifactId: "b", artifactType: "audit_log", createdAt: "2026-05-18T00:00:00.000Z", retentionUntil: null, legalHold: false },
      { artifactId: "c", artifactType: "trace", createdAt: "2026-01-01T00:00:00.000Z", retentionUntil: null, legalHold: true }
    ], new Date("2026-05-18T00:00:00.000Z"));
    expect(new RetentionEnforcementPlanner().plan(retention).purgeIds).toContain("a");
    expect(new RetentionEnforcementPlanner().plan(retention).legalHoldIds).toContain("c");
    expect(new ArtifactAccessPolicy().authorize({ artifactId: "proof-1", requesterRole: "viewer", purpose: "debug", containsSensitiveData: true }).allowed).toBe(false);
    expect(new ArtifactAccessPolicy().authorize({ artifactId: "proof-1", requesterRole: "security", purpose: "audit", containsSensitiveData: true }).allowed).toBe(true);
    expect(new DependencyAuditService().summarize({ vulnerabilities: [{ severity: "critical", packageName: "x" }], licenses: [{ packageName: "y", license: "AGPL-3.0" }] })).toMatchObject({ passed: false });
    expect(new DependencyAuditService().summarize({ vulnerabilities: [{ severity: "low", packageName: "x" }], licenses: [{ packageName: "y", license: "MIT" }] })).toMatchObject({ passed: true, warnings: [] });
    expect(new HistoricalInterviewLikelihoodModel().score({ baseScore: score, providerResponseRate: 0.5, companyInterviewRate: 0.2, templateSuccessRate: 0.3 }).likelihood).toBeGreaterThan(0);
    expect(new LowQualityFeedbackModel().summarize({ rejectedSignals: ["agency", "agency", "agency"], acceptedSignals: [] }).blockSignals).toContain("agency");
    expect(new LowQualityFeedbackModel().summarize({ rejectedSignals: ["agency", "agency", "agency"], acceptedSignals: ["agency"] }).blockSignals).not.toContain("agency");
    expect(new SnippetGovernanceService().report({ snippets: [{ id: "s1", sourceProject: "x", license: "MIT", owner: "ops", copiedFiles: ["a.ts"] }], reviews: [{ snippetId: "s1", securityReview: "ok", testCoverage: "ok", modifications: "none" }] })).toMatchObject({ complete: true });
    expect(new SnippetGovernanceService().report({ snippets: [{ id: "s2", sourceProject: "x", license: "AGPL-3.0", owner: "ops", copiedFiles: ["a.ts"] }], reviews: [] })).toMatchObject({
      complete: false,
      missingReviews: ["s2"],
      licenseReviewRequired: ["s2"]
    });
  });
});
