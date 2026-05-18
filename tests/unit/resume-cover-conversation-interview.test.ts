import { describe, expect, it } from "vitest";
import {
  ConversationEngine,
  CoverLetterEngine,
  createDefaultCandidateProfile,
  IcsCalendarAdapter,
  InterviewCoordinator,
  InMemoryCalendarAdapter,
  makeReplyIdempotencyKey,
  OutboundDispatchService,
  PolicyEngine,
  ProfileReadinessValidator,
  ReleaseEvidenceEvaluator,
  ReleaseGateEvaluator,
  RetentionPolicyEngine,
  ReplyTemplateEngine,
  ResumeRouter,
  SchedulingDecisionEngine,
  SecretReferencePolicy,
  type ReleaseEvidenceRecord
} from "@job-search/domain";
import { createFixtureRuntime } from "@job-search/testing";

describe("resume routing, cover letters, conversations and interviews", () => {
  it("selects an active resume and validates a cover letter without unsupported facts", async () => {
    const runtime = await createFixtureRuntime();
    const profile = createDefaultCandidateProfile();
    const job = runtime.jobs.find((candidate) => candidate.externalId === "hh-1001")!;
    const route = new ResumeRouter().select(job, profile);
    const engine = new CoverLetterEngine();
    const coverLetter = engine.generate(job, profile, route);

    expect(route.resumeId).toBe("resume_backend_node_en_v4");
    expect(coverLetter.validationStatus).toBe("passed");
    expect(coverLetter.riskFlags).toEqual([]);
  });

  it("blocks outbound replies that include forbidden facts", () => {
    const profile = createDefaultCandidateProfile();
    const engine = new ConversationEngine();
    const result = engine.validateOutbound(
      {
        conversationId: "conv-1",
        inboundMessageId: "msg-1",
        category: "request_for_details",
        language: "en",
        text: "My citizenship is available on request.",
        factsUsed: ["citizenship"],
        idempotencyKey: makeReplyIdempotencyKey({
          conversationId: "conv-1",
          inboundMessageId: "msg-1",
          templateId: "citizenship"
        })
      },
      profile
    );

    expect(result.valid).toBe(false);
    expect(result.riskFlags).toContain("forbidden_fact:citizenship");
  });

  it("drafts template replies through fact validation", () => {
    const profile = createDefaultCandidateProfile();
    const classification = new ConversationEngine().classify("What salary range do you expect?", "Europe/Vienna");
    const draft = new ReplyTemplateEngine().draft({
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      classification,
      profile
    });

    expect(draft.templateId).toBe("salary_range_v1");
    expect(draft.outboundMessage?.idempotencyKey).toContain("reply:conv-1:msg-1");
    expect(draft.validation.valid).toBe(true);

    profile.facts.salary_expectation!.disclosure = "forbidden";
    expect(
      new ReplyTemplateEngine().draft({
        conversationId: "conv-1",
        inboundMessageId: "msg-2",
        classification,
        profile
      }).validation.riskFlags
    ).toContain("forbidden_fact:salary_expectation");

    expect(
      new ReplyTemplateEngine().draft({
        conversationId: "conv-1",
        inboundMessageId: "msg-3",
        classification: { ...classification, category: "test_assignment" },
        profile
      })
    ).toMatchObject({ outboundMessage: expect.objectContaining({ category: "test_assignment" }), templateId: "test_assignment_review_v1" });

    expect(
      new ReplyTemplateEngine().draft({
        conversationId: "conv-2",
        inboundMessageId: "msg-4",
        classification: new ConversationEngine().classify("Where are you located?", "Europe/Vienna"),
        profile: createDefaultCandidateProfile()
      }).outboundMessage?.text
    ).toContain("Vienna");
    expect(
      new ReplyTemplateEngine().draft({
        conversationId: "conv-2",
        inboundMessageId: "msg-5",
        classification: { ...classification, category: "request_for_notice_period" },
        profile: createDefaultCandidateProfile()
      }).templateId
    ).toBe("notice_period_v1");
    expect(
      new ReplyTemplateEngine().draft({
        conversationId: "conv-2",
        inboundMessageId: "msg-6",
        classification: new ConversationEngine().classify("Thanks, received.", "Europe/Vienna"),
        profile: createDefaultCandidateProfile()
      }).templateId
    ).toBe("acknowledgment_v1");
  });

  it("extracts interview slots and creates an interview event inside policy boundaries", () => {
    const profile = createDefaultCandidateProfile();
    const conversation = new ConversationEngine();
    const classification = conversation.classify("Can we meet on 2026-05-20 10:30?", "Europe/Vienna");
    const coordinator = new InterviewCoordinator();
    const slot = coordinator.chooseSlot(classification.proposedSlots, profile, new Date("2026-05-18T10:00:00+02:00"));

    expect(classification.category).toBe("scheduling_request");
    expect(slot).not.toBeNull();

    const event = coordinator.createEvent({
      jobId: "job-1",
      companyId: "company-1",
      conversationId: "conv-1",
      slot: slot!,
      link: "https://meet.example/interview",
      recruiterName: "Recruiter"
    });

    expect(event.status).toBe("scheduled");
    expect(event.format).toBe("video_call");

    expect(
      coordinator.chooseSlot([{ date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" }], profile, new Date("2026-05-18T10:00:00+02:00"))
    ).toBeNull();
    expect(
      coordinator.chooseSlot([{ date: "2026-05-20", time: "10:30", timezone: "UTC" }], profile, new Date("2026-05-18T10:00:00+02:00"))
    ).toBeNull();
    expect(
      coordinator.chooseSlot(
        [{ date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }],
        profile,
        new Date("2026-05-18T10:00:00+02:00"),
        [event, { ...event, interviewId: "int-2" }]
      )
    ).toBeNull();
  });

  it("uses calendar-backed scheduling decisions with conflicts and alternatives", () => {
    const profile = createDefaultCandidateProfile();
    const coordinator = new InterviewCoordinator();
    const existing = coordinator.createEvent({
      jobId: "job-1",
      companyId: "company-1",
      conversationId: "conv-1",
      slot: { date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }
    });
    const engine = new SchedulingDecisionEngine(InMemoryCalendarAdapter.fromInterviewEvents([existing], profile));

    const accepted = engine.decide({
      proposedSlots: [{ date: "2026-05-22", time: "10:30", timezone: "Europe/Vienna" }],
      profile,
      now: new Date("2026-05-18T08:00:00+02:00"),
      existingEvents: [existing]
    });
    expect(accepted).toMatchObject({ status: "confirm_slot", selectedSlot: { date: "2026-05-22", time: "10:30" } });

    const conflict = engine.decide({
      proposedSlots: [{ date: "2026-05-20", time: "10:45", timezone: "Europe/Vienna" }],
      profile,
      now: new Date("2026-05-18T08:00:00+02:00"),
      existingEvents: [existing]
    });
    expect(conflict.status).toBe("propose_alternatives");
    expect(conflict.policyProof.noCalendarConflict).toBe(false);
    expect(conflict.alternatives.length).toBeGreaterThan(0);

    const unknownTimezone = engine.decide({
      proposedSlots: [{ date: "2026-05-20", time: "10:30", timezone: "UTC" }],
      profile,
      now: new Date("2026-05-18T08:00:00+02:00"),
      existingEvents: []
    });
    expect(unknownTimezone.status).toBe("manual_review");

    expect(
      engine.decide({
        proposedSlots: [],
        profile,
        now: new Date("2026-05-18T08:00:00+02:00")
      }).status
    ).toBe("ask_clarification");

    const highNoticeProfile = createDefaultCandidateProfile();
    highNoticeProfile.availability.minNoticeHours = 72;
    expect(
      new SchedulingDecisionEngine().decide({
        proposedSlots: [{ date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }],
        profile: highNoticeProfile,
        now: new Date("2026-05-18T08:00:00+02:00")
      }).alternatives[0]?.date
    ).toBe("2026-05-21");
  });

  it("uses read-only ICS calendar exports as external busy-window evidence", () => {
    const profile = createDefaultCandidateProfile();
    const calendar = new IcsCalendarAdapter(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:external-1",
        "SUMMARY:External interview block",
        "DTSTART;TZID=Europe/Vienna:20260520T103000",
        "DTEND;TZID=Europe/Vienna:20260520T113000",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\r\n"),
      "Europe/Vienna"
    );
    const engine = new SchedulingDecisionEngine(calendar);

    const conflict = engine.decide({
      proposedSlots: [{ date: "2026-05-20", time: "10:45", timezone: "Europe/Vienna" }],
      profile,
      now: new Date("2026-05-18T08:00:00+02:00")
    });

    expect(calendar.listBusyWindows({ from: "2026-05-20T08:00:00.000Z", to: "2026-05-20T10:00:00.000Z", timezone: "Europe/Vienna" })).toEqual([
      expect.objectContaining({ id: "external-1", source: "external_calendar", title: "External interview block" })
    ]);
    expect(conflict.status).toBe("propose_alternatives");
    expect(conflict.policyProof.noCalendarConflict).toBe(false);
  });

  it("records local-safe outbound dispatch proof before any live send", () => {
    const profile = createDefaultCandidateProfile();
    profile.userConsent.autoReply = true;
    const classification = new ConversationEngine().classify("Thanks, received.", "Europe/Vienna");
    const draft = new ReplyTemplateEngine().draft({
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      classification,
      profile
    });
    expect(draft.outboundMessage).not.toBeNull();
    const policy = new PolicyEngine().check({
      action: "send_recruiter_reply",
      mode: "review_first",
      providerStatus: "stable",
      candidateProfile: profile,
      messageClassification: classification,
      outboundMessage: draft.outboundMessage!,
      idempotencyKey: draft.outboundMessage!.idempotencyKey,
      proofReady: true,
      validationPassed: draft.validation.valid,
      irreversibleActionsEnabled: false,
      rateLimitAvailable: true
    });

    const pending = new OutboundDispatchService().dispatch({
      message: draft.outboundMessage!,
      profile,
      providerId: "hh",
      accountId: "fixture-account",
      policy,
      approval: "pending"
    });
    expect(pending.status).toBe("queued_for_review");
    expect(pending.proof.textHash).not.toContain(draft.outboundMessage!.text);

    const approved = new OutboundDispatchService().dispatch({
      message: draft.outboundMessage!,
      profile,
      providerId: "hh",
      accountId: "fixture-account",
      policy,
      approval: "approved"
    });
    expect(approved.status).toBe("dry_run_recorded");
    expect(approved.deliveryId).toBeNull();

    const unsafeLive = new OutboundDispatchService().dispatch({
      message: draft.outboundMessage!,
      profile,
      providerId: "hh",
      accountId: "fixture-account",
      policy,
      approval: "approved",
      liveSendEnabled: true
    });
    expect(unsafeLive).toMatchObject({ status: "blocked", errors: expect.arrayContaining(["live_transport_required", "transport_readiness_required"]) });

    const liveReady = new OutboundDispatchService().dispatch({
      message: draft.outboundMessage!,
      profile,
      providerId: "hh",
      accountId: "fixture-account",
      policy,
      approval: "approved",
      transport: "telegram",
      transportReady: true,
      liveSendEnabled: true,
      irreversibleActionsEnabled: true
    });
    expect(liveReady).toMatchObject({ status: "sent", deliveryId: expect.any(String), proof: { transport: "telegram", status: "sent" } });

    const blocked = new OutboundDispatchService().dispatch({
      message: { ...draft.outboundMessage!, factsUsed: ["citizenship"], text: "My citizenship is available." },
      profile,
      providerId: "hh",
      accountId: "fixture-account",
      policy,
      approval: "approved"
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.errors).toContain("forbidden_fact:citizenship");

    const denied = new PolicyEngine().check({
      action: "send_recruiter_reply",
      mode: "paused",
      providerStatus: "stable",
      candidateProfile: profile,
      messageClassification: classification,
      outboundMessage: draft.outboundMessage!,
      idempotencyKey: draft.outboundMessage!.idempotencyKey,
      proofReady: true,
      validationPassed: true,
      irreversibleActionsEnabled: false,
      rateLimitAvailable: true
    });
    expect(
      new OutboundDispatchService().dispatch({
        message: draft.outboundMessage!,
        profile,
        providerId: "hh",
        accountId: "fixture-account",
        policy: denied,
        approval: "rejected"
      })
    ).toMatchObject({ status: "blocked", errors: expect.arrayContaining(["Bot mode is paused", "approval_rejected"]) });
  });

  it("evaluates retention decisions and secret references without leaking raw values", () => {
    const retention = new RetentionPolicyEngine();
    const decisions = retention.evaluate(
      [
        {
          artifactId: "prompt-1",
          artifactType: "llm_prompt",
          createdAt: "2026-04-01T00:00:00.000Z",
          retentionUntil: null,
          legalHold: false
        },
        {
          artifactId: "audit-1",
          artifactType: "audit_log",
          createdAt: "2026-04-01T00:00:00.000Z",
          retentionUntil: null,
          legalHold: true
        }
      ],
      new Date("2026-05-18T00:00:00.000Z")
    );
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactId: "prompt-1", action: "purge" }),
        expect.objectContaining({ artifactId: "audit-1", action: "legal_hold" })
      ])
    );

    const secret = new SecretReferencePolicy().validate({
      reference: {
        id: "sec-1",
        providerId: "hh",
        purpose: "provider_api",
        backend: "env",
        reference: "Bearer very-secret-token-value",
        createdAt: "2026-05-18T00:00:00.000Z",
        rotatedAt: null,
        expiresAt: "2026-01-01T00:00:00.000Z"
      },
      environment: "production",
      irreversibleActionsEnabled: true
    });
    expect(secret.valid).toBe(false);
    expect(secret.riskFlags).toEqual(
      expect.arrayContaining([
        "raw_secret_value_detected",
        "production_irreversible_actions_require_external_secret_store",
        "secret_reference_expired",
        "secret_rotation_not_recorded"
      ])
    );
    expect(secret.safeReference.reference).toMatch(/^secret-ref:/);
    expect(secret.safeReference.reference).not.toContain("Bearer");
  });

  it("aggregates live release gates without hiding external blockers", () => {
    const evidence = new ReleaseEvidenceEvaluator().summarize({
      expectedProviderIds: ["hh", "robota"],
      now: new Date("2026-05-18T00:00:00.000Z"),
      records: [
        {
          evidenceId: "cred-1",
          evidenceType: "live_credentials_configured",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-05-19T00:00:00.000Z",
          source: "vault credential check run 1",
          metadata: {
            checkedAt: "2026-05-18T00:00:00.000Z",
            secretReferenceIds: ["vault://job-search/hh/session"],
            coveredProviderIds: ["hh", "robota"],
            telegramBot: true
          }
        },
	        {
	          evidenceId: "canary-hh",
	          evidenceType: "live_canary_passed",
          providerId: "hh",
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-05-19T00:00:00.000Z",
          source: "provider canary run 1",
          metadata: {
            canaryRunId: "canary-run-hh-1",
            checkedAt: "2026-05-18T00:00:00.000Z",
            result: "passed"
          }
        },
        {
          evidenceId: "soak-short",
          evidenceType: "seven_day_soak_passed",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-06-17T00:00:00.000Z",
          source: "production soak run 1",
          metadata: { durationDays: 6.9 }
        },
        {
          evidenceId: "soak-missing-duration",
          evidenceType: "seven_day_soak_passed",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-06-17T00:00:00.000Z",
          source: "production soak run 2",
          metadata: {}
        },
        {
          evidenceId: "expired-secret",
          evidenceType: "external_secrets_backend",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-10T00:00:00.000Z",
          expiresAt: "2026-05-17T00:00:00.000Z",
          source: "vault",
          metadata: {}
        },
        {
          evidenceId: "failed-calendar",
          evidenceType: "calendar_integration_ready",
          providerId: null,
          status: "failed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: null,
          source: "calendar smoke run 1",
          metadata: {}
        }
      ]
    });
    expect(evidence).toMatchObject({
      liveCredentialsConfigured: true,
      liveCanariesPassing: false,
      sevenDaySoakPassed: false,
      invalidEvidenceIds: expect.arrayContaining(["soak-short", "soak-missing-duration"]),
      blockers: expect.arrayContaining(["missing_live_canary_evidence:robota", "missing_seven_day_soak_evidence"])
    });
    expect(evidence.blockers.some((blocker) => blocker.startsWith("invalid_release_evidence:soak-short:"))).toBe(true);

    const completeEvidence = new ReleaseEvidenceEvaluator().summarize({
      expectedProviderIds: ["hh"],
      now: new Date("2026-05-18T00:00:00.000Z"),
      records: [
        {
          evidenceId: "cred-1",
          evidenceType: "live_credentials_configured",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-05-19T00:00:00.000Z",
          source: "vault credential check run 1",
          metadata: {
            checkedAt: "2026-05-18T00:00:00.000Z",
            secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/telegram/bot"],
            coveredProviderIds: ["hh"],
            telegramBot: true
          }
        },
        {
          evidenceId: "secret-1",
          evidenceType: "external_secrets_backend",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-05-19T00:00:00.000Z",
          source: "vault access probe run 1",
          metadata: { backend: "vault", accessCheck: true, checkedAt: "2026-05-18T00:00:00.000Z" }
        },
        {
          evidenceId: "canary-hh",
          evidenceType: "live_canary_passed",
          providerId: "hh",
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-05-19T00:00:00.000Z",
          source: "provider canary run 1",
          metadata: {
            canaryRunId: "canary-run-hh-1",
            checkedAt: "2026-05-18T00:00:00.000Z",
	            result: "passed"
	          }
	        },
	        {
	          evidenceId: "provider-submit-1",
	          evidenceType: "provider_submit_proof_ready",
	          providerId: "hh",
	          status: "passed",
	          observedAt: "2026-05-18T00:00:00.000Z",
	          expiresAt: "2026-05-19T00:00:00.000Z",
	          source: "provider submit workflow run 1",
	          metadata: {
	            applicationId: "app-1",
	            proofId: "provider-proof-1",
	            action: "send_application",
	            transport: "provider",
	            idempotencyKeyHash: "hash-idempotency",
	            draftHash: "hash-draft",
	            submitStatus: "submitted",
	            submittedAt: "2026-05-18T00:00:00.000Z"
	          }
	        },
	        {
	          evidenceId: "calendar-1",
          evidenceType: "calendar_integration_ready",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-05-19T00:00:00.000Z",
          source: "calendar smoke run 1",
          metadata: {
            calendarProvider: "google-calendar",
            checkedAt: "2026-05-18T00:00:00.000Z",
            readCheck: true,
            conflictCheck: true,
            writeCheck: true
          }
        },
        {
          evidenceId: "soak-1",
          evidenceType: "seven_day_soak_passed",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-06-17T00:00:00.000Z",
          source: "production soak run 1",
          metadata: {
            startedAt: "2026-05-10T00:00:00.000Z",
            completedAt: "2026-05-18T00:00:00.000Z",
            duplicateApplicationCount: 0,
            proofCoveragePercent: 100,
            stateLossDetected: false,
            unsupportedFactCount: 0,
            incidentDrillPassed: true,
            rollbackDrillPassed: true
          }
        },
        {
          evidenceId: "dispatch-1",
          evidenceType: "outbound_dispatch_proof_ready",
          providerId: null,
          status: "passed",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2026-05-19T00:00:00.000Z",
          source: "dispatch proof run 1",
          metadata: {
            proofId: "proof-1",
            transport: "telegram",
            idempotencyKeyHash: "hash-idempotency",
            textHash: "hash-text",
            deliveryStatus: "sent",
            deliveredAt: "2026-05-18T00:00:00.000Z"
          }
        }
      ]
    });
    expect(completeEvidence.blockers).toEqual([]);

    const evidenceValidator = new ReleaseEvidenceEvaluator();
    const validationNow = new Date("2026-05-18T00:00:00.000Z");
    const baseEvidence = {
      status: "passed" as const,
      observedAt: "2026-05-18T00:00:00.000Z",
      expiresAt: "2026-05-19T00:00:00.000Z",
      source: "production validation workflow run 1",
      metadata: {}
    };
    const validate = (record: ReleaseEvidenceRecord) => evidenceValidator.validateRecord({ record, expectedProviderIds: ["hh"], now: validationNow });
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "provider-submit-invalid",
        evidenceType: "provider_submit_proof_ready",
        providerId: null,
        observedAt: "2026-05-19T00:00:00.000Z",
        expiresAt: null,
        source: "placeholder template",
        metadata: { rawPayload: { coverLetterText: "raw letter" } }
      })
    ).toEqual(
      expect.arrayContaining([
        "live_evidence_source_required",
        "observed_at_must_not_be_future",
        "provider_id_required",
        "application_id_required",
        "proof_id_required",
        "send_application_action_required",
        "provider_transport_required",
        "idempotency_key_hash_required",
        "draft_hash_required",
        "submitted_status_required",
        "submitted_at_required",
        "provider_submit_expires_at_required",
        "raw_application_payload_not_allowed"
      ])
    );
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "provider-submit-expiry",
        evidenceType: "provider_submit_proof_ready",
        providerId: "unexpected",
        expiresAt: "2026-05-18T00:00:00.000Z",
        metadata: {
          applicationId: "app-1",
          proofId: "proof-1",
          action: "send_application",
          transport: "provider",
          idempotencyKeyHash: "hash-idempotency",
          draftHash: "hash-draft",
          proofStatus: "submitted",
          submittedAt: "2026-05-18T00:00:00.000Z"
        }
      })
    ).toEqual(expect.arrayContaining(["provider_id_not_expected", "provider_submit_expires_at_must_follow_submitted_at"]));
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "provider-submit-future",
        evidenceType: "provider_submit_proof_ready",
        providerId: "hh",
        expiresAt: "2026-05-20T00:00:00.000Z",
        metadata: {
          applicationId: "app-1",
          proofId: "proof-1",
          action: "send_application",
          transport: "provider",
          idempotencyKeyHash: "hash-idempotency",
          draftHash: "hash-draft",
          submitStatus: "submitted",
          submittedAt: "2026-05-19T00:00:00.000Z"
        }
      })
    ).toContain("submitted_at_must_not_be_future");
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "credentials-future",
        evidenceType: "live_credentials_configured",
        providerId: null,
        expiresAt: "2026-05-17T00:00:00.000Z",
        metadata: {
          secretReferenceIds: ["vault://job-search/hh/session"],
          coveredProviderIds: ["hh"],
          telegramBot: true,
          checkedAt: "2026-05-19T00:00:00.000Z"
        }
      })
    ).toEqual(expect.arrayContaining(["checked_at_must_not_be_future", "credentials_expires_at_must_follow_checked_at"]));
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "secrets-future",
        evidenceType: "external_secrets_backend",
        providerId: null,
        expiresAt: "2026-05-17T00:00:00.000Z",
        metadata: { backend: "vault", accessCheck: true, checkedAt: "2026-05-19T00:00:00.000Z" }
      })
    ).toEqual(expect.arrayContaining(["checked_at_must_not_be_future", "secrets_backend_expires_at_must_follow_checked_at"]));
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "canary-future",
        evidenceType: "live_canary_passed",
        providerId: "hh",
        expiresAt: "2026-05-17T00:00:00.000Z",
        metadata: { canaryRunId: "canary-1", checkedAt: "2026-05-19T00:00:00.000Z", result: "passed" }
      })
    ).toEqual(expect.arrayContaining(["checked_at_must_not_be_future", "canary_expires_at_must_follow_checked_at"]));
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "calendar-future",
        evidenceType: "calendar_integration_ready",
        providerId: null,
        expiresAt: "2026-05-17T00:00:00.000Z",
        metadata: {
          calendarProvider: "google-calendar",
          checkedAt: "2026-05-19T00:00:00.000Z",
          readCheck: true,
          conflictCheck: true,
          writeCheck: true
        }
      })
    ).toEqual(expect.arrayContaining(["checked_at_must_not_be_future", "calendar_expires_at_must_follow_checked_at"]));
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "soak-future",
        evidenceType: "seven_day_soak_passed",
        providerId: null,
        expiresAt: "2026-05-17T00:00:00.000Z",
        metadata: {
          startedAt: "2026-05-10T00:00:00.000Z",
          completedAt: "2026-05-19T00:00:00.000Z",
          duplicateApplicationCount: 0,
          proofCoveragePercent: 100,
          stateLossDetected: false,
          unsupportedFactCount: 0,
          incidentDrillPassed: true,
          rollbackDrillPassed: true
        }
      })
    ).toEqual(expect.arrayContaining(["soak_completed_at_must_not_be_future", "soak_expires_at_must_follow_completed_at"]));
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "dispatch-future",
        evidenceType: "outbound_dispatch_proof_ready",
        providerId: null,
        expiresAt: "2026-05-17T00:00:00.000Z",
        metadata: {
          proofId: "proof-1",
          transport: "telegram",
          idempotencyKeyHash: "hash-idempotency",
          textHash: "hash-text",
          deliveryStatus: "sent",
          deliveredAt: "2026-05-19T00:00:00.000Z"
        }
      })
    ).toContain("delivered_at_must_not_be_future");
    expect(
      validate({
        ...baseEvidence,
        evidenceId: "dispatch-expiry",
        evidenceType: "outbound_dispatch_proof_ready",
        providerId: null,
        expiresAt: "2026-05-18T00:00:00.000Z",
        metadata: {
          proofId: "proof-1",
          transport: "telegram",
          idempotencyKeyHash: "hash-idempotency",
          textHash: "hash-text",
          deliveryStatus: "sent",
          deliveredAt: "2026-05-18T00:00:00.000Z"
        }
      })
    ).toContain("outbound_dispatch_expires_at_must_follow_delivered_at");

    const evaluator = new ReleaseGateEvaluator();
    expect(
      evaluator.evaluate({
        mode: "full_auto_apply",
        irreversibleActionsEnabled: false,
        providerReadiness: [{ providerId: "hh", readyForControlledAutoApply: false }],
        liveCredentialsConfigured: false,
        externalSecretsBackend: false,
        liveCanariesPassing: false,
        providerSubmitProofReady: false,
        calendarIntegrationReady: false,
        sevenDaySoakPassed: false,
        outboundDispatchProofReady: false
      })
    ).toMatchObject({
      readyForLiveAutomation: false,
      blockers: expect.arrayContaining([
        "full_auto_apply requires irreversible actions gate",
        "Providers not ready: hh",
        "Provider submit proof is not ready",
        "Dated 7-day production soak has not passed"
      ])
    });

    expect(
      evaluator.evaluate({
        mode: "controlled_auto_apply",
        irreversibleActionsEnabled: false,
        providerReadiness: [{ providerId: "hh", readyForControlledAutoApply: true }],
        liveCredentialsConfigured: true,
        externalSecretsBackend: true,
        liveCanariesPassing: true,
        providerSubmitProofReady: true,
        calendarIntegrationReady: true,
        sevenDaySoakPassed: true,
        outboundDispatchProofReady: true
      }).blockers
    ).toContain("controlled_auto_apply requires irreversible actions gate");

    expect(
      evaluator.evaluate({
        mode: "controlled_auto_apply",
        irreversibleActionsEnabled: true,
        providerReadiness: [{ providerId: "hh", readyForControlledAutoApply: true }],
        liveCredentialsConfigured: true,
        externalSecretsBackend: true,
        liveCanariesPassing: true,
        providerSubmitProofReady: true,
        calendarIntegrationReady: true,
        sevenDaySoakPassed: true,
        outboundDispatchProofReady: true
      }).readyForLiveAutomation
    ).toBe(true);
  });

  it("rejects weak live release evidence metadata before GA gates", () => {
    const base = {
      status: "passed" as const,
      observedAt: "2026-05-18T00:00:00.000Z",
      expiresAt: null,
      source: "test"
    };
    let tooDeep: unknown = "safe-value";
    for (let index = 0; index < 14; index += 1) {
      tooDeep = { next: tooDeep };
    }
    const records: ReleaseEvidenceRecord[] = [
      {
        ...base,
        evidenceId: "weak-credentials",
        evidenceType: "live_credentials_configured",
        providerId: null,
        metadata: {
          secretReferenceIds: [],
          coveredProviderIds: ["hh"],
          telegramBot: false,
          nested: tooDeep,
          leaked: "Bearer live-secret-token-value"
        }
      },
      {
        ...base,
        evidenceId: "weak-secrets",
        evidenceType: "external_secrets_backend",
        providerId: null,
        metadata: { backend: "env", accessCheck: false }
      },
      {
        ...base,
        evidenceId: "weak-canary-missing-provider",
        evidenceType: "live_canary_passed",
        providerId: null,
        metadata: {}
      },
      {
        ...base,
        evidenceId: "weak-canary-unexpected-provider",
        evidenceType: "live_canary_passed",
        providerId: "unknown",
        metadata: {
          canaryRunId: "canary-1",
          checkedAt: "2026-05-18T00:00:00.000Z",
          status: "passed"
        }
      },
      {
        ...base,
        evidenceId: "weak-calendar",
        evidenceType: "calendar_integration_ready",
        providerId: null,
        metadata: {
          calendarProvider: "",
          checkedAt: "not-a-date",
          readCheck: false,
          conflictCheck: false,
          writeCheck: false
        }
      },
      {
        ...base,
        evidenceId: "weak-soak",
        evidenceType: "seven_day_soak_passed",
        providerId: null,
        metadata: {
          durationDays: 7,
          duplicateApplicationCount: 1,
          proofCoveragePercent: 99,
          stateLossDetected: true,
          unsupportedFactCount: 1,
          incidentDrillPassed: false,
          rollbackDrillPassed: false
        }
      },
      {
        ...base,
        evidenceId: "weak-dispatch",
        evidenceType: "outbound_dispatch_proof_ready",
        providerId: null,
        metadata: {
          proofId: "",
          transport: "fixture",
          idempotencyKeyHash: "",
          textHash: "",
          deliveryStatus: "queued",
          text: "raw recruiter reply"
        }
      }
    ];

    const summary = new ReleaseEvidenceEvaluator().summarize({
      expectedProviderIds: ["hh", "robota"],
      now: new Date("2026-05-18T00:00:00.000Z"),
      records
    });

    expect(summary.acceptedEvidenceIds).toEqual([]);
    expect(summary.invalidEvidenceIds).toEqual(records.map((record) => record.evidenceId));
    expect(summary.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("invalid_release_evidence:weak-credentials:"),
        expect.stringContaining("metadata_contains_raw_secret"),
        expect.stringContaining("credential_coverage_missing:robota"),
        expect.stringContaining("approved_secret_backend_required"),
        expect.stringContaining("provider_id_required"),
        expect.stringContaining("provider_id_not_expected"),
        expect.stringContaining("calendar_provider_required"),
        expect.stringContaining("zero_duplicate_applications_required"),
        expect.stringContaining("proof_id_required"),
        expect.stringContaining("delivered_at_required"),
        expect.stringContaining("outbound_dispatch_expires_at_required"),
        "missing_live_credentials_evidence",
        "missing_external_secrets_backend_evidence",
        "missing_live_canary_evidence:hh,robota",
        "missing_provider_submit_proof_evidence",
        "missing_calendar_integration_evidence",
        "missing_seven_day_soak_evidence",
        "missing_outbound_dispatch_proof_evidence"
      ])
    );
  });

  it("reports profile readiness blockers per mode", () => {
    const profile = createDefaultCandidateProfile();
    const validator = new ProfileReadinessValidator();

    expect(validator.validate(profile, "read_only")).toMatchObject({ ready: true });
    expect(validator.validate(profile, "controlled_auto_apply")).toMatchObject({
      ready: false,
      missingFields: expect.arrayContaining(["userConsent.autoApply"])
    });

    profile.userConsent.autoApply = true;
    profile.resumes = profile.resumes.map((resume) => ({ ...resume, active: false }));
    expect(validator.validate(profile, "review_first")).toMatchObject({
      ready: false,
      missingFields: expect.arrayContaining(["resumes.active", "resumes.allowedProviders"])
    });

    const conversationProfile = createDefaultCandidateProfile();
    conversationProfile.facts = {};
    conversationProfile.compensation.discloseMode = "exact";
    conversationProfile.availability.timezone = "";
    conversationProfile.availability.defaultWindows = {};
    expect(validator.validate(conversationProfile, "conversation_only")).toMatchObject({
      ready: false,
      missingFields: expect.arrayContaining(["userConsent.autoReply", "facts", "availability"]),
      warnings: expect.arrayContaining(["Fact registry is empty", "Exact salary disclosure is enabled"])
    });

    const fullProfile = createDefaultCandidateProfile();
    fullProfile.userConsent.autoApply = true;
    fullProfile.userConsent.autoReply = true;
    expect(validator.validate(fullProfile, "full_auto_apply")).toMatchObject({
      ready: false,
      missingFields: expect.arrayContaining(["userConsent.interviewScheduling"])
    });
  });
});
