import { describe, expect, it } from "vitest";
import {
  buildDedupKey,
  canonicalizeUrl,
  ConversationEngine,
  CoverLetterEngine,
  createDefaultCandidateProfile,
  DedupEngine,
  InterviewCoordinator,
  makeInterviewConfirmIdempotencyKey,
  makeApplicationDraftVariantKey,
  makeApplicationIdempotencyKey,
  PolicyEngine,
  ResumeRouter,
  ScoringEngine,
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

    const roleExisting = cloneJob(job, { description: "different description", canonicalUrl: "https://x.example/a" });
    const roleIncoming = cloneJob(roleExisting, { id: "role-incoming", externalId: "role-incoming", canonicalUrl: "https://x.example/b" });
    expect(engine.decide(roleIncoming, [{ entityId: "role-existing", key: buildDedupKey(roleExisting) }]).actions).toContain(
      "link_to_existing_company_thread"
    );
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
      [{ date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" }],
      profile,
      new Date("2026-05-18T08:00:00+02:00")
    );
    expect(chosen).toMatchObject({ date: "2026-05-20", time: "14:00" });
  });
});
