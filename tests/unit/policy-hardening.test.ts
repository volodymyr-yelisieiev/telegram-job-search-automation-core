import { describe, expect, it } from "vitest";
import { ApplicationLifecycle, ReviewFirstSubmitGate, SubmitGuardSequence, createDefaultCandidateProfile, PolicyEngine, RateLimitService, type PolicyInput } from "@job-search/domain";

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

  it("tracks rate-limit windows", () => {
    const limits = new RateLimitService();
    const now = new Date("2026-05-18T10:00:00.000Z");

    expect(limits.consume({ key: "apply:user:hh", limit: 1, windowMs: 60_000, now })).toMatchObject({
      allowed: true,
      remaining: 0
    });
    expect(limits.check({ key: "apply:user:hh", limit: 1, windowMs: 60_000, now })).toMatchObject({
      allowed: false,
      used: 1
    });
    expect(limits.consume({ key: "apply:user:hh", limit: 1, windowMs: 60_000, now })).toMatchObject({
      allowed: false,
      used: 1
    });
    expect(limits.check({ key: "apply:user:hh", limit: 1, windowMs: 60_000, now: new Date("2026-05-18T10:02:00.000Z") })).toMatchObject({
      allowed: true,
      used: 0
    });
  });

  it("validates application lifecycle and submit guard sequence", () => {
    const lifecycle = new ApplicationLifecycle();
    expect(lifecycle.transition("application_prepared", "manual_review_required")).toMatchObject({ allowed: true });
    expect(lifecycle.transition("applied", "applying")).toMatchObject({ allowed: false });

    const policy = new PolicyEngine().check({
      ...basePolicyInput(),
      mode: "controlled_auto_apply",
      irreversibleActionsEnabled: true
    });
    expect(new SubmitGuardSequence().evaluate({
      refetchPassed: true,
      authValid: true,
      rateLimitAvailable: true,
      policy,
      dryRunPassed: true,
      dryRunState: "submit_boundary_reached",
      proofReady: true,
      idempotencyKey: "apply:1",
      recentCanaryPassed: true,
      providerStatus: "stable"
    })).toMatchObject({ passed: true });
    const failedGuard = new SubmitGuardSequence().evaluate({
      refetchPassed: false,
      authValid: false,
      rateLimitAvailable: false,
      policy,
      dryRunPassed: false,
      dryRunState: "failed",
      proofReady: true,
      idempotencyKey: null,
      recentCanaryPassed: false,
      providerStatus: "degraded"
    });
    expect(failedGuard).toMatchObject({ passed: false });
    expect(failedGuard.checks.map((check) => check.name)).toEqual([
      "refetch_passed",
      "auth_valid",
      "rate_limit_available",
      "policy_allows_submit",
      "dry_run_state_submit_boundary",
      "proof_ready",
      "idempotency_key_present",
      "recent_canary_passed",
      "provider_stable"
    ]);
    const submitGate = new ReviewFirstSubmitGate();
    expect(
      submitGate.evaluate({
        approvalRequest: null,
        currentDraftHash: "draft-1",
        policy,
        liveSubmitEnabled: true,
        now: new Date("2026-05-18T00:00:00.000Z")
      }).reasons
    ).toContain("approval_required");
    expect(
      submitGate.evaluate({
        approvalRequest: {
          status: "approved",
          draftHash: "draft-1",
          requestedAction: "send_application",
          expiresAt: "2026-05-19T00:00:00.000Z"
        },
        currentDraftHash: "changed",
        policy,
        liveSubmitEnabled: true,
        now: new Date("2026-05-18T00:00:00.000Z")
      }).reasons
    ).toContain("approval_draft_hash_mismatch");
    expect(
      submitGate.evaluate({
        approvalRequest: {
          status: "approved",
          draftHash: null,
          requestedAction: "send_application",
          expiresAt: "2026-05-19T00:00:00.000Z"
        },
        currentDraftHash: "draft-1",
        policy,
        liveSubmitEnabled: true,
        now: new Date("2026-05-18T00:00:00.000Z")
      }).reasons
    ).toContain("approval_draft_hash_missing");
    const blocked = submitGate.evaluate({
      approvalRequest: {
        status: "pending",
        draftHash: "draft-1",
        requestedAction: "send_recruiter_reply",
        expiresAt: "2026-05-17T00:00:00.000Z"
      },
      currentDraftHash: "draft-1",
      policy: { ...policy, decision: "requires_user_approval", reasons: ["review"], requiresUserApproval: true },
      liveSubmitEnabled: false,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(blocked.reasons).toEqual(
      expect.arrayContaining(["live_submit_disabled", "approval_status_pending", "approval_action_mismatch", "approval_expired", "policy_requires_user_approval"])
    );
  });
});
