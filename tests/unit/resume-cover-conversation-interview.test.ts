import { describe, expect, it } from "vitest";
import {
  ConversationEngine,
  CoverLetterEngine,
  createDefaultCandidateProfile,
  InterviewCoordinator,
  makeReplyIdempotencyKey,
  ResumeRouter
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

  it("extracts interview slots and creates an interview event inside policy boundaries", () => {
    const profile = createDefaultCandidateProfile();
    const conversation = new ConversationEngine();
    const classification = conversation.classify("Can we meet on 2026-05-20 14:00?", "Europe/Vienna");
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
  });
});
