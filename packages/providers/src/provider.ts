import { randomUUID } from "node:crypto";
import {
  buildDedupKey,
  makeApplicationIdempotencyKey,
  normalizedJobSchema,
  type ApplicationDraft,
  type ApplicationResult,
  type AuthContext,
  type AuthResult,
  type DryRunResult,
  type InboundMessageDraft,
  type NormalizedJob,
  type PrepareApplicationInput,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderHealth,
  type ProviderModule,
  type ProviderSearchPlan,
  type RawJobPayload,
  type RawJobRef,
  type ReplayReport,
  type SearchProfile
} from "@job-search/domain";
import type { FixtureJob } from "./fixtures";
import { pageFingerprints, selectorPacks } from "./selector-packs";

export class FixtureProviderModule implements ProviderModule {
  constructor(
    readonly providerId: string,
    readonly capabilities: ProviderCapabilities,
    private readonly fixtures: FixtureJob[]
  ) {}

  async healthcheck(ctx: ProviderContext): Promise<ProviderHealth> {
    return {
      providerId: this.providerId,
      status: this.capabilities.autoApply ? "stable" : "read_only",
      checkedAt: ctx.now.toISOString(),
      latencyMs: 1,
      message: "fixture provider healthy"
    };
  }

  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    return {
      status: "authenticated",
      accountId: ctx.accountId,
      reason: "fixture auth state"
    };
  }

  async compileSearchPlan(profile: SearchProfile): Promise<ProviderSearchPlan> {
    const providerConfig = profile.providers[this.providerId];
    if (!providerConfig || !providerConfig.enabled) {
      return {
        providerId: this.providerId,
        searchProfileId: profile.searchProfileId,
        query: "",
        filters: {},
        maxPagesPerRun: 1,
        maxJobsPerRun: 0
      };
    }
    return {
      providerId: this.providerId,
      searchProfileId: profile.searchProfileId,
      query: providerConfig.queries[0] ?? "",
      filters: providerConfig.filters,
      maxPagesPerRun: providerConfig.maxPagesPerRun,
      maxJobsPerRun: providerConfig.maxJobsPerRun
    };
  }

  async discoverJobs(plan: ProviderSearchPlan): Promise<RawJobRef[]> {
    return this.fixtures.slice(0, plan.maxJobsPerRun).map((fixture) => fixture.ref);
  }

  async fetchJob(ref: RawJobRef): Promise<RawJobPayload> {
    const fixture = this.fixtures.find((item) => item.ref.externalId === ref.externalId);
    if (!fixture) {
      throw new Error(`Fixture job not found: ${this.providerId}:${ref.externalId}`);
    }
    return fixture.raw;
  }

  async normalizeJob(raw: RawJobPayload): Promise<NormalizedJob> {
    const payload = raw.payload;
    return normalizedJobSchema.parse({
      id: `${raw.providerId}_${raw.externalId}`,
      sourceProvider: raw.providerId,
      externalId: raw.externalId,
      canonicalUrl: raw.url,
      title: stringField(payload.title, "Untitled role"),
      companyName: nullableStringField(payload.companyName),
      companyExternalId: nullableStringField(payload.companyExternalId),
      location: nullableStringField(payload.location),
      workFormat: stringField(payload.workFormat, "unknown"),
      compensationMin: nullableNumberField(payload.compensationMin),
      compensationMax: nullableNumberField(payload.compensationMax),
      compensationCurrency: nullableStringField(payload.compensationCurrency),
      compensationPeriod: stringField(payload.compensationPeriod, "unknown"),
      seniority: nullableStringField(payload.seniority),
      employmentType: nullableStringField(payload.employmentType),
      description: stringField(payload.description, "No description"),
      requirements: stringArrayField(payload.requirements),
      responsibilities: stringArrayField(payload.responsibilities),
      niceToHave: stringArrayField(payload.niceToHave),
      language: stringField(payload.language, "en"),
      contactMethod: nullableStringField(payload.contactMethod),
      publicationDate: nullableStringField(payload.publicationDate),
      rawPayloadId: `${raw.providerId}:${raw.externalId}`,
      extractionConfidence: computeExtractionConfidence(payload),
      createdAt: raw.fetchedAt,
      updatedAt: raw.fetchedAt
    });
  }

  async deduplicateKey(job: NormalizedJob) {
    return buildDedupKey(job);
  }

  async prepareApplication(input: PrepareApplicationInput): Promise<ApplicationDraft> {
    if (!input.resumeRoute.resumeId) {
      throw new Error("Cannot prepare application without resume");
    }
    return {
      draftId: `draft_${randomUUID()}`,
      jobId: input.job.id,
      providerId: input.job.sourceProvider,
      externalJobId: input.job.externalId,
      candidateProfileId: input.profile.id,
      resumeId: input.resumeRoute.resumeId,
      coverLetterId: `cover_${input.coverLetter.jobId}_${input.coverLetter.resumeId}`,
      coverLetterText: input.coverLetter.text,
      status: "application_prepared",
      idempotencyKey: makeApplicationIdempotencyKey({
        userId: input.profile.userId,
        provider: input.job.sourceProvider,
        externalJobId: input.job.externalId
      }),
      createdAt: new Date().toISOString()
    };
  }

  async dryRunApplication(draft: ApplicationDraft): Promise<DryRunResult> {
    return {
      status: "passed",
      reachedSubmitBoundary: true,
      proofPack: {
        proofPackId: `proof_${randomUUID()}`,
        provider: this.providerId,
        accountId: "fixture-account",
        entityId: draft.jobId,
        flowId: `${this.providerId}_auto_apply_v1`,
        flowVersion: "dry-run-v1",
        selectorPackVersion: selectorPacks[this.providerId]?.version ?? "none",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        preActionScreenshotKey: `proof/${draft.jobId}/pre-submit.png`,
        postActionScreenshotKey: null,
        domSnapshotBeforeKey: `proof/${draft.jobId}/before.html`,
        domSnapshotAfterKey: null,
        confirmationText: "Dry-run stopped before submit boundary",
        confirmationUrl: null,
        finalStatus: "dry_run_passed",
        errorCode: null,
        auditEventId: null
      },
      errors: []
    };
  }

  async submitApplication(draft: ApplicationDraft): Promise<ApplicationResult> {
    return {
      status: "blocked",
      providerConfirmationId: null,
      proofPack: {
        proofPackId: `proof_${randomUUID()}`,
        provider: this.providerId,
        accountId: "fixture-account",
        entityId: draft.jobId,
        flowId: `${this.providerId}_auto_apply_v1`,
        flowVersion: "submit-disabled-v1",
        selectorPackVersion: selectorPacks[this.providerId]?.version ?? "none",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        preActionScreenshotKey: `proof/${draft.jobId}/blocked-pre-submit.png`,
        postActionScreenshotKey: null,
        domSnapshotBeforeKey: `proof/${draft.jobId}/blocked-before.html`,
        domSnapshotAfterKey: null,
        confirmationText: "Submit is disabled in local-safe fixture provider",
        confirmationUrl: null,
        finalStatus: "blocked_by_local_safe_mode",
        errorCode: "provider_terms_block",
        auditEventId: null
      },
      errors: ["provider_terms_block"]
    };
  }

  async syncInbox(accountId: string): Promise<InboundMessageDraft[]> {
    return [
      {
        providerId: this.providerId,
        accountId,
        externalMessageId: `${this.providerId}-msg-1`,
        conversationExternalId: `${this.providerId}-conv-1`,
        receivedAt: new Date().toISOString(),
        senderName: "Fixture Recruiter",
        text: "Thanks for applying. Are you available for an interview on 2026-05-20 14:00?",
        linkedJobExternalId: this.fixtures[0]?.ref.externalId ?? null
      }
    ];
  }

  async replayFlow(flowRunId: string): Promise<ReplayReport> {
    return {
      flowRunId,
      status: "replayed",
      summary: "Fixture replay loaded selector pack, page fingerprints, and stopped at submit boundary.",
      reproducedError: null,
      recommendedAction: "No action required for fixture replay"
    };
  }

  getSelectorPack() {
    return selectorPacks[this.providerId];
  }

  getPageFingerprints() {
    return pageFingerprints[this.providerId] ?? [];
  }
}

export const hhCapabilities: ProviderCapabilities = {
  jobDiscovery: true,
  jobDetailFetch: true,
  autoApply: true,
  inboxSync: true,
  recruiterReply: true,
  fileUpload: true,
  coverLetter: true,
  salaryFilter: true,
  remoteFilter: true,
  pagination: true,
  browserRequired: true,
  officialApiAvailable: "unknown",
  captchaExpected: "possible",
  deterministicFlowSupported: true
};

export const robotaCapabilities: ProviderCapabilities = {
  ...hhCapabilities,
  officialApiAvailable: false
};

export const telegramCapabilities: ProviderCapabilities = {
  jobDiscovery: true,
  jobDetailFetch: true,
  autoApply: false,
  inboxSync: false,
  recruiterReply: false,
  fileUpload: false,
  coverLetter: false,
  salaryFilter: false,
  remoteFilter: false,
  pagination: false,
  browserRequired: false,
  officialApiAvailable: false,
  captchaExpected: false,
  deterministicFlowSupported: true
};

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableStringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumberField(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function computeExtractionConfidence(payload: Record<string, unknown>): number {
  const checks: Array<[string, number]> = [
    ["title", 15],
    ["companyName", 10],
    ["description", 15],
    ["requirements", 10],
    ["location", 10],
    ["compensationMin", 5],
    ["compensationMax", 5],
    ["publicationDate", 5],
    ["workFormat", 10],
    ["language", 5],
    ["contactMethod", 10]
  ];
  return checks.reduce((score, [field, weight]) => {
    const value = payload[field];
    if (Array.isArray(value)) {
      return value.length > 0 ? score + weight : score;
    }
    if (value !== null && value !== undefined && value !== "") {
      return score + weight;
    }
    return score;
  }, 0);
}
