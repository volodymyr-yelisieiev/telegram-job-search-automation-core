import { describe, expect, it } from "vitest";
import { evaluateApplicationRateLimits, evaluateReplyRateLimits } from "@job-search/db";
import { createDefaultCandidateProfile, type NormalizedJob } from "@job-search/domain";

describe("history-backed rate limits", () => {
  it("blocks application submits across global, company, and clone windows", () => {
    const profile = createDefaultCandidateProfile();
    profile.rateLimits.applicationsPerHour = 1;
    profile.rateLimits.applicationsPerDay = 1;
    profile.rateLimits.maxPerCompanyPerDay = 1;
    profile.rateLimits.maxPerCompanyPerWeek = 1;
    const existingJob = makeJob({ id: "job-1", externalId: "hh-1", companyName: "Example GmbH", title: "Senior Node.js Engineer" });
    const targetJob = makeJob({ id: "job-2", externalId: "robota-2", companyName: "Example GmbH", title: "Senior Node.js Engineer", sourceProvider: "robota" });

    const assessment = evaluateApplicationRateLimits({
      profile,
      applications: [
        {
          id: "app-1",
          jobId: existingJob.id,
          providerId: "hh",
          status: "applied",
          createdAt: "2026-05-18T08:30:00.000Z"
        }
      ],
      jobs: [existingJob, targetJob],
      job: targetJob,
      providerId: targetJob.sourceProvider,
      now: new Date("2026-05-18T09:00:00.000Z")
    });

    expect(assessment.allowed).toBe(false);
    expect(assessment.reasons).toEqual(
      expect.arrayContaining([
        "applications_per_hour_exhausted",
        "applications_per_day_exhausted",
        "company_applications_per_day_exhausted",
        "clone_group_applications_per_week_exhausted"
      ])
    );
  });

  it("blocks repeated recruiter replies for the same thread and company", () => {
    const profile = createDefaultCandidateProfile();
    profile.rateLimits.maxPerCompanyPerDay = 1;
    profile.rateLimits.maxPerCompanyPerWeek = 1;
    const assessment = evaluateReplyRateLimits({
      profile,
      conversations: [{ id: "conv-1", companyName: "Example GmbH" }],
      outboundMessages: [
        {
          id: "outbound-1",
          message: { conversationId: "conv-1" },
          status: "sent",
          createdAt: "2026-05-18T08:30:00.000Z"
        }
      ],
      conversationId: "conv-1",
      now: new Date("2026-05-18T09:00:00.000Z")
    });

    expect(assessment.allowed).toBe(false);
    expect(assessment.reasons).toEqual(
      expect.arrayContaining([
        "conversation_replies_per_day_exhausted",
        "company_replies_per_day_exhausted",
        "company_replies_per_week_exhausted"
      ])
    );
  });

  it("ignores excluded, expired, invalid, and non-counted history", () => {
    const profile = createDefaultCandidateProfile();
    profile.rateLimits.applicationsPerHour = 1;
    profile.rateLimits.applicationsPerDay = 1;
    profile.rateLimits.maxPerCompanyPerDay = 1;
    profile.rateLimits.maxPerCompanyPerWeek = 1;
    const targetJob = makeJob({ id: "job-3", externalId: "hh-3", companyName: "", title: "Backend Engineer" });
    const assessment = evaluateApplicationRateLimits({
      profile,
      applications: [
        { id: "current", jobId: targetJob.id, providerId: "hh", status: "applied", createdAt: "2026-05-18T08:30:00.000Z" },
        { id: "old", jobId: targetJob.id, providerId: "hh", status: "applied", createdAt: "2026-05-10T08:30:00.000Z" },
        { id: "blocked", jobId: targetJob.id, providerId: "hh", status: "apply_blocked_by_policy", createdAt: "2026-05-18T08:30:00.000Z" },
        { id: "bad-date", jobId: targetJob.id, providerId: "hh", status: "applied", createdAt: "not-a-date" }
      ],
      jobs: [targetJob],
      job: targetJob,
      excludeApplicationId: "current",
      now: new Date("2026-05-18T09:00:00.000Z")
    });

    expect(assessment.allowed).toBe(true);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.checks.find((check) => check.name === "company_applications_per_day")).toMatchObject({
      key: expect.stringContaining("unknown"),
      used: 0
    });
  });

  it("can count prepared application records before irreversible submit", () => {
    const profile = createDefaultCandidateProfile();
    profile.rateLimits.applicationsPerHour = 1;
    const targetJob = makeJob({ id: "job-4", externalId: "hh-4", companyName: "Prepared Inc", title: "Backend Engineer" });
    const assessment = evaluateApplicationRateLimits({
      profile,
      applications: [
        { id: "prepared", jobId: targetJob.id, providerId: "hh", status: "application_prepared", createdAt: "2026-05-18T08:30:00.000Z" }
      ],
      jobs: [targetJob],
      job: targetJob,
      includePrepared: true,
      now: new Date("2026-05-18T09:00:00.000Z")
    });

    expect(assessment.allowed).toBe(false);
    expect(assessment.reasons).toContain("applications_per_hour_exhausted");
  });

  it("ignores excluded and blocked outbound reply history", () => {
    const profile = createDefaultCandidateProfile();
    profile.rateLimits.applicationsPerHour = 1;
    const assessment = evaluateReplyRateLimits({
      profile,
      conversations: [{ id: "conv-2", companyName: null }],
      outboundMessages: [
        { id: "current", message: { conversationId: "conv-2" }, status: "sent", createdAt: "2026-05-18T08:30:00.000Z" },
        { id: "blocked", message: { conversationId: "conv-2" }, status: "blocked", createdAt: "2026-05-18T08:30:00.000Z" },
        { id: "bad-date", message: { conversationId: "conv-2" }, status: "sent", createdAt: "not-a-date" }
      ],
      conversationId: "conv-2",
      excludeOutboundMessageId: "current",
      now: new Date("2026-05-18T09:00:00.000Z")
    });

    expect(assessment.allowed).toBe(true);
    expect(assessment.checks.find((check) => check.name === "company_replies_per_day")).toMatchObject({
      key: expect.stringContaining("unknown"),
      used: 0
    });
  });
});

function makeJob(input: {
  id: string;
  externalId: string;
  companyName: string;
  title: string;
  sourceProvider?: string;
}): NormalizedJob {
  return {
    id: input.id,
    sourceProvider: input.sourceProvider ?? "hh",
    externalId: input.externalId,
    canonicalUrl: `https://example.test/${input.externalId}`,
    title: input.title,
    companyName: input.companyName,
    companyExternalId: input.companyName.toLowerCase().replace(/\s+/g, "-"),
    location: "Vienna",
    workFormat: "remote",
    compensationMin: 4000,
    compensationMax: 6500,
    compensationCurrency: "EUR",
    compensationPeriod: "month",
    seniority: "senior",
    employmentType: "full-time",
    description: `${input.title} at ${input.companyName}. TypeScript Node.js backend.`,
    requirements: ["TypeScript", "Node.js"],
    responsibilities: ["Build backend services"],
    niceToHave: [],
    language: "en",
    contactMethod: "provider",
    publicationDate: "2026-05-18T00:00:00.000Z",
    availabilityStatus: "open",
    alreadyApplied: false,
    extractionConfidence: 96,
    rawPayloadId: `raw/${input.externalId}.json`,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z"
  };
}
