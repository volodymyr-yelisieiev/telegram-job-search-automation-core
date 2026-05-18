import { createHash, randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AnalyticsDimensionedFunnelReport,
  AnalyticsFunnelReport,
  CalendarBusyWindow,
  CandidateProfile,
  CoverLetter,
  DataQualityReport,
  DedupDecision,
  DedupKey,
  InterviewEvent,
  MessageClassification,
  NormalizedJob,
  OutboundMessage,
  OutboundDispatchResult,
  PolicyCheck,
  PolicyInput,
  PolicyOutput,
  ProviderReliabilityScore,
  ProfileReadinessReport,
  RateLimitDecision,
  ReleaseEvidenceRecord,
  ReleaseEvidenceSummary,
  ReleaseGateReport,
  RetentionArtifact,
  RetentionDecision,
  RetentionPolicyRule,
  ReplyDraftResult,
  ProposedSlot,
  ResumeRoute,
  ScoreResult,
  SecretReference,
  SecretValidationResult,
  SchedulingDecision,
  SubmitGuardResult,
  TemplateExperimentAssignment
} from "./types";

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-zа-яіїєґ0-9+#.\s-]/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function buildDedupKey(job: NormalizedJob): DedupKey {
  const title = normalizedText(job.title);
  const company = normalizedText(job.companyName);
  const seniority = normalizedText(job.seniority);
  const descriptionHash = stableHash(normalizedText(job.description));
  const canonicalUrlKey = canonicalizeUrl(job.canonicalUrl);
  return {
    providerJobKey: `${job.sourceProvider}:${job.externalId}`,
    canonicalUrlKey,
    contentHashKey: stableHash(`${title}:${company}:${descriptionHash}`),
    companyRoleKey: stableHash(`${company}:${title}:${seniority}`)
  };
}

export function makeApplicationIdempotencyKey(input: {
  userId: string;
  provider: string;
  externalJobId: string;
}): string {
  return `apply:${input.userId}:${input.provider}:${input.externalJobId}`;
}

export function makeApplicationDraftVariantKey(input: {
  userId: string;
  provider: string;
  externalJobId: string;
  resumeId: string;
  profileId: string;
}): string {
  return `draft:${input.userId}:${input.provider}:${input.externalJobId}:${input.resumeId}:${input.profileId}`;
}

export function makeApplicationDraftContentHash(input: {
  jobId: string;
  providerId: string;
  externalJobId: string;
  candidateProfileId: string;
  resumeId: string;
  coverLetterId: string;
  coverLetterText: string;
  idempotencyKey: string;
}): string {
  return stableHash(
    JSON.stringify({
      candidateProfileId: input.candidateProfileId,
      coverLetterId: input.coverLetterId,
      coverLetterText: input.coverLetterText,
      externalJobId: input.externalJobId,
      idempotencyKey: input.idempotencyKey,
      jobId: input.jobId,
      providerId: input.providerId,
      resumeId: input.resumeId
    })
  );
}

export function makeReplyIdempotencyKey(input: {
  conversationId: string;
  inboundMessageId: string;
  templateId: string;
}): string {
  return `reply:${input.conversationId}:${input.inboundMessageId}:${input.templateId}`;
}

export function makeInterviewConfirmIdempotencyKey(input: {
  conversationId: string;
  slotHash: string;
}): string {
  return `interview_confirm:${input.conversationId}:${input.slotHash}`;
}

export class DedupEngine {
  decide(job: NormalizedJob, existing: Array<{ entityId: string; key: DedupKey }>): DedupDecision {
    const key = buildDedupKey(job);
    const exact = existing.find((item) => item.key.providerJobKey === key.providerJobKey);
    if (exact) {
      return {
        status: "duplicate",
        confidence: 1,
        matchedEntities: [{ entityId: exact.entityId, matchType: "providerJobKey" }],
        actions: ["skip_apply"]
      };
    }

    const canonical = existing.find(
      (item) => item.key.canonicalUrlKey !== null && item.key.canonicalUrlKey === key.canonicalUrlKey
    );
    if (canonical) {
      return {
        status: "duplicate",
        confidence: 0.98,
        matchedEntities: [{ entityId: canonical.entityId, matchType: "canonicalUrlKey" }],
        actions: ["skip_apply", "link_to_existing_company_thread"]
      };
    }

    const content = existing.find((item) => item.key.contentHashKey === key.contentHashKey);
    if (content) {
      return {
        status: "possible_duplicate",
        confidence: 0.9,
        matchedEntities: [{ entityId: content.entityId, matchType: "contentHashKey" }],
        actions: ["skip_apply", "link_to_existing_company_thread"]
      };
    }

    const companyRole = existing.find((item) => item.key.companyRoleKey === key.companyRoleKey);
    if (companyRole) {
      return {
        status: "possible_duplicate",
        confidence: 0.74,
        matchedEntities: [{ entityId: companyRole.entityId, matchType: "companyRoleKey" }],
        actions: ["link_to_existing_company_thread"]
      };
    }

    return {
      status: "new",
      confidence: 1,
      matchedEntities: [],
      actions: ["continue"]
    };
  }
}

export class ScoringEngine {
  score(job: NormalizedJob, profile: CandidateProfile, strategy: ScoreWeightProfile["strategy"] = "balanced"): ScoreResult {
    const weightProfile = scoreWeightProfiles[strategy];
    const reasons: string[] = [];
    const risks: string[] = [];
    const hardRejections: string[] = [];
    const text = normalizedText(`${job.title} ${job.description} ${job.requirements.join(" ")}`);
    const title = normalizedText(job.title);
    const company = normalizedText(job.companyName);

    if (profile.blacklists.companies.some((blocked) => company.includes(normalizedText(blocked)))) {
      hardRejections.push("Company is blacklisted");
    }

    if (profile.blacklists.keywords.some((keyword) => text.includes(normalizedText(keyword)))) {
      hardRejections.push("Vacancy contains blacklisted keyword");
    }

    if (job.availabilityStatus === "closed") {
      hardRejections.push("Vacancy is closed");
    }

    if (job.alreadyApplied) {
      hardRejections.push("Vacancy is already applied");
    }

    const seniorityText = normalizedText(`${job.seniority ?? ""} ${job.title}`);
    if (/\b(junior|intern|trainee|entry level)\b/.test(seniorityText) && !profile.seniorityTargets.some((level) => /junior|intern|trainee/.test(normalizedText(level)))) {
      hardRejections.push("Seniority is below target");
    }

    const qualitySignals = new Set(job.qualitySignals ?? []);
    if (qualitySignals.has("scam_like") || qualitySignals.has("contact_only") || qualitySignals.has("agency_post")) {
      hardRejections.push("Vacancy quality signal blocks auto-apply");
    }

    if (job.compensationMin !== null && job.compensationMax !== null && job.compensationMin > job.compensationMax) {
      hardRejections.push("Compensation range is invalid");
    }

    const monthlyMaxEur = estimateMonthlyEur(job.compensationMax ?? job.compensationMin, job.compensationCurrency, job.compensationPeriod);
    if (monthlyMaxEur !== null && monthlyMaxEur < profile.compensation.minMonthlyEur) {
      hardRejections.push("Compensation is below minimum");
    }

    if (!profile.geography.allowedWorkFormats.includes(job.workFormat) && job.workFormat !== "unknown") {
      hardRejections.push("Work format is not allowed");
    }

    if (job.extractionConfidence < 70) {
      hardRejections.push("Extraction confidence is below auto-apply threshold");
    }

    let score = 0;
    if (profile.targetTitles.some((target) => titleMatchesTarget(title, target))) {
      score += weightProfile.factorWeights.title ?? 15;
      reasons.push(`Title matches target role: ${job.title}`);
    }

    const primaryMatches = profile.primaryStack.filter((skill) => text.includes(normalizedText(skill)));
    score += Math.min(20, primaryMatches.length * (weightProfile.factorWeights.primaryStack ?? 5));
    if (primaryMatches.length > 0) {
      reasons.push(`Primary stack match: ${primaryMatches.join(", ")}`);
    }

    const secondaryMatches = profile.secondaryStack.filter((skill) => text.includes(normalizedText(skill)));
    score += Math.min(8, secondaryMatches.length * (weightProfile.factorWeights.secondaryStack ?? 2));
    if (secondaryMatches.length > 0) {
      reasons.push(`Secondary stack match: ${secondaryMatches.join(", ")}`);
    }

    if (job.seniority === null || profile.seniorityTargets.some((level) => normalizedText(job.seniority).includes(normalizedText(level)))) {
      score += weightProfile.factorWeights.seniority ?? 10;
      if (job.seniority === null) {
        risks.push("Seniority is not explicit");
      } else {
        reasons.push(`Seniority fits target: ${job.seniority}`);
      }
    }

    if (profile.geography.allowedWorkFormats.includes(job.workFormat)) {
      score += weightProfile.factorWeights.workFormat ?? 10;
      reasons.push(`Work format is compatible: ${job.workFormat}`);
    } else if (job.workFormat === "unknown") {
      score += 4;
      risks.push("Work format is unknown");
    }

    if (job.location === null || normalizedText(job.location).includes("remote") || normalizedText(job.location).includes("vienna")) {
      score += weightProfile.factorWeights.location ?? 8;
    }

    if (job.compensationMin === null && job.compensationMax === null) {
      risks.push("Compensation is not specified");
    } else if (monthlyMaxEur !== null && monthlyMaxEur >= profile.compensation.minMonthlyEur) {
      score += weightProfile.factorWeights.compensation ?? 10;
      reasons.push("Compensation is within target range");
    } else if (job.compensationCurrency !== "EUR") {
      risks.push("Compensation currency is not EUR");
    }

    if (profile.languages.allowed.includes(job.language)) {
      score += weightProfile.factorWeights.language ?? 5;
      reasons.push(`Language is allowed: ${job.language}`);
    }

    score += Math.min(8, primaryMatches.length * 2);
    score += weightProfile.factorWeights.recency ?? 4;

    if (text.length < 400) {
      score -= 8;
      risks.push("Vacancy description is short");
    }

    if (qualitySignals.size > 0) {
      risks.push(`Quality signals: ${[...qualitySignals].join(", ")}`);
    }

    if (hardRejections.length > 0) {
      score = Math.min(score, 45);
    }

    const boundedScore = Math.max(0, Math.min(100, score));
    const interviewLikelihoodScore = Math.max(0, Math.min(100, boundedScore + (job.publicationDate ? 5 : 0) - risks.length * 3));
    const decision = boundedScore >= weightProfile.shortlistThreshold && hardRejections.length === 0 ? "shortlisted" : "rejected";

    if (hardRejections.length === 0 && !reasons.includes("No blacklist or duplicate detected")) {
      reasons.push("No blacklist or duplicate detected");
    }
    reasons.push(`Scoring strategy: ${weightProfile.strategy}@${weightProfile.version}`);

    return {
      score: boundedScore,
      interviewLikelihoodScore,
      decision,
      strategy: weightProfile.strategy,
      scoreProfileVersion: weightProfile.version,
      factorWeights: weightProfile.factorWeights,
      reasons: reasons.slice(0, 7),
      risks: risks.slice(0, 7),
      hardRejections
    };
  }
}

export class DataQualityService {
  evaluate(input: {
    jobs: NormalizedJob[];
    dedupDecisions: Map<string, DedupDecision>;
    scores: Map<string, ScoreResult>;
    lowConfidenceThreshold?: number;
  }): DataQualityReport {
    const lowConfidenceThreshold = input.lowConfidenceThreshold ?? 70;
    const totalConfidence = input.jobs.reduce((sum, job) => sum + job.extractionConfidence, 0);
    const providerGroups = new Map<string, NormalizedJob[]>();
    for (const job of input.jobs) {
      providerGroups.set(job.sourceProvider, [...(providerGroups.get(job.sourceProvider) ?? []), job]);
    }
    return {
      totalJobs: input.jobs.length,
      averageExtractionConfidence: input.jobs.length === 0 ? 0 : Math.round(totalConfidence / input.jobs.length),
      lowConfidenceJobIds: input.jobs.filter((job) => job.extractionConfidence < lowConfidenceThreshold).map((job) => job.id),
      duplicateLikeJobIds: [...input.dedupDecisions.entries()]
        .filter(([, decision]) => decision.status !== "new")
        .map(([jobId]) => jobId),
      shortlisted: [...input.scores.values()].filter((score) => score.decision === "shortlisted").length,
      rejected: [...input.scores.values()].filter((score) => score.decision === "rejected").length,
      providerBreakdown: Object.fromEntries(
        [...providerGroups.entries()].map(([provider, jobs]) => [
          provider,
          {
            jobs: jobs.length,
            averageExtractionConfidence: Math.round(jobs.reduce((sum, job) => sum + job.extractionConfidence, 0) / jobs.length)
          }
        ])
      )
    };
  }
}

export class AnalyticsService {
  funnel(input: {
    jobs: NormalizedJob[];
    scores: Map<string, ScoreResult>;
    applications: Array<{ status: string }>;
    responses: number;
    interviews: number;
  }): AnalyticsFunnelReport {
    const discovered = input.jobs.length;
    const shortlisted = [...input.scores.values()].filter((score) => score.decision === "shortlisted").length;
    const preparedApplications = input.applications.length;
    const applied = input.applications.filter((application) => application.status === "applied").length;
    return {
      discovered,
      shortlisted,
      preparedApplications,
      applied,
      responses: input.responses,
      interviews: input.interviews,
      shortlistRate: ratio(shortlisted, discovered),
      applyRate: ratio(applied, preparedApplications),
      interviewRate: ratio(input.interviews, applied)
    };
  }

  dimensionedFunnel(input: {
    jobs: NormalizedJob[];
    scores: Map<string, ScoreResult>;
    applications: Array<{ status: string; providerId?: string; jobId?: string; resumeId?: string; coverLetterId?: string; createdAt?: string }>;
    responses: Array<{ providerId?: string; jobId?: string; templateId?: string; createdAt?: string }>;
    interviews: Array<{ providerId?: string; jobId?: string; createdAt?: string }>;
    dimensions: Array<"provider" | "strategy" | "company" | "role" | "resume" | "template" | "time_window">;
    strategyByJobId?: Map<string, string>;
    now?: Date;
  }): AnalyticsDimensionedFunnelReport {
    const dimensions: Record<string, AnalyticsFunnelReport> = {};
    const add = (
      key: string,
      jobFilter: (job: NormalizedJob) => boolean,
      appFilter: (application: { status: string; providerId?: string; jobId?: string; resumeId?: string; coverLetterId?: string; createdAt?: string }) => boolean,
      responseFilter?: (response: { providerId?: string; jobId?: string; templateId?: string; createdAt?: string }, jobIds: Set<string>) => boolean,
      interviewFilter?: (interview: { providerId?: string; jobId?: string; createdAt?: string }, jobIds: Set<string>) => boolean
    ): void => {
      const jobs = input.jobs.filter(jobFilter);
      const jobIds = new Set(jobs.map((job) => job.id));
      const scores = new Map([...input.scores.entries()].filter(([jobId]) => jobIds.has(jobId)));
      const applications = input.applications.filter(appFilter);
      const responses = input.responses.filter((response) =>
        responseFilter ? responseFilter(response, jobIds) : response.jobId ? jobIds.has(response.jobId) : false
      );
      const interviews = input.interviews.filter((interview) =>
        interviewFilter ? interviewFilter(interview, jobIds) : interview.jobId ? jobIds.has(interview.jobId) : false
      );
      dimensions[key] = this.funnel({ jobs, scores, applications, responses: responses.length, interviews: interviews.length });
    };

    if (input.dimensions.includes("provider")) {
      for (const providerId of new Set(input.jobs.map((job) => job.sourceProvider))) {
        add(
          `provider:${providerId}`,
          (job) => job.sourceProvider === providerId,
          (application) =>
            application.providerId
              ? application.providerId === providerId
              : application.jobId
                ? input.jobs.find((job) => job.id === application.jobId)?.sourceProvider === providerId
                : false,
          (response, jobIds) => response.providerId ? response.providerId === providerId : response.jobId ? jobIds.has(response.jobId) : false,
          (interview, jobIds) => interview.providerId ? interview.providerId === providerId : interview.jobId ? jobIds.has(interview.jobId) : false
        );
      }
    }
    if (input.dimensions.includes("strategy")) {
      for (const strategy of new Set(input.strategyByJobId?.values() ?? ["balanced"])) {
        add(`strategy:${strategy}`, (job) => (input.strategyByJobId?.get(job.id) ?? "balanced") === strategy, (application) =>
          application.jobId ? (input.strategyByJobId?.get(application.jobId) ?? "balanced") === strategy : false
        );
      }
    }
    if (input.dimensions.includes("company")) {
      for (const company of new Set(input.jobs.map((job) => job.companyName ?? "unknown"))) {
        add(`company:${company}`, (job) => (job.companyName ?? "unknown") === company, (application) =>
          application.jobId ? (input.jobs.find((job) => job.id === application.jobId)?.companyName ?? "unknown") === company : false
        );
      }
    }
    if (input.dimensions.includes("role")) {
      for (const role of new Set(input.jobs.map((job) => job.title))) {
        add(`role:${role}`, (job) => job.title === role, (application) =>
          application.jobId ? input.jobs.find((job) => job.id === application.jobId)?.title === role : false
        );
      }
    }
    if (input.dimensions.includes("resume")) {
      for (const resumeId of new Set(input.applications.map((application) => application.resumeId ?? "unknown"))) {
        const resumeApplications = input.applications.filter((application) => (application.resumeId ?? "unknown") === resumeId);
        const jobIds = new Set(resumeApplications.map((application) => application.jobId).filter((jobId): jobId is string => Boolean(jobId)));
        const jobs = jobIds.size > 0 ? input.jobs.filter((job) => jobIds.has(job.id)) : [];
        const scores = new Map([...input.scores.entries()].filter(([jobId]) => jobIds.has(jobId)));
        dimensions[`resume:${resumeId}`] = this.funnel({
          jobs,
          scores,
          applications: resumeApplications,
          responses: input.responses.filter((response) => response.jobId && jobIds.has(response.jobId)).length,
          interviews: input.interviews.filter((interview) => interview.jobId && jobIds.has(interview.jobId)).length
        });
      }
    }
    if (input.dimensions.includes("template")) {
      for (const templateId of new Set(input.responses.map((response) => response.templateId ?? "unknown"))) {
        const templateResponses = input.responses.filter((response) => (response.templateId ?? "unknown") === templateId);
        const jobIds = new Set(templateResponses.map((response) => response.jobId).filter((jobId): jobId is string => Boolean(jobId)));
        const jobs = jobIds.size > 0 ? input.jobs.filter((job) => jobIds.has(job.id)) : [];
        const scores = new Map([...input.scores.entries()].filter(([jobId]) => jobIds.has(jobId)));
        dimensions[`template:${templateId}`] = this.funnel({
          jobs,
          scores,
          applications: input.applications.filter((application) => application.jobId && jobIds.has(application.jobId)),
          responses: templateResponses.length,
          interviews: input.interviews.filter((interview) => interview.jobId && jobIds.has(interview.jobId)).length
        });
      }
    }
    if (input.dimensions.includes("time_window")) {
      add("time_window:all", () => true, () => true, () => true, () => true);
      const now = input.now ?? new Date();
      const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;
      const inWindow = (value: string | undefined, fallback = false): boolean => {
        if (!value) {
          return fallback;
        }
        const timestamp = Date.parse(value);
        return !Number.isNaN(timestamp) && timestamp >= thirtyDaysAgo;
      };
      add(
        "time_window:30d",
        (job) => {
          const published = job.publicationDate ? new Date(`${job.publicationDate}T00:00:00Z`).getTime() : new Date(job.createdAt).getTime();
          return published >= thirtyDaysAgo;
        },
        (application) =>
          inWindow(application.createdAt, application.jobId ? input.jobs.some((job) => job.id === application.jobId && new Date(job.createdAt).getTime() >= thirtyDaysAgo) : false),
        (response, jobIds) => inWindow(response.createdAt, response.jobId ? jobIds.has(response.jobId) : false),
        (interview, jobIds) => inWindow(interview.createdAt, interview.jobId ? jobIds.has(interview.jobId) : false)
      );
    }
    return { dimensions };
  }

  providerReliability(input: {
    providerId: string;
    jobVolume: number;
    averageExtractionConfidence: number;
    responseRate: number;
    canaryRuns: Array<{ status: "passed" | "failed" }>;
    flowFailures: number;
    totalFlows: number;
    blockingIncidents: number;
  }): ProviderReliabilityScore {
    const canarySuccessRate = ratio(input.canaryRuns.filter((run) => run.status === "passed").length, input.canaryRuns.length);
    const failureRate = ratio(input.flowFailures, input.totalFlows);
    const automationRisk = Math.min(1, failureRate + input.blockingIncidents * 0.2 + (canarySuccessRate < 0.95 ? 0.2 : 0));
    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(input.averageExtractionConfidence * 0.35 + canarySuccessRate * 35 + input.responseRate * 15 + Math.min(input.jobVolume, 1000) / 1000 * 15 - automationRisk * 40)
      )
    );
    const reasons = [
      `canary_success_rate:${canarySuccessRate}`,
      `failure_rate:${failureRate}`,
      `automation_risk:${Number(automationRisk.toFixed(4))}`
    ];
    return {
      providerId: input.providerId,
      score,
      recommendedStatus: score >= 85 ? "stable" : score >= 65 ? "read_only" : score >= 45 ? "apply_disabled" : "needs_review",
      signals: {
        jobVolume: input.jobVolume,
        averageExtractionConfidence: input.averageExtractionConfidence,
        responseRate: input.responseRate,
        canarySuccessRate,
        failureRate,
        automationRisk: Number(automationRisk.toFixed(4))
      },
      reasons
    };
  }

  assignTemplateExperiment(input: {
    experimentId: string;
    templateId: string;
    variants: string[];
    entityKey: string;
    policyAllowed: boolean;
    validationPassed: boolean;
    unsupportedFacts: string[];
    unsafeCategory: boolean;
  }): TemplateExperimentAssignment {
    const guardrails = [
      { name: "policy_allowed", passed: input.policyAllowed, reason: input.policyAllowed ? null : "Policy did not allow template experiment" },
      { name: "validation_passed", passed: input.validationPassed, reason: input.validationPassed ? null : "Template validation failed" },
      {
        name: "no_unsupported_facts",
        passed: input.unsupportedFacts.length === 0,
        reason: input.unsupportedFacts.length === 0 ? null : `Unsupported facts: ${input.unsupportedFacts.join(", ")}`
      },
      { name: "safe_category", passed: !input.unsafeCategory, reason: input.unsafeCategory ? "Unsafe category cannot enter experiment" : null }
    ];
    const eligible = guardrails.every((guardrail) => guardrail.passed) && input.variants.length > 0;
    const variantIndex = input.variants.length === 0 ? 0 : parseInt(stableHash(`${input.experimentId}:${input.entityKey}`).slice(0, 8), 16) % input.variants.length;
    return {
      experimentId: input.experimentId,
      templateId: input.templateId,
      variantId: eligible ? input.variants[variantIndex]! : "control",
      eligible,
      guardrails
    };
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

export interface ScoreWeightProfile {
  version: string;
  strategy: "aggressive" | "balanced" | "selective";
  shortlistThreshold: number;
  lowQualityThreshold: number;
  factorWeights: Record<string, number>;
}

export const scoreWeightProfiles: Record<ScoreWeightProfile["strategy"], ScoreWeightProfile> = {
  aggressive: {
    version: "2026-05-18-v1",
    strategy: "aggressive",
    shortlistThreshold: 65,
    lowQualityThreshold: 45,
    factorWeights: { title: 15, primaryStack: 5, secondaryStack: 2, seniority: 10, workFormat: 10, location: 8, compensation: 10, language: 5, recency: 4 }
  },
  balanced: {
    version: "2026-05-18-v1",
    strategy: "balanced",
    shortlistThreshold: 72,
    lowQualityThreshold: 50,
    factorWeights: { title: 15, primaryStack: 5, secondaryStack: 2, seniority: 10, workFormat: 10, location: 8, compensation: 10, language: 5, recency: 4 }
  },
  selective: {
    version: "2026-05-18-v1",
    strategy: "selective",
    shortlistThreshold: 82,
    lowQualityThreshold: 60,
    factorWeights: { title: 12, primaryStack: 6, secondaryStack: 1, seniority: 12, workFormat: 12, location: 6, compensation: 12, language: 5, recency: 2 }
  }
};

export class ApplicationLifecycle {
  private readonly transitions: Record<string, string[]> = {
    application_prepared: ["manual_review_required", "apply_queued", "apply_blocked_by_policy", "apply_blocked_by_provider"],
    manual_review_required: ["apply_queued", "apply_blocked_by_policy", "duplicate_prevented"],
    apply_queued: ["apply_dry_run_passed", "applying", "apply_failed"],
    apply_dry_run_passed: ["applying", "manual_review_required"],
    applying: ["applied", "apply_failed"],
    applied: [],
    apply_failed: ["manual_review_required"],
    apply_blocked_by_policy: ["manual_review_required"],
    apply_blocked_by_provider: ["manual_review_required"],
    duplicate_prevented: []
  };

  canTransition(current: string, next: string): boolean {
    return this.transitions[current]?.includes(next) ?? false;
  }

  transition(current: string, next: string): { allowed: boolean; reason: string | null } {
    const allowed = this.canTransition(current, next);
    return {
      allowed,
      reason: allowed ? null : `Invalid application transition: ${current} -> ${next}`
    };
  }
}

export class SubmitGuardSequence {
  evaluate(input: {
    refetchPassed?: boolean;
    authValid?: boolean;
    rateLimitAvailable?: boolean;
    policy: PolicyOutput;
    dryRunPassed: boolean;
    dryRunState?: "not_run" | "failed" | "submit_boundary_reached";
    proofReady: boolean;
    idempotencyKey: string | null;
    recentCanaryPassed: boolean;
    providerStatus: string;
  }): SubmitGuardResult {
    const checks = [
      {
        name: "refetch_passed",
        passed: input.refetchPassed ?? true,
        reason: input.refetchPassed === false ? "Job re-fetch did not pass" : null
      },
      {
        name: "auth_valid",
        passed: input.authValid ?? true,
        reason: input.authValid === false ? "Provider auth is not valid" : null
      },
      {
        name: "rate_limit_available",
        passed: input.rateLimitAvailable ?? true,
        reason: input.rateLimitAvailable === false ? "Rate limit is not available" : null
      },
      {
        name: "policy_allows_submit",
        passed: input.policy.decision === "allow",
        reason: input.policy.decision === "allow" ? null : `Policy decision is ${input.policy.decision}`
      },
      {
        name: "dry_run_state_submit_boundary",
        passed: input.dryRunPassed && (input.dryRunState ?? "submit_boundary_reached") === "submit_boundary_reached",
        reason: input.dryRunPassed && (input.dryRunState ?? "submit_boundary_reached") === "submit_boundary_reached" ? null : "Dry-run did not reach submit boundary"
      },
      {
        name: "proof_ready",
        passed: input.proofReady,
        reason: input.proofReady ? null : "Proof capture is not ready"
      },
      {
        name: "idempotency_key_present",
        passed: Boolean(input.idempotencyKey),
        reason: input.idempotencyKey ? null : "Idempotency key is missing"
      },
      {
        name: "recent_canary_passed",
        passed: input.recentCanaryPassed,
        reason: input.recentCanaryPassed ? null : "Recent canary has not passed"
      },
      {
        name: "provider_stable",
        passed: input.providerStatus === "stable",
        reason: input.providerStatus === "stable" ? null : `Provider status is ${input.providerStatus}`
      }
    ];
    return {
      passed: checks.every((check) => check.passed),
      checks
    };
  }
}

export class ReviewFirstSubmitGate {
  evaluate(input: {
    approvalRequest: { status: string; draftHash: string | null; requestedAction: string; expiresAt: string } | null;
    currentDraftHash: string;
    policy: PolicyOutput;
    now?: Date;
    liveSubmitEnabled: boolean;
  }): { allowed: boolean; reasons: string[] } {
    const now = input.now ?? new Date();
    const reasons: string[] = [];
    if (!input.liveSubmitEnabled) {
      reasons.push("live_submit_disabled");
    }
    if (!input.approvalRequest) {
      reasons.push("approval_required");
    } else {
      if (input.approvalRequest.status !== "approved") {
        reasons.push(`approval_status_${input.approvalRequest.status}`);
      }
      if (input.approvalRequest.requestedAction !== "send_application") {
        reasons.push("approval_action_mismatch");
      }
      if (new Date(input.approvalRequest.expiresAt).getTime() <= now.getTime()) {
        reasons.push("approval_expired");
      }
      if (!input.approvalRequest.draftHash) {
        reasons.push("approval_draft_hash_missing");
      } else if (input.approvalRequest.draftHash !== input.currentDraftHash) {
        reasons.push("approval_draft_hash_mismatch");
      }
    }
    if (input.policy.decision !== "allow") {
      reasons.push(`policy_${input.policy.decision}`);
    }
    return {
      allowed: reasons.length === 0,
      reasons
    };
  }
}

export class SubmitApprovalOrchestrator {
  plan(input: {
    applicationId: string;
    approvalRequest: { id: string; status: string; draftHash: string | null; requestedAction: string; expiresAt: string } | null;
    currentDraftHash: string;
    policy: PolicyOutput;
    liveSubmitEnabled: boolean;
  }): { enqueue: boolean; queueName: "auto_apply_queue"; idempotencyKey: string; reasons: string[] } {
    const gate = new ReviewFirstSubmitGate().evaluate({
      approvalRequest: input.approvalRequest,
      currentDraftHash: input.currentDraftHash,
      policy: input.policy,
      liveSubmitEnabled: input.liveSubmitEnabled
    });
    return {
      enqueue: gate.allowed,
      queueName: "auto_apply_queue",
      idempotencyKey: `approved_submit:${input.applicationId}:${stableHash(input.currentDraftHash)}`,
      reasons: [...new Set([...gate.reasons, ...input.policy.reasons])]
    };
  }
}

export class ControlledAutoApplyEligibility {
  evaluate(input: {
    score: ScoreResult;
    dedupDecision: DedupDecision;
    extractionConfidence: number;
    riskFlags: string[];
    recentCanaryPassed: boolean;
    providerStatus: string;
    dailyRemaining: number;
    companyRemaining: number;
    cloneGroupRemaining: number;
    rampPercent: number;
    entityKey: string;
  }): { eligible: boolean; checks: Array<{ name: string; passed: boolean; reason: string | null }> } {
    const rampBucket = parseInt(stableHash(input.entityKey).slice(0, 8), 16) % 100;
    const checks = [
      { name: "score_shortlisted", passed: input.score.decision === "shortlisted" && input.score.score >= 85, reason: "Score below controlled threshold" },
      { name: "dedup_new", passed: input.dedupDecision.status === "new", reason: "Duplicate risk blocks controlled auto-apply" },
      { name: "extraction_confidence", passed: input.extractionConfidence >= 90, reason: "Extraction confidence below controlled threshold" },
      { name: "no_risk_flags", passed: input.riskFlags.length === 0, reason: `Risk flags present: ${input.riskFlags.join(", ")}` },
      { name: "recent_canary_passed", passed: input.recentCanaryPassed, reason: "Recent canary has not passed" },
      { name: "provider_stable", passed: input.providerStatus === "stable", reason: `Provider status is ${input.providerStatus}` },
      { name: "daily_rate_limit", passed: input.dailyRemaining > 0, reason: "Daily rate limit exhausted" },
      { name: "company_limit", passed: input.companyRemaining > 0, reason: "Company application limit exhausted" },
      { name: "clone_group_limit", passed: input.cloneGroupRemaining > 0, reason: "Clone group limit exhausted" },
      { name: "ramp_bucket", passed: rampBucket < input.rampPercent, reason: `Outside current ramp ${input.rampPercent}%` }
    ];
    return { eligible: checks.every((check) => check.passed), checks: checks.map((check) => ({ ...check, reason: check.passed ? null : check.reason })) };
  }
}

export class AutoApplyRampController {
  decide(input: { currentRampPercent: number; failureRate: number; duplicateCount: number; canaryPassed: boolean }): {
    nextRampPercent: number;
    rollback: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    if (!input.canaryPassed) {
      reasons.push("canary_failed");
    }
    if (input.failureRate > 0.05) {
      reasons.push("failure_rate_above_threshold");
    }
    if (input.duplicateCount > 0) {
      reasons.push("duplicate_detected");
    }
    if (reasons.length > 0) {
      return { nextRampPercent: 0, rollback: true, reasons };
    }
    return { nextRampPercent: Math.min(100, Math.max(5, input.currentRampPercent * 2)), rollback: false, reasons: ["ramp_can_increase"] };
  }
}

export class ResumeRouter {
  select(job: NormalizedJob, profile: CandidateProfile): ResumeRoute {
    const active = profile.resumes.filter((resume) => resume.active && resume.allowedProviders.includes(job.sourceProvider));
    const scored = active
      .map((resume) => {
        const languageScore = resume.language === job.language ? 0.35 : 0;
        const stackMatches = resume.targetStack.filter((skill) =>
          normalizedText(`${job.title} ${job.description}`).includes(normalizedText(skill))
        ).length;
        const stackScore = Math.min(0.45, stackMatches * 0.12);
        const seniorityScore = job.seniority === null || resume.targetSeniority.includes(job.seniority) ? 0.2 : 0;
        return {
          resume,
          confidence: Number((languageScore + stackScore + seniorityScore).toFixed(2)),
          stackMatches
        };
      })
      .sort((a, b) => b.confidence - a.confidence);

    const best = scored[0];
    if (!best) {
      return {
        resumeId: null,
        confidence: 0,
        rationale: ["No active resume is available for provider"]
      };
    }

    return {
      resumeId: best.resume.resumeId,
      confidence: best.confidence,
      rationale: [
        `Vacancy language is ${job.language}`,
        `Provider ${job.sourceProvider} is allowed for resume`,
        `${best.stackMatches} stack signals matched`,
        "Resume is active and reviewed"
      ]
    };
  }
}

export class CoverLetterEngine {
  generate(job: NormalizedJob, profile: CandidateProfile, route: ResumeRoute): CoverLetter {
    const resumeId = route.resumeId ?? "missing-resume";
    const factsUsed = ["years_of_experience", "primary_stack", "current_location"];
    const text = [
      `Hello, I am interested in the ${job.title} role.`,
      `I have ${profile.yearsOfExperience} years of backend experience with ${profile.primaryStack.slice(0, 4).join(", ")}.`,
      `I am based in ${profile.geography.currentLocation} and open to ${profile.geography.allowedWorkFormats.join(" or ")} work.`,
      "I would be glad to discuss how my background fits the team."
    ].join(" ");

    const validation = this.validate({ text, factsUsed, profile, maxLength: 1200 });
    return {
      jobId: job.id,
      resumeId,
      language: job.language,
      text,
      factsUsed,
      riskFlags: validation.riskFlags,
      validationStatus: validation.valid ? "passed" : "failed",
      modelVersion: "mock-local-v1",
      createdAt: new Date().toISOString()
    };
  }

  validate(input: {
    text: string;
    factsUsed: string[];
    profile: CandidateProfile;
    job?: NormalizedJob;
    expectedLanguage?: string;
    maxLength?: number;
  }): { valid: boolean; riskFlags: string[] } {
    const maxLength = input.maxLength ?? 1200;
    const riskFlags: string[] = [];

    if (input.text.length > maxLength) {
      riskFlags.push("cover_letter_too_long");
    }
    if (/\[[^\]]+\]|TODO|<[^>]+>/.test(input.text)) {
      riskFlags.push("cover_letter_contains_placeholder");
    }
    if (input.expectedLanguage && input.expectedLanguage !== input.profile.languages.communicationDefault && input.text.toLowerCase().includes("hello")) {
      riskFlags.push("cover_letter_language_mismatch");
    }
    if (/\b(i led|founded|managed a team|phd|fluent in)\b/i.test(input.text) && !input.factsUsed.some((fact) => /lead|management|education|language/i.test(fact))) {
      riskFlags.push("invented_claim_detected");
    }
    if (input.job?.compensationMax !== null && input.job?.compensationMax !== undefined && input.job.compensationCurrency === "EUR") {
      const monthlyMax = estimateMonthlyEur(input.job.compensationMax, input.job.compensationCurrency, input.job.compensationPeriod);
      if (monthlyMax !== null && monthlyMax < input.profile.compensation.minMonthlyEur && /salary|compensation|rate|eur/i.test(input.text)) {
        riskFlags.push("salary_policy_conflict");
      }
    }

    for (const fact of input.factsUsed) {
      const registryEntry = input.profile.facts[fact];
      if (!registryEntry && !["years_of_experience", "primary_stack"].includes(fact)) {
        riskFlags.push(`unsupported_fact:${fact}`);
      }
      if (registryEntry?.disclosure === "forbidden" || registryEntry?.disclosure === "forbidden_without_user_approval") {
        riskFlags.push(`forbidden_fact:${fact}`);
      }
    }

    return {
      valid: riskFlags.length === 0,
      riskFlags
    };
  }
}

export class PolicyEngine {
  constructor(private readonly policyVersion = "2026-05-16-v1") {}

  check(input: PolicyInput): PolicyOutput {
    const checks: PolicyCheck[] = [];
    const reasons: string[] = [];

    const push = (
      name: string,
      passed: boolean,
      severity: NonNullable<PolicyCheck["severity"]>,
      reason?: string
    ): void => {
      const check: PolicyCheck = { name, result: passed ? "passed" : "failed", severity };
      if (reason) {
        check.reason = reason;
      }
      checks.push(check);
      if (!passed && reason) {
        reasons.push(reason);
      }
    };

    push("mode_not_paused", input.mode !== "paused", "hard_deny", "Bot mode is paused");
    push("idempotency_key_present", Boolean(input.idempotencyKey), "hard_deny", "Irreversible action requires idempotency key");
    push("proof_ready", input.proofReady, "hard_deny", "Irreversible action requires proof capture readiness");
    push("validation_passed", input.validationPassed, "hard_deny", "Validation failed");
    push("provider_status_allows_write", input.providerStatus === "stable", "hard_deny", `Provider status blocks write action: ${input.providerStatus}`);
    push("rate_limit_available", input.rateLimitAvailable, "hard_deny", "Rate limit exhausted");

    if (input.action === "send_application") {
      push("auto_apply_consent", input.candidateProfile.userConsent.autoApply, "hard_deny", "User consent for auto-apply is missing");
      push("score_shortlisted", input.score?.decision === "shortlisted", "hard_deny", "Job is not shortlisted");
      push("dedup_new", input.dedupDecision?.status === "new", "hard_deny", "Duplicate or possible duplicate detected");
      if (input.mode === "read_only" || input.mode === "dry_run_apply") {
        reasons.push(`Mode ${input.mode} does not allow submit`);
        checks.push({
          name: "mode_allows_submit",
          result: "failed",
          severity: "hard_deny",
          reason: `Mode ${input.mode} does not allow submit`
        });
      }
    }

    if (input.action === "send_recruiter_reply") {
      push("auto_reply_consent", input.candidateProfile.userConsent.autoReply, "hard_deny", "User consent for auto-reply is missing");
      push(
        "classification_allows_reply",
        Boolean(input.messageClassification?.allowedAutoReply),
        "hard_deny",
        "Message category is not allowed for auto-reply"
      );
      push(
        "classification_confidence",
        (input.messageClassification?.confidence ?? 0) >= 0.82,
        "hard_deny",
        "Message classification confidence is below threshold"
      );
      if (input.messageClassification?.sensitiveDataRequested) {
        checks.push({ name: "sensitive_data_not_requested", result: "failed", severity: "hard_deny", reason: "Sensitive data requested" });
        reasons.push("Sensitive data requested");
      }
    }

    if (input.action === "confirm_interview_slot") {
      push("interview_scheduling_consent", input.candidateProfile.userConsent.interviewScheduling, "hard_deny", "Interview scheduling consent is missing");
      push("scheduling_decision_confirmed", input.schedulingDecision?.status === "confirm_slot", "hard_deny", "Scheduling decision is not confirmable");
      const proof = input.schedulingDecision?.policyProof;
      push(
        "scheduling_policy_proof_passed",
        Boolean(proof && proof.timezoneMatched && proof.minNoticeSatisfied && proof.insideAvailabilityWindow && proof.noCalendarConflict && proof.maxPerDaySatisfied),
        "hard_deny",
        "Scheduling policy proof is incomplete"
      );
    }

    if (!input.irreversibleActionsEnabled) {
      checks.push({
        name: "irreversible_actions_enabled",
        result: "warning",
        severity: "warning",
        reason: "Irreversible actions are globally disabled"
      });
    }

    const hardFailed = checks.filter((check) => check.result === "failed" && check.severity === "hard_deny");
    if (hardFailed.length > 0) {
      return {
        decision: "deny",
        action: input.action,
        policyVersion: this.policyVersion,
        checks,
        requiresUserApproval: false,
        reasons
      };
    }

    if (!input.irreversibleActionsEnabled || input.mode === "review_first") {
      return {
        decision: "requires_user_approval",
        action: input.action,
        policyVersion: this.policyVersion,
        checks,
        requiresUserApproval: true,
        reasons: ["Review-first or disabled irreversible-action mode requires user approval"]
      };
    }

    return {
      decision: "allow",
      action: input.action,
      policyVersion: this.policyVersion,
      checks,
      requiresUserApproval: false,
      reasons: []
    };
  }
}

export class RateLimitService {
  private readonly counters = new Map<string, { used: number; resetAt: number }>();

  check(input: { key: string; limit: number; windowMs: number; now?: Date }): RateLimitDecision {
    const now = input.now ?? new Date();
    const existing = this.counters.get(input.key);
    const current =
      existing && existing.resetAt > now.getTime()
        ? existing
        : {
            used: 0,
            resetAt: now.getTime() + input.windowMs
          };
    const remaining = Math.max(0, input.limit - current.used);
    return {
      key: input.key,
      allowed: remaining > 0,
      limit: input.limit,
      used: current.used,
      remaining,
      resetAt: new Date(current.resetAt).toISOString()
    };
  }

  consume(input: { key: string; limit: number; windowMs: number; now?: Date }): RateLimitDecision {
    const decision = this.check(input);
    if (!decision.allowed) {
      return decision;
    }
    const resetAt = new Date(decision.resetAt).getTime();
    const used = decision.used + 1;
    this.counters.set(input.key, { used, resetAt });
    return {
      ...decision,
      used,
      remaining: Math.max(0, input.limit - used),
      allowed: used <= input.limit
    };
  }
}

export class ProfileReadinessValidator {
  validate(profile: CandidateProfile, mode: PolicyInput["mode"]): ProfileReadinessReport {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const missingFields: string[] = [];

    const requireField = (condition: boolean, field: string, message: string): void => {
      if (!condition) {
        missingFields.push(field);
        blockers.push(message);
      }
    };

    requireField(profile.active, "active", "Profile must be active");
    requireField(profile.targetTitles.length > 0, "targetTitles", "At least one target title is required");
    requireField(profile.primaryStack.length > 0, "primaryStack", "Primary stack is required");
    requireField(Object.values(profile.rateLimits).every((value) => value > 0), "rateLimits", "Rate limits must be positive");

    if (Object.keys(profile.facts).length === 0) {
      warnings.push("Fact registry is empty");
    }

    const activeResumes = profile.resumes.filter((resume) => resume.active);
    if (["dry_run_apply", "review_first", "controlled_auto_apply", "full_auto_apply"].includes(mode)) {
      requireField(activeResumes.length > 0, "resumes.active", "Apply-capable modes require an active resume");
      requireField(
        activeResumes.some((resume) => resume.allowedProviders.length > 0),
        "resumes.allowedProviders",
        "Active resume must allow at least one provider"
      );
    }

    if (["controlled_auto_apply", "full_auto_apply"].includes(mode)) {
      requireField(profile.userConsent.autoApply, "userConsent.autoApply", "Controlled auto-apply requires explicit consent");
    }

    if (["conversation_only", "full_auto_apply"].includes(mode)) {
      requireField(profile.userConsent.autoReply, "userConsent.autoReply", "Conversation automation requires auto-reply consent");
      requireField(
        Object.values(profile.facts).some((fact) => fact.disclosure === "allowed" || fact.disclosure === "range_only"),
        "facts",
        "Conversation automation needs at least one disclosable fact"
      );
    }

    if (mode === "full_auto_apply") {
      requireField(profile.userConsent.interviewScheduling, "userConsent.interviewScheduling", "Full automation requires scheduling consent");
    }

    if (profile.compensation.discloseMode === "exact") {
      warnings.push("Exact salary disclosure is enabled");
    }
    if (profile.availability.timezone.length === 0 || Object.keys(profile.availability.defaultWindows).length === 0) {
      missingFields.push("availability");
      blockers.push("Availability timezone and windows are required for scheduling");
    }

    return {
      profileId: profile.id,
      mode,
      ready: blockers.length === 0,
      blockers,
      warnings,
      missingFields
    };
  }
}

export function canonicalizeUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|yclid$|ref$|source$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    const sortedParams = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
    url.search = "";
    for (const [key, paramValue] of sortedParams) {
      url.searchParams.append(key, paramValue);
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.hostname}${path}${url.search}`;
  } catch {
    return normalizedText(value).replace(/\/$/, "");
  }
}

function titleMatchesTarget(normalizedTitle: string, target: string): boolean {
  const tokens = normalizedText(target)
    .split(" ")
    .filter((token) => token.length >= 3 && !["developer", "engineer"].includes(token));
  if (tokens.length === 0) {
    return normalizedTitle.includes(normalizedText(target));
  }
  if (tokens.length === 1 && tokens[0] === "backend") {
    return normalizedTitle.includes("backend") && /developer|engineer/.test(normalizedTitle);
  }
  return tokens.every((token) => normalizedTitle.includes(token));
}

function estimateMonthlyEur(value: number | null, currency: string | null, period: string): number | null {
  if (value === null || currency !== "EUR") {
    return null;
  }
  if (period === "month") {
    return value;
  }
  if (period === "year") {
    return Math.round(value / 12);
  }
  if (period === "hour") {
    return Math.round(value * 160);
  }
  return null;
}

export class ConversationEngine {
  classify(text: string, timezone: string): MessageClassification {
    const normalized = normalizedText(text);
    const sensitiveDataRequested = /citizenship|passport|visa|work permit|гражданств|паспорт|віза|виза/.test(normalized);
    const proposedSlots = this.extractSlots(text, timezone);
    const deadline = this.extractDeadline(text, timezone);

    if (/test assignment|take-home|тестов/.test(normalized)) {
      return this.result("test_assignment", 0.9, 82, true, false, sensitiveDataRequested, proposedSlots, deadline, [
        "Recruiter mentions a test assignment"
      ]);
    }

    if (/salary|compensation|зарплат|вилка|rate/.test(normalized)) {
      return this.result("request_for_salary_expectation", 0.88, 70, true, true, sensitiveDataRequested, proposedSlots, deadline, [
        "Recruiter asks for salary expectation"
      ]);
    }

    if (/location|where are you|локац|находитесь/.test(normalized)) {
      return this.result("request_for_location", 0.86, 62, true, true, sensitiveDataRequested, proposedSlots, deadline, [
        "Recruiter asks for location"
      ]);
    }

    if (/interview|call|meet|zoom|google meet|созвон|интервью/.test(normalized) || proposedSlots.length > 0) {
      return this.result("scheduling_request", 0.91, 95, true, !sensitiveDataRequested, sensitiveDataRequested, proposedSlots, deadline, [
        "Recruiter discusses interview scheduling"
      ]);
    }

    if (/unfortunately|reject|not proceed|отказ|не готовы/.test(normalized)) {
      return this.result("rejection", 0.9, 20, false, false, sensitiveDataRequested, proposedSlots, deadline, ["Recruiter sent a rejection"]);
    }

    if (/thanks|thank you|received|дякую|спасибо/.test(normalized)) {
      return this.result("acknowledgment", 0.84, 35, false, true, sensitiveDataRequested, proposedSlots, deadline, ["Message is an acknowledgment"]);
    }

    return this.result("unknown", 0.5, 50, true, false, sensitiveDataRequested, proposedSlots, deadline, ["No safe category matched"]);
  }

  validateOutbound(message: OutboundMessage, profile: CandidateProfile): { valid: boolean; riskFlags: string[] } {
    const riskFlags: string[] = [];
    for (const fact of message.factsUsed) {
      const registryEntry = profile.facts[fact];
      if (!registryEntry) {
        riskFlags.push(`unsupported_fact:${fact}`);
        continue;
      }
      if (registryEntry.disclosure === "forbidden" || registryEntry.disclosure === "forbidden_without_user_approval") {
        riskFlags.push(`forbidden_fact:${fact}`);
      }
    }
    if (message.text.length > 1200) {
      riskFlags.push("reply_too_long");
    }
    if (/citizenship|passport|visa/i.test(message.text)) {
      riskFlags.push("sensitive_fact_detected");
    }
    return {
      valid: riskFlags.length === 0,
      riskFlags
    };
  }

  private result(
    category: MessageClassification["category"],
    confidence: number,
    priorityScore: number,
    requiresReply: boolean,
    allowedAutoReply: boolean,
    sensitiveDataRequested: boolean,
    proposedSlots: ProposedSlot[],
    deadline: string | null,
    reasons: string[]
  ): MessageClassification {
    return {
      category,
      confidence,
      priorityScore,
      requiresReply,
      deadline,
      containsInterviewLink: false,
      proposedSlots,
      sensitiveDataRequested,
      allowedAutoReply: allowedAutoReply && !sensitiveDataRequested,
      reasons
    };
  }

  private extractSlots(text: string, timezone: string): ProposedSlot[] {
    const matches = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s*(?:for|duration)?\s*(\d{2,3})\s*(?:min|minutes))?\b/gi)];
    return matches.map((match) => ({
      date: match[1] ?? "1970-01-01",
      time: match[2] ?? "00:00",
      timezone,
      durationMinutes: match[3] ? Number(match[3]) : 60,
      confidence: 0.92,
      sourceText: match[0]
    }));
  }

  private extractDeadline(text: string, timezone: string): string | null {
    const match = text.match(/\bby\s+(20\d{2}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\b/i);
    if (!match) {
      return null;
    }
    return `${match[1]}T${match[2] ?? "17:00"}:00[${timezone}]`;
  }
}

export class ReplyTemplateEngine {
  draft(input: {
    conversationId: string;
    inboundMessageId: string;
    classification: MessageClassification;
    profile: CandidateProfile;
    language?: string;
  }): ReplyDraftResult {
    const template = this.selectTemplate(input.classification.category);
    if (!template) {
      return {
        outboundMessage: null,
        validation: { valid: false, riskFlags: ["unsupported_reply_category"] },
        templateId: null,
        reason: `Unsupported reply category: ${input.classification.category}`
      };
    }
    const rendered = template.render(input.profile);
    const outboundMessage: OutboundMessage = {
      conversationId: input.conversationId,
      inboundMessageId: input.inboundMessageId,
      category: input.classification.category,
      language: input.language ?? input.profile.languages.communicationDefault,
      text: rendered.text,
      factsUsed: rendered.factsUsed,
      idempotencyKey: makeReplyIdempotencyKey({
        conversationId: input.conversationId,
        inboundMessageId: input.inboundMessageId,
        templateId: template.id
      })
    };
    const validation = new ConversationEngine().validateOutbound(outboundMessage, input.profile);
    return {
      outboundMessage,
      validation,
      templateId: template.id,
      reason: validation.valid ? null : "Reply validation failed"
    };
  }

  private selectTemplate(category: MessageClassification["category"]):
    | {
        id: string;
        render(profile: CandidateProfile): { text: string; factsUsed: string[] };
      }
    | null {
    const templates: Partial<
      Record<
        MessageClassification["category"],
        {
          id: string;
          render(profile: CandidateProfile): { text: string; factsUsed: string[] };
        }
      >
    > = {
      request_for_salary_expectation: {
        id: "salary_range_v1",
        render(profile) {
          const salary = profile.facts.salary_expectation?.value as { min?: number; max?: number; currency?: string; period?: string } | undefined;
          return {
            text: `My expected range is ${salary?.min ?? profile.compensation.minMonthlyEur}-${salary?.max ?? profile.compensation.targetMonthlyEur} ${salary?.currency ?? "EUR"} per ${salary?.period ?? "month"}.`,
            factsUsed: ["salary_expectation"]
          };
        }
      },
      request_for_location: {
        id: "location_v1",
        render(profile) {
          return {
            text: `I am based in ${profile.geography.currentLocation} and open to ${profile.geography.allowedWorkFormats.join(" or ")} work.`,
            factsUsed: ["current_location"]
          };
        }
      },
      request_for_notice_period: {
        id: "notice_period_v1",
        render(profile) {
          return {
            text: `My current notice period is ${String(profile.facts.notice_period?.value ?? "available on request")}.`,
            factsUsed: ["notice_period"]
          };
        }
      },
      acknowledgment: {
        id: "acknowledgment_v1",
        render() {
          return {
            text: "Thank you for the update.",
            factsUsed: []
          };
        }
      },
      request_for_details: {
        id: "details_request_v1",
        render(profile) {
          return {
            text: `Could you please share the role details, interview process and expected next steps? My core stack is ${profile.primaryStack.slice(0, 3).join(", ")}.`,
            factsUsed: ["primary_stack"]
          };
        }
      },
      clarifying_question: {
        id: "clarifying_question_v1",
        render() {
          return {
            text: "Thanks. Could you clarify the main responsibilities, team setup and expected timeline?",
            factsUsed: []
          };
        }
      },
      recruiter_outreach: {
        id: "recruiter_outreach_interest_v1",
        render(profile) {
          return {
            text: `Thanks for reaching out. I am open to backend roles using ${profile.primaryStack.slice(0, 3).join(", ")} and would be happy to review the details.`,
            factsUsed: ["primary_stack"]
          };
        }
      },
      scheduling_request: {
        id: "scheduling_policy_safe_v1",
        render() {
          return {
            text: "Thanks. I can review the proposed time and confirm once it fits my availability window.",
            factsUsed: []
          };
        }
      },
      test_assignment: {
        id: "test_assignment_review_v1",
        render() {
          return {
            text: "Thanks for sharing. I will review the assignment scope and timeline before confirming.",
            factsUsed: []
          };
        }
      }
    };
    return templates[category] ?? null;
  }
}

export class ReplyAdaptationService {
  adapt(input: { baseText: string; tone: "concise" | "warm" | "formal"; maxLength?: number }): { text: string; modelVersion: string; promptVersion: string } {
    const prefix = input.tone === "warm" ? "Thanks for the context. " : input.tone === "formal" ? "Thank you for your message. " : "";
    const text = `${prefix}${input.baseText}`.slice(0, input.maxLength ?? 1200);
    return { text, modelVersion: "local-reply-adapter-v1", promptVersion: "reply-adapt-2026-05-18" };
  }
}

export class ThreadContradictionChecker {
  check(input: { draft: OutboundMessage; previousMessages: Array<{ text: string }> }): { valid: boolean; riskFlags: string[] } {
    const previous = normalizedText(input.previousMessages.map((message) => message.text).join(" "));
    const current = normalizedText(input.draft.text);
    const riskFlags: string[] = [];
    if (previous.includes("not available") && /available|can attend|confirm/i.test(input.draft.text)) {
      riskFlags.push("contradicts_previous_unavailability");
    }
    if (previous.includes("salary") && current.includes("salary") && input.draft.factsUsed.length === 0) {
      riskFlags.push("salary_reply_without_fact");
    }
    return { valid: riskFlags.length === 0, riskFlags };
  }
}

export class FollowUpScheduler {
  plan(input: {
    conversationId: string;
    lastInboundAt: string;
    category: MessageClassification["category"];
    alreadyScheduledCount: number;
    maxFollowUps?: number;
    recruiterRepliedAfterLastFollowUp?: boolean;
    threadClosed?: boolean;
    companyScheduledCount?: number;
    companyMaxFollowUps?: number;
  }): { shouldSchedule: boolean; scheduledAt: string | null; reason: string } {
    const maxFollowUps = input.maxFollowUps ?? 2;
    if (input.threadClosed) {
      return { shouldSchedule: false, scheduledAt: null, reason: "thread_closed" };
    }
    if (input.recruiterRepliedAfterLastFollowUp) {
      return { shouldSchedule: false, scheduledAt: null, reason: "recruiter_replied_after_last_follow_up" };
    }
    if ((input.companyScheduledCount ?? 0) >= (input.companyMaxFollowUps ?? 5)) {
      return { shouldSchedule: false, scheduledAt: null, reason: "company_follow_up_cap_reached" };
    }
    if (input.alreadyScheduledCount >= maxFollowUps) {
      return { shouldSchedule: false, scheduledAt: null, reason: "follow_up_cap_reached" };
    }
    if (["rejection", "spam_irrelevant", "unknown"].includes(input.category)) {
      return { shouldSchedule: false, scheduledAt: null, reason: "category_not_follow_up_eligible" };
    }
    return {
      shouldSchedule: true,
      scheduledAt: addDays(input.lastInboundAt, 3),
      reason: `follow_up:${input.conversationId}:${input.category}`
    };
  }
}

export class ResponsePriorityService {
  rank(classifications: Array<{ inboundMessageId: string; classification: MessageClassification; receivedAt?: string }>): Array<{
    inboundMessageId: string;
    priorityScore: number;
    bucket: "urgent" | "needs_reply" | "fyi";
    reasons: string[];
  }> {
    return classifications
      .map((item) => {
        const score = item.classification.priorityScore ?? this.score(item.classification);
        return {
          inboundMessageId: item.inboundMessageId,
          priorityScore: score,
          bucket: score >= 85 ? "urgent" as const : item.classification.requiresReply ? "needs_reply" as const : "fyi" as const,
          reasons: item.classification.reasons
        };
      })
      .sort((left, right) => right.priorityScore - left.priorityScore);
  }

  private score(classification: MessageClassification): number {
    const base = classification.requiresReply ? 55 : 20;
    const slotBoost = classification.proposedSlots.length > 0 ? 25 : 0;
    const deadlineBoost = classification.deadline ? 15 : 0;
    const sensitivePenalty = classification.sensitiveDataRequested ? -20 : 0;
    return Math.max(0, Math.min(100, Math.round(base + classification.confidence * 20 + slotBoost + deadlineBoost + sensitivePenalty)));
  }
}

export class ClassificationEvalService {
  report(fixtures: Array<{ text: string; expectedCategory: MessageClassification["category"]; timezone?: string }>): {
    total: number;
    accuracy: number;
    confusionMatrix: Record<string, Record<string, number>>;
    failures: Array<{ text: string; expected: string; actual: string }>;
  } {
    const engine = new ConversationEngine();
    const matrix: Record<string, Record<string, number>> = {};
    const failures: Array<{ text: string; expected: string; actual: string }> = [];
    for (const fixture of fixtures) {
      const actual = engine.classify(fixture.text, fixture.timezone ?? "Europe/Vienna").category;
      matrix[fixture.expectedCategory] = matrix[fixture.expectedCategory] ?? {};
      matrix[fixture.expectedCategory]![actual] = (matrix[fixture.expectedCategory]![actual] ?? 0) + 1;
      if (actual !== fixture.expectedCategory) {
        failures.push({ text: fixture.text, expected: fixture.expectedCategory, actual });
      }
    }
    return {
      total: fixtures.length,
      accuracy: fixtures.length === 0 ? 1 : Number(((fixtures.length - failures.length) / fixtures.length).toFixed(4)),
      confusionMatrix: matrix,
      failures
    };
  }
}

export class ConversationLinker {
  link(input: {
    messageText: string;
    senderName: string | null;
    linkedJobExternalId: string | null;
    jobs: NormalizedJob[];
  }): { linkedJobExternalId: string | null; confidence: number; reason: string; ambiguousCandidates: string[] } {
    if (input.linkedJobExternalId) {
      return { linkedJobExternalId: input.linkedJobExternalId, confidence: 0.98, reason: "provider_linked_job_external_id", ambiguousCandidates: [] };
    }
    const text = normalizedText(`${input.senderName ?? ""} ${input.messageText}`);
    const candidates = input.jobs
      .map((job) => ({
        job,
        score: (job.companyName && text.includes(normalizedText(job.companyName)) ? 0.45 : 0) + (text.includes(normalizedText(job.title)) ? 0.45 : 0)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (candidates.length === 0) {
      return { linkedJobExternalId: null, confidence: 0.3, reason: "conversation_external_id_only", ambiguousCandidates: [] };
    }
    if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) {
      return {
        linkedJobExternalId: null,
        confidence: candidates[0]!.score,
        reason: "ambiguous_company_title_match",
        ambiguousCandidates: candidates.slice(0, 3).map((candidate) => candidate.job.externalId)
      };
    }
    return {
      linkedJobExternalId: candidates[0]!.job.externalId,
      confidence: Number(candidates[0]!.score.toFixed(2)),
      reason: "company_title_similarity",
      ambiguousCandidates: []
    };
  }
}

export interface CalendarAdapter {
  listBusyWindows(input: { from: string; to: string; timezone: string }): CalendarBusyWindow[];
}

export class InMemoryCalendarAdapter implements CalendarAdapter {
  private readonly windows: CalendarBusyWindow[];

  constructor(windows: CalendarBusyWindow[] = []) {
    this.windows = windows;
  }

  static fromInterviewEvents(events: InterviewEvent[], profile: CandidateProfile): InMemoryCalendarAdapter {
    const windows: CalendarBusyWindow[] = [
      ...events.map((event) => {
        const start = new Date(interviewEventStartMs(event));
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        return {
          id: event.interviewId,
          source: "interview_events" as const,
          start: start.toISOString(),
          end: end.toISOString(),
          timezone: event.timezone,
          title: event.recruiterName ?? event.companyId
        };
      }),
      ...(Object.entries(profile.availability.defaultWindows).length === 0
        ? [
            {
              id: "availability:missing",
              source: "manual_block" as const,
              start: new Date(0).toISOString(),
              end: "9999-12-31T23:59:59.999Z",
              timezone: profile.availability.timezone || "UTC",
              title: "Availability is not configured"
            }
          ]
        : [])
    ];
    return new InMemoryCalendarAdapter(windows);
  }

  listBusyWindows(input: { from: string; to: string; timezone: string }): CalendarBusyWindow[] {
    const from = new Date(input.from).getTime();
    const to = new Date(input.to).getTime();
    return this.windows.filter((window) => {
      if (window.timezone !== input.timezone) {
        return false;
      }
      return rangesOverlap(new Date(window.start).getTime(), new Date(window.end).getTime(), from, to);
    });
  }
}

export class IcsCalendarAdapter implements CalendarAdapter {
  private readonly windows: CalendarBusyWindow[];

  constructor(contents: string, fallbackTimezone = "UTC") {
    this.windows = parseIcsBusyWindows(contents, fallbackTimezone);
  }

  listBusyWindows(input: { from: string; to: string; timezone: string }): CalendarBusyWindow[] {
    const from = new Date(input.from).getTime();
    const to = new Date(input.to).getTime();
    return this.windows.filter((window) => {
      if (window.timezone !== input.timezone) {
        return false;
      }
      return rangesOverlap(new Date(window.start).getTime(), new Date(window.end).getTime(), from, to);
    });
  }
}

export class SchedulingDecisionEngine {
  constructor(private readonly calendar: CalendarAdapter = new InMemoryCalendarAdapter()) {}

  decide(input: {
    proposedSlots: ProposedSlot[];
    profile: CandidateProfile;
    now?: Date;
    existingEvents?: InterviewEvent[];
  }): SchedulingDecision {
    const now = input.now ?? new Date();
    if (input.proposedSlots.length === 0) {
      return {
        status: "ask_clarification",
        selectedSlot: null,
        alternatives: this.proposeAlternatives(input.profile, now, input.existingEvents ?? []),
        reasons: ["No concrete slot was detected"],
        policyProof: {
          timezoneMatched: false,
          minNoticeSatisfied: false,
          insideAvailabilityWindow: false,
          noCalendarConflict: false,
          maxPerDaySatisfied: false
        }
      };
    }

    const coordinator = new InterviewCoordinator(this.calendar);
    const selected = coordinator.chooseSlot(input.proposedSlots, input.profile, now, input.existingEvents ?? []);
    if (selected) {
      return {
        status: "confirm_slot",
        selectedSlot: selected,
        alternatives: [],
        reasons: ["Proposed slot fits timezone, notice, availability and calendar conflicts"],
        policyProof: coordinator.evaluateSlot(selected, input.profile, now, input.existingEvents ?? [])
      };
    }

    const proofs = input.proposedSlots.map((slot) => coordinator.evaluateSlot(slot, input.profile, now, input.existingEvents ?? []));
    const unknownTimezone = proofs.every((proof) => !proof.timezoneMatched);
    const alternatives = this.proposeAlternatives(input.profile, now, input.existingEvents ?? []);
    return {
      status: unknownTimezone ? "manual_review" : alternatives.length > 0 ? "propose_alternatives" : "ask_clarification",
      selectedSlot: null,
      alternatives,
      reasons: unknownTimezone
        ? ["Proposed slots use an unknown timezone"]
        : ["Proposed slots do not satisfy scheduling policy"],
      policyProof: proofs[0] ?? {
        timezoneMatched: false,
        minNoticeSatisfied: false,
        insideAvailabilityWindow: false,
        noCalendarConflict: false,
        maxPerDaySatisfied: false
      }
    };
  }

  private proposeAlternatives(profile: CandidateProfile, now: Date, existingEvents: InterviewEvent[]): ProposedSlot[] {
    const coordinator = new InterviewCoordinator(this.calendar);
    const minTime = now.getTime() + profile.availability.minNoticeHours * 60 * 60 * 1000;
    const alternatives: ProposedSlot[] = [];
    for (let dayOffset = 1; dayOffset <= 14 && alternatives.length < 3; dayOffset += 1) {
      const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      if (date.getTime() < minTime) {
        continue;
      }
      const dateKey = date.toISOString().slice(0, 10);
      const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: profile.availability.timezone })
        .format(date)
        .toLowerCase();
      for (const window of profile.availability.defaultWindows[dayName] ?? []) {
        const [time = ""] = window.split("-");
        const slot = { date: dateKey, time, timezone: profile.availability.timezone };
        const proof = coordinator.evaluateSlot(slot, profile, now, existingEvents);
        if (Object.values(proof).every(Boolean)) {
          alternatives.push(slot);
          break;
        }
      }
    }
    return alternatives;
  }
}

export class OutboundDispatchService {
  dispatch(input: {
    message: OutboundMessage;
    profile: CandidateProfile;
    providerId: string;
    accountId: string;
    policy: PolicyOutput;
    approval: "approved" | "pending" | "rejected";
	    transport?: "fixture" | "provider" | "telegram" | "calendar";
	    transportReady?: boolean;
	    liveSendEnabled?: boolean;
	    irreversibleActionsEnabled?: boolean;
	    now?: Date;
	  }): OutboundDispatchResult {
    const validation = new ConversationEngine().validateOutbound(input.message, input.profile);
    const now = input.now ?? new Date();
    const errors: string[] = [];
    if (!validation.valid) {
      errors.push(...validation.riskFlags);
    }
    if (input.policy.decision === "deny") {
      errors.push(...input.policy.reasons);
    }
    if (input.approval === "rejected") {
      errors.push("approval_rejected");
    }
    const transport = input.transport ?? "fixture";
    if (input.liveSendEnabled && transport === "fixture") {
      errors.push("live_transport_required");
    }
	    if (input.liveSendEnabled && input.transportReady !== true) {
	      errors.push("transport_readiness_required");
	    }
	    if (input.liveSendEnabled && input.irreversibleActionsEnabled !== true) {
	      errors.push("irreversible_actions_disabled");
	    }

    const blocked = errors.length > 0;
    const requiresReview = input.policy.decision === "requires_user_approval" && input.approval !== "approved";
    const status = blocked
      ? "blocked"
      : requiresReview
        ? "queued_for_review"
        : input.liveSendEnabled
          ? "sent"
          : "dry_run_recorded";

    const proofStatus = status === "dry_run_recorded" ? "proof_recorded" : status;
    const proof = {
      proofId: `outbound_proof_${stableHash(`${input.message.idempotencyKey}:${now.toISOString()}`)}`,
      outboundMessageId: `outbound_${stableHash(input.message.idempotencyKey)}`,
      providerId: input.providerId,
      accountId: input.accountId,
      conversationId: input.message.conversationId,
      inboundMessageId: input.message.inboundMessageId,
      idempotencyKey: input.message.idempotencyKey,
      transport,
      status: proofStatus,
      textHash: stableHash(input.message.text),
      validationHash: stableHash(JSON.stringify(validation)),
      policyDecision: input.policy.decision,
      createdAt: now.toISOString(),
      deliveredAt: status === "sent" ? now.toISOString() : null
    } satisfies OutboundDispatchResult["proof"];

    return {
      status,
      proof,
      deliveryId: status === "sent" ? `delivery_${stableHash(input.message.idempotencyKey)}` : null,
      errors
    };
  }
}

export const defaultRetentionPolicyRules: RetentionPolicyRule[] = [
  { artifactType: "raw_job_payload", retentionDays: 90, hardDelete: false },
  { artifactType: "dom_snapshot", retentionDays: 14, hardDelete: true },
  { artifactType: "screenshot", retentionDays: 30, hardDelete: true },
  { artifactType: "trace", retentionDays: 14, hardDelete: true },
  { artifactType: "llm_prompt", retentionDays: 30, hardDelete: true },
  { artifactType: "recruiter_message", retentionDays: 365, hardDelete: false },
  { artifactType: "proof_pack", retentionDays: 365, hardDelete: false },
  { artifactType: "audit_log", retentionDays: 2555, hardDelete: false }
];

export class RetentionPolicyEngine {
  constructor(private readonly rules: RetentionPolicyRule[] = defaultRetentionPolicyRules) {}

  evaluate(artifacts: RetentionArtifact[], now = new Date()): RetentionDecision[] {
    return artifacts.map((artifact) => {
      const rule = this.rules.find((candidate) => candidate.artifactType === artifact.artifactType);
      const purgeAfter = artifact.retentionUntil ?? addDays(artifact.createdAt, rule?.retentionDays ?? 30);
      if (artifact.legalHold) {
        return {
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          action: "legal_hold",
          reason: "Legal hold prevents retention purge",
          purgeAfter
        };
      }
      if (new Date(purgeAfter).getTime() <= now.getTime()) {
        return {
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          action: "purge",
          reason: rule?.hardDelete ? "Retention window expired; hard delete required" : "Retention window expired; archive/purge required",
          purgeAfter
        };
      }
      return {
        artifactId: artifact.artifactId,
        artifactType: artifact.artifactType,
        action: "retain",
        reason: "Retention window is still active",
        purgeAfter
      };
    });
  }
}

export class RetentionEnforcementPlanner {
  plan(decisions: RetentionDecision[]): { purgeIds: string[]; retainIds: string[]; legalHoldIds: string[]; actions: Array<{ artifactId: string; action: string }> } {
    return {
      purgeIds: decisions.filter((decision) => decision.action === "purge").map((decision) => decision.artifactId),
      retainIds: decisions.filter((decision) => decision.action === "retain").map((decision) => decision.artifactId),
      legalHoldIds: decisions.filter((decision) => decision.action === "legal_hold").map((decision) => decision.artifactId),
      actions: decisions.map((decision) => ({ artifactId: decision.artifactId, action: decision.action }))
    };
  }
}

export class ArtifactAccessPolicy {
  authorize(input: { artifactId: string; requesterRole: "owner" | "ops" | "security" | "viewer"; purpose: string; containsSensitiveData?: boolean }): {
    allowed: boolean;
    auditEvent: AuditEvent;
    reason: string | null;
  } {
    const allowed = input.requesterRole === "owner" || input.requesterRole === "security" || (input.requesterRole === "ops" && !input.containsSensitiveData);
    const reason = allowed ? null : "artifact_access_denied_by_role_or_sensitivity";
    return {
      allowed,
      reason,
      auditEvent: createAuditEvent({
        entityType: "artifact",
        entityId: input.artifactId,
        eventType: allowed ? "artifact_access_allowed" : "artifact_access_denied",
        actor: input.requesterRole,
        payload: { purpose: input.purpose, containsSensitiveData: input.containsSensitiveData ?? false, reason }
      })
    };
  }
}

export class DependencyAuditService {
  summarize(input: { vulnerabilities: Array<{ severity: "low" | "moderate" | "high" | "critical"; packageName: string }>; licenses: Array<{ packageName: string; license: string }> }): {
    passed: boolean;
    blockers: string[];
    warnings: string[];
  } {
    const blockers = input.vulnerabilities
      .filter((vulnerability) => vulnerability.severity === "high" || vulnerability.severity === "critical")
      .map((vulnerability) => `${vulnerability.severity}:${vulnerability.packageName}`);
    const warnings = input.licenses
      .filter((license) => /gpl|agpl/i.test(license.license))
      .map((license) => `license_review:${license.packageName}:${license.license}`);
    return { passed: blockers.length === 0, blockers, warnings };
  }
}

export class HistoricalInterviewLikelihoodModel {
  score(input: { baseScore: ScoreResult; providerResponseRate: number; companyInterviewRate: number; templateSuccessRate: number }): {
    likelihood: number;
    features: Record<string, number>;
  } {
    const features = {
      baseScore: input.baseScore.score,
      providerResponseRate: input.providerResponseRate,
      companyInterviewRate: input.companyInterviewRate,
      templateSuccessRate: input.templateSuccessRate
    };
    const likelihood = Math.max(
      0,
      Math.min(100, Math.round(input.baseScore.score * 0.55 + input.providerResponseRate * 20 + input.companyInterviewRate * 15 + input.templateSuccessRate * 10))
    );
    return { likelihood, features };
  }
}

export class LowQualityFeedbackModel {
  summarize(input: { rejectedSignals: string[]; acceptedSignals: string[] }): { blockSignals: string[]; reviewSignals: string[] } {
    const accepted = new Set(input.acceptedSignals.map(normalizedText));
    const rejectedCounts = new Map<string, number>();
    for (const signal of input.rejectedSignals.map(normalizedText)) {
      rejectedCounts.set(signal, (rejectedCounts.get(signal) ?? 0) + 1);
    }
    return {
      blockSignals: [...rejectedCounts.entries()].filter(([signal, count]) => count >= 3 && !accepted.has(signal)).map(([signal]) => signal),
      reviewSignals: [...rejectedCounts.entries()].filter(([, count]) => count > 0).map(([signal]) => signal)
    };
  }
}

export class SnippetGovernanceService {
  report(input: {
    snippets: Array<{ id: string; sourceProject: string; license: string; owner: string; copiedFiles: string[] }>;
    reviews: Array<{ snippetId: string; securityReview: string; testCoverage: string; modifications: string }>;
  }): { complete: boolean; missingReviews: string[]; licenseReviewRequired: string[]; reviewedSnippets: string[] } {
    const reviewed = new Set(input.reviews.map((review) => review.snippetId));
    const missingReviews = input.snippets.filter((snippet) => !reviewed.has(snippet.id)).map((snippet) => snippet.id);
    const licenseReviewRequired = input.snippets.filter((snippet) => /gpl|agpl|unknown/i.test(snippet.license)).map((snippet) => snippet.id);
    return {
      complete: missingReviews.length === 0 && licenseReviewRequired.length === 0,
      missingReviews,
      licenseReviewRequired,
      reviewedSnippets: [...reviewed]
    };
  }
}

export class SecretReferencePolicy {
  validate(input: {
    reference: SecretReference;
    environment?: "local" | "dev" | "staging" | "production";
    irreversibleActionsEnabled?: boolean;
  }): SecretValidationResult {
    const riskFlags: string[] = [];
    const environment = input.environment ?? "local";
    if (containsRawSecret(input.reference.reference)) {
      riskFlags.push("raw_secret_value_detected");
    }
    if (environment === "production" && input.irreversibleActionsEnabled && input.reference.backend === "env") {
      riskFlags.push("production_irreversible_actions_require_external_secret_store");
    }
    if (input.reference.expiresAt && new Date(input.reference.expiresAt).getTime() <= Date.now()) {
      riskFlags.push("secret_reference_expired");
    }
    if (input.reference.rotatedAt === null) {
      riskFlags.push("secret_rotation_not_recorded");
    }
    return {
      valid: riskFlags.length === 0,
      riskFlags,
      safeReference: {
        ...input.reference,
        reference: `secret-ref:${stableHash(input.reference.reference)}`
      }
    };
  }
}

export class ReleaseGateEvaluator {
  evaluate(input: {
    mode: PolicyInput["mode"];
    irreversibleActionsEnabled: boolean;
    providerReadiness: Array<{ providerId: string; readyForControlledAutoApply: boolean }>;
    liveCredentialsConfigured: boolean;
    externalSecretsBackend: boolean;
    liveCanariesPassing: boolean;
    providerSubmitProofReady: boolean;
    calendarIntegrationReady: boolean;
    sevenDaySoakPassed: boolean;
    outboundDispatchProofReady: boolean;
  }): ReleaseGateReport {
    const modeRequiresIrreversibleGate = input.mode === "controlled_auto_apply" || input.mode === "full_auto_apply";
    const checks = [
      {
        name: "mode_requires_live_gate",
        passed: !modeRequiresIrreversibleGate || input.irreversibleActionsEnabled,
        reason: modeRequiresIrreversibleGate && !input.irreversibleActionsEnabled ? `${input.mode} requires irreversible actions gate` : null
      },
      {
        name: "provider_readiness",
        passed: input.providerReadiness.length > 0 && input.providerReadiness.every((provider) => provider.readyForControlledAutoApply),
        reason:
          input.providerReadiness.length === 0
            ? "No provider readiness reports are available"
            : input.providerReadiness.some((provider) => !provider.readyForControlledAutoApply)
              ? `Providers not ready: ${input.providerReadiness.filter((provider) => !provider.readyForControlledAutoApply).map((provider) => provider.providerId).join(", ")}`
              : null
      },
      {
        name: "live_credentials_configured",
        passed: input.liveCredentialsConfigured,
        reason: input.liveCredentialsConfigured ? null : "Live provider/Telegram credentials are not configured"
      },
      {
        name: "external_secrets_backend",
        passed: input.externalSecretsBackend,
        reason: input.externalSecretsBackend ? null : "External secrets backend is not configured"
      },
      {
        name: "live_canaries_passing",
        passed: input.liveCanariesPassing,
        reason: input.liveCanariesPassing ? null : "Live provider canaries are missing or failing"
      },
      {
        name: "provider_submit_proof_ready",
        passed: input.providerSubmitProofReady,
        reason: input.providerSubmitProofReady ? null : "Provider submit proof is not ready"
      },
      {
        name: "calendar_integration_ready",
        passed: input.calendarIntegrationReady,
        reason: input.calendarIntegrationReady ? null : "Calendar integration is not ready"
      },
      {
        name: "seven_day_soak_passed",
        passed: input.sevenDaySoakPassed,
        reason: input.sevenDaySoakPassed ? null : "Dated 7-day production soak has not passed"
      },
      {
        name: "outbound_dispatch_proof_ready",
        passed: input.outboundDispatchProofReady,
        reason: input.outboundDispatchProofReady ? null : "Outbound dispatch proof is not ready"
      }
    ];
    const blockers = checks.filter((check) => !check.passed).map((check) => check.reason ?? check.name);
    return {
      readyForLiveAutomation: blockers.length === 0,
      checks,
      blockers
    };
  }
}

export class ReleaseEvidenceEvaluator {
  validateRecord(input: { record: ReleaseEvidenceRecord; expectedProviderIds: string[]; now?: Date }): string[] {
    return validateReleaseEvidenceRecord(input.record, input.expectedProviderIds, input.now ?? new Date());
  }

  summarize(input: {
    records: ReleaseEvidenceRecord[];
    expectedProviderIds: string[];
    now?: Date;
  }): ReleaseEvidenceSummary {
    const now = input.now ?? new Date();
    const passedAndCurrent = input.records.filter((record) => record.status === "passed" && (!record.expiresAt || new Date(record.expiresAt).getTime() > now.getTime()));
    const invalidEvidence = passedAndCurrent
      .map((record) => ({ record, failures: validateReleaseEvidenceRecord(record, input.expectedProviderIds, now) }))
      .filter((entry) => entry.failures.length > 0);
    const invalidEvidenceById = new Map(invalidEvidence.map((entry) => [entry.record.evidenceId, entry.failures]));
    const accepted = passedAndCurrent.filter((record) => !invalidEvidenceById.has(record.evidenceId));
    const acceptedEvidenceIds = accepted.map((record) => record.evidenceId);
    const hasGlobal = (type: ReleaseEvidenceRecord["evidenceType"]) => accepted.some((record) => record.evidenceType === type);
    const liveCanaryProviderIds = new Set(
      accepted.filter((record) => record.evidenceType === "live_canary_passed" && record.providerId).map((record) => record.providerId!)
    );
    const expectedProviderIds = input.expectedProviderIds.filter(Boolean);
    const liveCanariesPassing =
      expectedProviderIds.length > 0 && expectedProviderIds.every((providerId) => liveCanaryProviderIds.has(providerId));
    const sevenDaySoakPassed = accepted
      .filter((record) => record.evidenceType === "seven_day_soak_passed")
      .some((record) => soakDurationDays(record) >= 7);

    const summary = {
      liveCredentialsConfigured: hasGlobal("live_credentials_configured"),
      externalSecretsBackend: hasGlobal("external_secrets_backend"),
      liveCanariesPassing,
      providerSubmitProofReady: accepted.some((record) => record.evidenceType === "provider_submit_proof_ready" && record.providerId),
      calendarIntegrationReady: hasGlobal("calendar_integration_ready"),
      sevenDaySoakPassed,
      outboundDispatchProofReady: hasGlobal("outbound_dispatch_proof_ready"),
      acceptedEvidenceIds,
      invalidEvidenceIds: invalidEvidence.map((entry) => entry.record.evidenceId),
      blockers: [] as string[]
    };
    for (const entry of invalidEvidence) {
      summary.blockers.push(`invalid_release_evidence:${entry.record.evidenceId}:${entry.failures.join(",")}`);
    }
    if (!summary.liveCredentialsConfigured) {
      summary.blockers.push("missing_live_credentials_evidence");
    }
    if (!summary.externalSecretsBackend) {
      summary.blockers.push("missing_external_secrets_backend_evidence");
    }
    if (!summary.liveCanariesPassing) {
      const missingProviders = expectedProviderIds.filter((providerId) => !liveCanaryProviderIds.has(providerId));
      summary.blockers.push(`missing_live_canary_evidence:${missingProviders.join(",") || "all"}`);
    }
    if (!summary.providerSubmitProofReady) {
      summary.blockers.push("missing_provider_submit_proof_evidence");
    }
    if (!summary.calendarIntegrationReady) {
      summary.blockers.push("missing_calendar_integration_evidence");
    }
    if (!summary.sevenDaySoakPassed) {
      summary.blockers.push("missing_seven_day_soak_evidence");
    }
    if (!summary.outboundDispatchProofReady) {
      summary.blockers.push("missing_outbound_dispatch_proof_evidence");
    }
    return summary;
  }
}

export class InterviewCoordinator {
  constructor(private readonly calendar: CalendarAdapter = new InMemoryCalendarAdapter()) {}

  chooseSlot(slots: ProposedSlot[], profile: CandidateProfile, now = new Date(), existingEvents: InterviewEvent[] = []): ProposedSlot | null {
    const minTime = now.getTime() + profile.availability.minNoticeHours * 60 * 60 * 1000;
    return (
      slots.find((slot) => {
        const candidate = new Date(zonedDateTimeMs(slot.date, slot.time, slot.timezone));
        const proof = this.evaluateSlot(slot, profile, now, existingEvents);
        return candidate.getTime() >= minTime && Object.values(proof).every(Boolean);
      }) ?? null
    );
  }

  evaluateSlot(slot: ProposedSlot, profile: CandidateProfile, now = new Date(), existingEvents: InterviewEvent[] = []): SchedulingDecision["policyProof"] {
    const candidate = new Date(zonedDateTimeMs(slot.date, slot.time, slot.timezone));
    const sameDayEvents = existingEvents.filter((event) => event.dateTime.slice(0, 10) === slot.date);
    const proof = {
      timezoneMatched: slot.timezone === profile.availability.timezone,
      minNoticeSatisfied: candidate.getTime() >= now.getTime() + profile.availability.minNoticeHours * 60 * 60 * 1000,
      insideAvailabilityWindow: this.isInsideWindow(slot, profile),
      noCalendarConflict: !this.hasConflict(slot, profile, existingEvents),
      maxPerDaySatisfied: sameDayEvents.length < profile.availability.maxInterviewsPerDay
    };
    return { ...proof, proofHash: stableHash(JSON.stringify(proof)) };
  }

  createEvent(input: {
    jobId: string;
    companyId: string;
    conversationId: string;
    slot: ProposedSlot;
    link?: string | null;
    recruiterName?: string | null;
  }): InterviewEvent {
    return {
      interviewId: `int_${randomUUID()}`,
      jobId: input.jobId,
      companyId: input.companyId,
      conversationId: input.conversationId,
      dateTime: `${input.slot.date}T${input.slot.time}:00`,
      timezone: input.slot.timezone,
      format: input.link ? "video_call" : "unknown",
      link: input.link ?? null,
      recruiterName: input.recruiterName ?? null,
      status: "scheduled",
      summaryPackId: `summary_${stableHash(`${input.jobId}:${input.conversationId}:${input.slot.date}:${input.slot.time}`)}`
    };
  }

  createPendingConfirmation(input: Parameters<InterviewCoordinator["createEvent"]>[0]): InterviewEvent {
    return { ...this.createEvent(input), status: "pending_confirmation" };
  }

  private isInsideWindow(slot: ProposedSlot, profile: CandidateProfile): boolean {
    const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: profile.availability.timezone })
      .format(new Date(zonedDateTimeMs(slot.date, slot.time, slot.timezone)))
      .toLowerCase();
    const windows = profile.availability.defaultWindows[dayName] ?? [];
    const slotMinutes = toMinutes(slot.time);
    return windows.some((window) => {
      const [start = "", end = ""] = window.split("-");
      return slotMinutes >= toMinutes(start) && slotMinutes <= toMinutes(end);
    });
  }

  private hasConflict(slot: ProposedSlot, profile: CandidateProfile, existingEvents: InterviewEvent[]): boolean {
    const window = slotWindow(slot, profile);
    const interviewConflicts = existingEvents.some((event) => {
      const eventStart = interviewEventStartMs(event) - profile.availability.bufferMinutesBefore * 60 * 1000;
      const eventEnd = interviewEventStartMs(event) + (60 + profile.availability.bufferMinutesAfter) * 60 * 1000;
      return rangesOverlap(window.start, window.end, eventStart, eventEnd);
    });
    if (interviewConflicts) {
      return true;
    }
    return this.calendar.listBusyWindows({ from: new Date(window.start).toISOString(), to: new Date(window.end).toISOString(), timezone: slot.timezone }).length > 0;
  }
}

function toMinutes(value: string): number {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function slotWindow(slot: ProposedSlot, profile: CandidateProfile): { start: number; end: number } {
  const slotStart = zonedDateTimeMs(slot.date, slot.time, slot.timezone);
  const durationMinutes = slot.durationMinutes ?? 60;
  const start = slotStart - profile.availability.bufferMinutesBefore * 60 * 1000;
  const end = slotStart + (durationMinutes + profile.availability.bufferMinutesAfter) * 60 * 1000;
  return { start, end };
}

function interviewEventStartMs(event: Pick<InterviewEvent, "dateTime" | "timezone">): number {
  return zonedDateTimeMs(event.dateTime.slice(0, 10), event.dateTime.slice(11, 16), event.timezone);
}

function zonedDateTimeMs(date: string, time: string, timezone: string): number {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  utc = Date.UTC(year, month - 1, day, hour, minute, 0) - timezoneOffsetMs(utc, timezone);
  return Date.UTC(year, month - 1, day, hour, minute, 0) - timezoneOffsetMs(utc, timezone);
}

function timezoneOffsetMs(utcMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(utcMs));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = value("hour") === 24 ? 0 : value("hour");
  const zonedAsUtc = Date.UTC(value("year"), value("month") - 1, value("day"), hour, value("minute"), value("second"));
  return zonedAsUtc - utcMs;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function parseIcsBusyWindows(contents: string, fallbackTimezone: string): CalendarBusyWindow[] {
  const lines = unfoldIcsLines(contents);
  const windows: CalendarBusyWindow[] = [];
  let eventLines: string[] = [];
  let insideEvent = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      insideEvent = true;
      eventLines = [];
      continue;
    }
    if (line === "END:VEVENT") {
      const window = parseIcsEvent(eventLines, fallbackTimezone);
      if (window) {
        windows.push(window);
      }
      insideEvent = false;
      eventLines = [];
      continue;
    }
    if (insideEvent) {
      eventLines.push(line);
    }
  }
  return windows;
}

function unfoldIcsLines(contents: string): string[] {
  const unfolded: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]}${line.slice(1)}`;
      continue;
    }
    unfolded.push(line.trimEnd());
  }
  return unfolded;
}

function parseIcsEvent(lines: string[], fallbackTimezone: string): CalendarBusyWindow | null {
  const fields = new Map<string, { value: string; params: Record<string, string> }>();
  for (const line of lines) {
    const parsed = parseIcsLine(line);
    if (parsed) {
      fields.set(parsed.name, { value: parsed.value, params: parsed.params });
    }
  }
  const start = fields.get("DTSTART");
  const end = fields.get("DTEND");
  if (!start || !end) {
    return null;
  }
  const timezone = start.params.TZID ?? end.params.TZID ?? fallbackTimezone;
  const parsedStart = parseIcsDateTime(start.value, timezone);
  const parsedEnd = parseIcsDateTime(end.value, timezone);
  if (!parsedStart || !parsedEnd || parsedEnd.getTime() <= parsedStart.getTime()) {
    return null;
  }
  return {
    id: fields.get("UID")?.value ?? `ics:${stableHash(`${start.value}:${end.value}:${fields.get("SUMMARY")?.value ?? ""}`)}`,
    source: "external_calendar",
    start: parsedStart.toISOString(),
    end: parsedEnd.toISOString(),
    timezone,
    title: fields.get("SUMMARY")?.value ?? null
  };
}

function parseIcsLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const left = line.slice(0, separatorIndex);
  const value = line.slice(separatorIndex + 1);
  const [rawName = "", ...rawParams] = left.split(";");
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const [key = "", ...valueParts] = param.split("=");
    const paramValue = valueParts.join("=");
    if (key.length > 0 && paramValue.length > 0) {
      params[key.toUpperCase()] = paramValue;
    }
  }
  return { name: rawName.toUpperCase(), params, value };
}

function parseIcsDateTime(value: string, timezone: string): Date | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) {
    return null;
  }
  const [, year = "1970", month = "01", day = "01", hour = "00", minute = "00", second = "00", utcMarker] = match;
  if (utcMarker === "Z") {
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }
  const date = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}`;
  return new Date(zonedDateTimeMs(date, time, timezone) + Number(second) * 1000);
}

function addDays(isoDate: string, days: number): string {
  return new Date(new Date(isoDate).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function containsRawSecret(value: string): boolean {
  return (
    /bearer\s+[a-z0-9._~+/=-]+/i.test(value) ||
    /(?:api[_-]?key|token|secret|password|session)=([^&\s]+)/i.test(value) ||
    /(?:sk|ghp|glpat|xox[baprs])[-_a-z0-9]{16,}/i.test(value)
  );
}

function validateReleaseEvidenceRecord(record: ReleaseEvidenceRecord, expectedProviderIds: string[], now: Date): string[] {
  const failures: string[] = [];
  if (!isLiveEvidenceSource(record.source)) {
    failures.push("live_evidence_source_required");
  }
  if (isFutureIsoTimestamp(record.observedAt, now)) {
    failures.push("observed_at_must_not_be_future");
  }
  if (record.metadata.template === true || record.metadata.example === true) {
    failures.push("example_release_evidence_not_allowed");
  }
  if (metadataContainsRawSecret(record.metadata)) {
    failures.push("metadata_contains_raw_secret");
  }

  switch (record.evidenceType) {
    case "live_credentials_configured": {
      if (!hasNonEmptyStringArray(record.metadata.secretReferenceIds)) {
        failures.push("secret_reference_ids_required");
      }
      const coveredProviderIds = stringArray(record.metadata.coveredProviderIds);
      const missingProviders = expectedProviderIds.filter((providerId) => !coveredProviderIds.includes(providerId));
      if (missingProviders.length > 0) {
        failures.push(`credential_coverage_missing:${missingProviders.join("|")}`);
      }
      if (record.metadata.telegramBot !== true) {
        failures.push("telegram_bot_credential_required");
      }
      if (!isIsoDateString(record.metadata.checkedAt)) {
        failures.push("checked_at_required");
      } else if (isFutureIsoTimestamp(record.metadata.checkedAt, now)) {
        failures.push("checked_at_must_not_be_future");
      }
      if (!isIsoDateString(record.expiresAt)) {
        failures.push("credentials_expires_at_required");
      } else if (isIsoDateString(record.metadata.checkedAt) && Date.parse(record.expiresAt) <= Date.parse(record.metadata.checkedAt)) {
        failures.push("credentials_expires_at_must_follow_checked_at");
      }
      requireObservedAtMatches(record, record.metadata.checkedAt, "credentials", failures);
      break;
    }
    case "external_secrets_backend": {
      const backend = record.metadata.backend;
      if (!isApprovedSecretBackend(backend)) {
        failures.push("approved_secret_backend_required");
      }
      if (record.metadata.accessCheck !== true && record.metadata.probe !== "passed") {
        failures.push("secrets_backend_access_check_required");
      }
      if (!isIsoDateString(record.metadata.checkedAt)) {
        failures.push("checked_at_required");
      } else if (isFutureIsoTimestamp(record.metadata.checkedAt, now)) {
        failures.push("checked_at_must_not_be_future");
      }
      if (!isIsoDateString(record.expiresAt)) {
        failures.push("secrets_backend_expires_at_required");
      } else if (isIsoDateString(record.metadata.checkedAt) && Date.parse(record.expiresAt) <= Date.parse(record.metadata.checkedAt)) {
        failures.push("secrets_backend_expires_at_must_follow_checked_at");
      }
      requireObservedAtMatches(record, record.metadata.checkedAt, "secrets_backend", failures);
      break;
    }
    case "live_canary_passed": {
      if (!record.providerId) {
        failures.push("provider_id_required");
      } else if (expectedProviderIds.length > 0 && !expectedProviderIds.includes(record.providerId)) {
        failures.push("provider_id_not_expected");
      }
      if (!isNonEmptyString(record.metadata.canaryRunId)) {
        failures.push("canary_run_id_required");
      }
      if (!isIsoDateString(record.metadata.checkedAt)) {
        failures.push("checked_at_required");
      } else if (isFutureIsoTimestamp(record.metadata.checkedAt, now)) {
        failures.push("checked_at_must_not_be_future");
      }
      if (record.metadata.result !== "passed" && record.metadata.status !== "passed") {
        failures.push("canary_pass_result_required");
      }
      if (!isIsoDateString(record.expiresAt)) {
        failures.push("canary_expires_at_required");
      } else if (isIsoDateString(record.metadata.checkedAt) && Date.parse(record.expiresAt) <= Date.parse(record.metadata.checkedAt)) {
        failures.push("canary_expires_at_must_follow_checked_at");
      }
      requireObservedAtMatches(record, record.metadata.checkedAt, "canary", failures);
      break;
    }
    case "provider_submit_proof_ready": {
      if (!record.providerId) {
        failures.push("provider_id_required");
      } else if (expectedProviderIds.length > 0 && !expectedProviderIds.includes(record.providerId)) {
        failures.push("provider_id_not_expected");
      }
      if (!isNonEmptyString(record.metadata.applicationId)) {
        failures.push("application_id_required");
      }
      if (!isNonEmptyString(record.metadata.proofId)) {
        failures.push("proof_id_required");
      }
      if (record.metadata.action !== "send_application") {
        failures.push("send_application_action_required");
      }
      if (record.metadata.transport !== "provider") {
        failures.push("provider_transport_required");
      }
      if (!isNonEmptyString(record.metadata.idempotencyKeyHash)) {
        failures.push("idempotency_key_hash_required");
      }
      if (!isNonEmptyString(record.metadata.draftHash)) {
        failures.push("draft_hash_required");
      }
      if (record.metadata.submitStatus !== "submitted" && record.metadata.proofStatus !== "submitted") {
        failures.push("submitted_status_required");
      }
      if (!isIsoDateString(record.metadata.submittedAt)) {
        failures.push("submitted_at_required");
      } else if (isFutureIsoTimestamp(record.metadata.submittedAt, now)) {
        failures.push("submitted_at_must_not_be_future");
      }
      if (!isIsoDateString(record.expiresAt)) {
        failures.push("provider_submit_expires_at_required");
      } else if (isIsoDateString(record.metadata.submittedAt) && Date.parse(record.expiresAt) <= Date.parse(record.metadata.submittedAt)) {
        failures.push("provider_submit_expires_at_must_follow_submitted_at");
      }
      requireObservedAtMatches(record, record.metadata.submittedAt, "provider_submit", failures);
      if ("coverLetterText" in record.metadata || "resumeText" in record.metadata || "rawPayload" in record.metadata) {
        failures.push("raw_application_payload_not_allowed");
      }
      break;
    }
    case "calendar_integration_ready": {
      if (!isNonEmptyString(record.metadata.calendarProvider)) {
        failures.push("calendar_provider_required");
      }
      if (!isIsoDateString(record.metadata.checkedAt)) {
        failures.push("checked_at_required");
      } else if (isFutureIsoTimestamp(record.metadata.checkedAt, now)) {
        failures.push("checked_at_must_not_be_future");
      }
      for (const check of ["readCheck", "conflictCheck", "writeCheck"] as const) {
        if (record.metadata[check] !== true) {
          failures.push(`${check}_required`);
        }
      }
      if (!isIsoDateString(record.expiresAt)) {
        failures.push("calendar_expires_at_required");
      } else if (isIsoDateString(record.metadata.checkedAt) && Date.parse(record.expiresAt) <= Date.parse(record.metadata.checkedAt)) {
        failures.push("calendar_expires_at_must_follow_checked_at");
      }
      requireObservedAtMatches(record, record.metadata.checkedAt, "calendar", failures);
      break;
    }
    case "seven_day_soak_passed": {
      const startedAt = record.metadata.startedAt;
      const completedAt = record.metadata.completedAt;
      if (!isIsoDateString(startedAt)) {
        failures.push("soak_started_at_required");
      } else if (isFutureIsoTimestamp(startedAt, now)) {
        failures.push("soak_started_at_must_not_be_future");
      }
      if (!isIsoDateString(record.metadata.completedAt)) {
        failures.push("soak_completed_at_required");
      } else if (isFutureIsoTimestamp(record.metadata.completedAt, now)) {
        failures.push("soak_completed_at_must_not_be_future");
      }
      if (isIsoDateString(startedAt) && isIsoDateString(completedAt)) {
        if (Date.parse(completedAt) <= Date.parse(startedAt)) {
          failures.push("soak_completed_at_must_follow_started_at");
        }
        if (soakDurationDays(record) < 7) {
          failures.push("minimum_seven_day_duration_required");
        }
      } else {
        failures.push("minimum_seven_day_duration_required");
      }
      if (!isIsoDateString(record.expiresAt)) {
        failures.push("soak_expires_at_required");
      } else if (isIsoDateString(record.metadata.completedAt) && Date.parse(record.expiresAt) <= Date.parse(record.metadata.completedAt)) {
        failures.push("soak_expires_at_must_follow_completed_at");
      }
      requireObservedAtMatches(record, completedAt, "soak", failures);
      if (record.metadata.duplicateApplicationCount !== 0) {
        failures.push("zero_duplicate_applications_required");
      }
      if (record.metadata.proofCoveragePercent !== 100) {
        failures.push("full_proof_coverage_required");
      }
      if (record.metadata.stateLossDetected !== false) {
        failures.push("no_state_loss_required");
      }
      if (record.metadata.unsupportedFactCount !== 0) {
        failures.push("zero_unsupported_facts_required");
      }
      if (record.metadata.incidentDrillPassed !== true) {
        failures.push("incident_drill_required");
      }
      if (record.metadata.rollbackDrillPassed !== true) {
        failures.push("rollback_drill_required");
      }
      break;
    }
    case "outbound_dispatch_proof_ready": {
      if (!isNonEmptyString(record.metadata.proofId)) {
        failures.push("proof_id_required");
      }
      if (!["provider", "telegram", "calendar"].includes(String(record.metadata.transport))) {
        failures.push("live_transport_required");
      }
      if (!isNonEmptyString(record.metadata.idempotencyKeyHash)) {
        failures.push("idempotency_key_hash_required");
      }
      if (!isNonEmptyString(record.metadata.textHash)) {
        failures.push("text_hash_required");
      }
      if (record.metadata.deliveryStatus !== "sent" && record.metadata.proofStatus !== "sent") {
        failures.push("sent_delivery_status_required");
      }
      if (!isIsoDateString(record.metadata.deliveredAt)) {
        failures.push("delivered_at_required");
      } else if (isFutureIsoTimestamp(record.metadata.deliveredAt, now)) {
        failures.push("delivered_at_must_not_be_future");
      } else if (isIsoDateString(record.expiresAt) && Date.parse(record.expiresAt) <= Date.parse(record.metadata.deliveredAt)) {
        failures.push("outbound_dispatch_expires_at_must_follow_delivered_at");
      }
      if (!isIsoDateString(record.expiresAt)) {
        failures.push("outbound_dispatch_expires_at_required");
      }
      requireObservedAtMatches(record, record.metadata.deliveredAt, "outbound_dispatch", failures);
      if ("text" in record.metadata || "messageText" in record.metadata || "rawMessage" in record.metadata) {
        failures.push("raw_message_not_allowed");
      }
      break;
    }
  }
  return failures;
}

function isLiveEvidenceSource(source: string): boolean {
  const normalized = source.trim();
  if (normalized.length === 0) {
    return false;
  }
  const isManagedLocalEncryptedSecretStore = /local[-_\s]?encrypted[-_\s]?file[-_\s]?secret[-_\s]?store/i.test(normalized);
  const blockedSourcePattern = isManagedLocalEncryptedSecretStore
    ? /(fixture|mock|test|example|template|placeholder)/i
    : /(fixture|mock|local|test|example|template|placeholder)/i;
  return !blockedSourcePattern.test(normalized) && hasExternalProofReference(normalized);
}

function hasExternalProofReference(source: string): boolean {
  return (
    /\bhttps?:\/\/[^\s]+/i.test(source) ||
    /\b(?:github-actions|gitlab|circleci|buildkite|jenkins|argo|airflow|temporal):\/\/[^\s]+/i.test(source) ||
    /\b(?:run|workflow|build|job|execution|pipeline|proof|probe|smoke|canary|drill|audit|check)\b[\s:#/-]+[a-z0-9][a-z0-9._:-]*/i.test(source)
  );
}

function requireObservedAtMatches(record: ReleaseEvidenceRecord, sourceTimestamp: unknown, prefix: string, failures: string[]): void {
  if (isIsoDateString(sourceTimestamp) && (!isIsoDateString(record.observedAt) || Date.parse(record.observedAt) !== Date.parse(sourceTimestamp))) {
    failures.push(`${prefix}_observed_at_must_match_source_timestamp`);
  }
}

function isFutureIsoTimestamp(value: unknown, now: Date): boolean {
  return isIsoDateString(value) && Date.parse(value) > now.getTime();
}

function metadataContainsRawSecret(value: unknown, depth = 0): boolean {
  if (depth > 12) {
    return true;
  }
  if (typeof value === "string") {
    return containsRawSecret(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => metadataContainsRawSecret(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => metadataContainsRawSecret(item, depth + 1));
  }
  return false;
}

function isApprovedSecretBackend(value: unknown): boolean {
  return value === "aws_secrets_manager" || value === "gcp_secret_manager" || value === "vault" || value === "local_encrypted_file";
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return stringArray(value).length > 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function soakDurationDays(record: ReleaseEvidenceRecord): number {
  const startedAt = record.metadata.startedAt;
  const completedAt = record.metadata.completedAt;
  if (typeof startedAt === "string" && typeof completedAt === "string") {
    return (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / (24 * 60 * 60 * 1000);
  }
  return 0;
}

export function createAuditEvent(input: {
  entityType: string;
  entityId: string;
  eventType: string;
  actor: string;
  policyVersion?: string | null;
  payload?: Record<string, unknown>;
}): AuditEvent {
  return {
    eventId: `audit_${randomUUID()}`,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    actor: input.actor,
    policyVersion: input.policyVersion ?? null,
    timestamp: new Date().toISOString(),
    payload: input.payload ?? {}
  };
}
