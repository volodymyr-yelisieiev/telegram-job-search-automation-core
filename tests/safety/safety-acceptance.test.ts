import { describe, expect, it } from "vitest";
import {
  buildDedupKey,
  ConversationEngine,
  createDefaultCandidateProfile,
  DedupEngine,
  makeReplyIdempotencyKey,
  PolicyEngine
} from "@job-search/domain";
import { FingerprintEngine, type FlowFingerprint } from "@job-search/automation";
import { createFixtureRuntime } from "@job-search/testing";

describe("safety acceptance", () => {
  it("does not allow irreversible action without proof and idempotency", async () => {
    const runtime = await createFixtureRuntime();
    const output = new PolicyEngine().check({
      action: "send_application",
      mode: "controlled_auto_apply",
      providerStatus: "stable",
      candidateProfile: runtime.profile,
      score: {
        score: 90,
        interviewLikelihoodScore: 90,
        decision: "shortlisted",
        reasons: [],
        risks: [],
        hardRejections: []
      },
      dedupDecision: { status: "new", confidence: 1, matchedEntities: [], actions: ["continue"] },
      proofReady: false,
      validationPassed: true,
      irreversibleActionsEnabled: true,
      rateLimitAvailable: true
    });

    expect(output.decision).toBe("deny");
    expect(output.reasons).toContain("Irreversible action requires idempotency key");
    expect(output.reasons).toContain("Irreversible action requires proof capture readiness");
  });

  it("routes sensitive recruiter questions to manual review by disallowing auto-reply", () => {
    const profile = createDefaultCandidateProfile();
    const engine = new ConversationEngine();
    const classification = engine.classify("Can you share your citizenship and passport details?", "Europe/Vienna");
    const outboundValidation = engine.validateOutbound(
      {
        conversationId: "conv-1",
        inboundMessageId: "msg-1",
        category: "request_for_details",
        language: "en",
        text: "I can share citizenship.",
        factsUsed: ["citizenship"],
        idempotencyKey: makeReplyIdempotencyKey({
          conversationId: "conv-1",
          inboundMessageId: "msg-1",
          templateId: "sensitive"
        })
      },
      profile
    );

    expect(classification.sensitiveDataRequested).toBe(true);
    expect(classification.allowedAutoReply).toBe(false);
    expect(outboundValidation.valid).toBe(false);
  });

  it("treats CAPTCHA as a blocking condition without bypass", () => {
    const fingerprint: FlowFingerprint = {
      id: "blocked",
      urlPattern: "/vacancy/",
      titlePattern: "Backend",
      requiredDomAnchors: [],
      requiredTextAnchors: [],
      captchaIndicators: ["captcha", "are you human"]
    };
    const result = new FingerprintEngine().matches(
      {
        url: "https://hh.example/vacancy/1001",
        title: "Backend",
        text: "captcha are you human",
        domAnchors: []
      },
      fingerprint
    );

    expect(result.matched).toBe(false);
    expect(result.errorCode).toBe("captcha_required");
  });

  it("prevents duplicate application candidates before preparation", async () => {
    const runtime = await createFixtureRuntime();
    const job = runtime.jobs[0]!;
    const engine = new DedupEngine();
    const first = engine.decide(job, []);
    const second = engine.decide(job, [{ entityId: "app-1", key: buildDedupKey(job) }]);

    expect(first.status).toBe("new");
    expect(second.status).toBe("duplicate");
  });
});
