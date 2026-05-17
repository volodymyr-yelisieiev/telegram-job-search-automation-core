import { describe, expect, it } from "vitest";
import { createDefaultCandidateProfile, PolicyEngine, type PolicyInput } from "@job-search/domain";

function basePolicyInput(): PolicyInput {
  const profile = createDefaultCandidateProfile();
  return {
    action: "send_application",
    mode: "controlled_auto_apply",
    providerStatus: "stable",
    candidateProfile: {
      ...profile,
      userConsent: { ...profile.userConsent, autoApply: true, autoReply: true, interviewScheduling: true }
    },
    score: {
      score: 90,
      interviewLikelihoodScore: 88,
      decision: "shortlisted",
      reasons: [],
      risks: [],
      hardRejections: []
    },
    dedupDecision: { status: "new", confidence: 1, matchedEntities: [], actions: ["continue"] },
    idempotencyKey: "apply:user-001:hh:hh-1001",
    proofReady: true,
    validationPassed: true,
    irreversibleActionsEnabled: true,
    rateLimitAvailable: true
  };
}

describe("policy hardening matrix", () => {
  it("allows only fully valid irreversible actions", () => {
    const output = new PolicyEngine().check(basePolicyInput());
    expect(output.decision).toBe("allow");
    expect(output.requiresUserApproval).toBe(false);
  });

  it.each([
    ["missing idempotency", { idempotencyKey: undefined }],
    ["missing proof", { proofReady: false }],
    ["failed validation", { validationPassed: false }],
    ["paused mode", { mode: "paused" }],
    ["read-only provider", { providerStatus: "read_only" }],
    ["degraded provider", { providerStatus: "degraded" }],
    ["rate limit exhausted", { rateLimitAvailable: false }],
    ["duplicate job", { dedupDecision: { status: "duplicate", confidence: 1, matchedEntities: [], actions: ["skip_apply"] } }]
  ] as const)("denies %s even in review-first", (_name, patch) => {
    const input = { ...basePolicyInput(), mode: "review_first", ...patch } as PolicyInput;
    const output = new PolicyEngine().check(input);
    expect(output.decision).toBe("deny");
    expect(output.requiresUserApproval).toBe(false);
  });

  it("uses review-first only for otherwise valid drafts", () => {
    const output = new PolicyEngine().check({ ...basePolicyInput(), mode: "review_first", irreversibleActionsEnabled: false });
    expect(output.decision).toBe("requires_user_approval");
    expect(output.requiresUserApproval).toBe(true);
  });

  it("denies missing consent instead of converting it to approval", () => {
    const input = basePolicyInput();
    input.candidateProfile = {
      ...input.candidateProfile,
      userConsent: { ...input.candidateProfile.userConsent, autoApply: false }
    };

    expect(new PolicyEngine().check({ ...input, mode: "review_first" }).decision).toBe("deny");
  });

  it("denies unsafe replies and interview confirmations", () => {
    const reply = new PolicyEngine().check({
      ...basePolicyInput(),
      action: "send_recruiter_reply",
      messageClassification: {
        category: "request_for_details",
        confidence: 0.5,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: true,
        allowedAutoReply: true,
        reasons: []
      }
    });
    expect(reply.decision).toBe("deny");
    expect(reply.reasons).toContain("Sensitive data requested");

    const interview = new PolicyEngine().check({
      ...basePolicyInput(),
      action: "confirm_interview_slot",
      candidateProfile: {
        ...basePolicyInput().candidateProfile,
        userConsent: { ...basePolicyInput().candidateProfile.userConsent, interviewScheduling: false }
      }
    });
    expect(interview.decision).toBe("deny");
  });
});
