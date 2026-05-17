import { describe, expect, it } from "vitest";
import {
  renderApplicationCard,
  renderDigest,
  renderInterviewCard,
  renderJobCard,
  renderPipeline,
  renderProfile,
  renderStatus,
  supportedTelegramCommands
} from "@job-search/telegram-ui";
import { createDefaultCandidateProfile, type InterviewEvent, type NormalizedJob } from "@job-search/domain";

const job: NormalizedJob = {
  id: "job-1",
  sourceProvider: "hh",
  externalId: "1",
  canonicalUrl: "https://hh.example/vacancy/1",
  title: "Backend Developer",
  companyName: "Example GmbH",
  companyExternalId: null,
  location: "Remote",
  workFormat: "remote",
  compensationMin: null,
  compensationMax: null,
  compensationCurrency: null,
  compensationPeriod: "unknown",
  seniority: null,
  employmentType: null,
  description: "Node.js TypeScript backend",
  requirements: ["Node.js"],
  responsibilities: [],
  niceToHave: [],
  language: "en",
  contactMethod: null,
  publicationDate: null,
  rawPayloadId: "raw",
  extractionConfidence: 90,
  createdAt: "2026-05-16T00:00:00.000Z",
  updatedAt: "2026-05-16T00:00:00.000Z"
};

describe("telegram UI renderers", () => {
  it("renders status, pipeline, job, application, digest and profile cards", () => {
    expect(
      renderStatus({
        mode: "review_first",
        jobs: 1,
        applications: 0,
        manualReviewItems: 0,
        providerHealth: [],
        latestAuditEvents: []
      })
    ).toContain("No provider health checks yet");

    expect(renderPipeline({ discovered: 1, normalized: 1, shortlisted: 1, rejected: 0, prepared: 0, applied: 0, interviews: 0 })).toContain(
      "Shortlisted: 1"
    );
    expect(renderJobCard(job, null)).toContain("not scored");
    expect(
      renderApplicationCard({
        title: job.title,
        company: job.companyName,
        provider: "hh",
        score: 84,
        resumeId: "resume",
        status: "manual_review_required",
        proofAvailable: false
      })
    ).toContain("Proof: missing");
    expect(renderDigest({ responses: 1, manualReviewItems: 2, interviews: 0, providerIssues: ["hh"], pipelineStats: "Pipeline" })).toContain(
      "Provider issues: hh"
    );
    expect(renderProfile(createDefaultCandidateProfile())).toContain("Backend Node.js Profile");
    expect(supportedTelegramCommands).toContain("/status");
  });

  it("renders interview cards with pending fallback", () => {
    const event: InterviewEvent = {
      interviewId: "int-1",
      jobId: "job-1",
      companyId: "company-1",
      conversationId: "conv-1",
      dateTime: "2026-05-20T14:00:00",
      timezone: "Europe/Vienna",
      format: "unknown",
      link: null,
      recruiterName: null,
      status: "scheduled",
      summaryPackId: "summary-1"
    };
    expect(renderInterviewCard(event, null)).toContain("Link: pending");
    expect(renderInterviewCard(event, job)).toContain("Role: Backend Developer");
  });
});
