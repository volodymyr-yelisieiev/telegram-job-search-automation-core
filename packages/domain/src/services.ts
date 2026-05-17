import { createHash, randomUUID } from "node:crypto";
import type {
  AuditEvent,
  CandidateProfile,
  CoverLetter,
  DedupDecision,
  DedupKey,
  InterviewEvent,
  MessageClassification,
  NormalizedJob,
  OutboundMessage,
  PolicyCheck,
  PolicyInput,
  PolicyOutput,
  ProposedSlot,
  ResumeRoute,
  ScoreResult
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
  score(job: NormalizedJob, profile: CandidateProfile): ScoreResult {
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
      score += 15;
      reasons.push(`Title matches target role: ${job.title}`);
    }

    const primaryMatches = profile.primaryStack.filter((skill) => text.includes(normalizedText(skill)));
    score += Math.min(20, primaryMatches.length * 5);
    if (primaryMatches.length > 0) {
      reasons.push(`Primary stack match: ${primaryMatches.join(", ")}`);
    }

    const secondaryMatches = profile.secondaryStack.filter((skill) => text.includes(normalizedText(skill)));
    score += Math.min(8, secondaryMatches.length * 2);
    if (secondaryMatches.length > 0) {
      reasons.push(`Secondary stack match: ${secondaryMatches.join(", ")}`);
    }

    if (job.seniority === null || profile.seniorityTargets.some((level) => normalizedText(job.seniority).includes(normalizedText(level)))) {
      score += 10;
      if (job.seniority === null) {
        risks.push("Seniority is not explicit");
      } else {
        reasons.push(`Seniority fits target: ${job.seniority}`);
      }
    }

    if (profile.geography.allowedWorkFormats.includes(job.workFormat)) {
      score += 10;
      reasons.push(`Work format is compatible: ${job.workFormat}`);
    } else if (job.workFormat === "unknown") {
      score += 4;
      risks.push("Work format is unknown");
    }

    if (job.location === null || normalizedText(job.location).includes("remote") || normalizedText(job.location).includes("vienna")) {
      score += 8;
    }

    if (job.compensationMin === null && job.compensationMax === null) {
      risks.push("Compensation is not specified");
    } else if (monthlyMaxEur !== null && monthlyMaxEur >= profile.compensation.minMonthlyEur) {
      score += 10;
      reasons.push("Compensation is within target range");
    } else if (job.compensationCurrency !== "EUR") {
      risks.push("Compensation currency is not EUR");
    }

    if (profile.languages.allowed.includes(job.language)) {
      score += 5;
      reasons.push(`Language is allowed: ${job.language}`);
    }

    score += Math.min(8, primaryMatches.length * 2);
    score += 4;

    if (text.length < 400) {
      score -= 8;
      risks.push("Vacancy description is short");
    }

    if (hardRejections.length > 0) {
      score = Math.min(score, 45);
    }

    const boundedScore = Math.max(0, Math.min(100, score));
    const interviewLikelihoodScore = Math.max(0, Math.min(100, boundedScore + (job.publicationDate ? 5 : 0) - risks.length * 3));
    const decision = boundedScore >= 72 && hardRejections.length === 0 ? "shortlisted" : "rejected";

    if (hardRejections.length === 0 && !reasons.includes("No blacklist or duplicate detected")) {
      reasons.push("No blacklist or duplicate detected");
    }

    return {
      score: boundedScore,
      interviewLikelihoodScore,
      decision,
      reasons: reasons.slice(0, 7),
      risks: risks.slice(0, 7),
      hardRejections
    };
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

    if (/test assignment|take-home|тестов/.test(normalized)) {
      return this.result("test_assignment", 0.9, true, false, sensitiveDataRequested, proposedSlots, [
        "Recruiter mentions a test assignment"
      ]);
    }

    if (/salary|compensation|зарплат|вилка|rate/.test(normalized)) {
      return this.result("request_for_salary_expectation", 0.88, true, true, sensitiveDataRequested, proposedSlots, [
        "Recruiter asks for salary expectation"
      ]);
    }

    if (/location|where are you|локац|находитесь/.test(normalized)) {
      return this.result("request_for_location", 0.86, true, true, sensitiveDataRequested, proposedSlots, [
        "Recruiter asks for location"
      ]);
    }

    if (/interview|call|meet|zoom|google meet|созвон|интервью/.test(normalized) || proposedSlots.length > 0) {
      return this.result("scheduling_request", 0.91, true, !sensitiveDataRequested, sensitiveDataRequested, proposedSlots, [
        "Recruiter discusses interview scheduling"
      ]);
    }

    if (/unfortunately|reject|not proceed|отказ|не готовы/.test(normalized)) {
      return this.result("rejection", 0.9, false, false, sensitiveDataRequested, proposedSlots, ["Recruiter sent a rejection"]);
    }

    if (/thanks|thank you|received|дякую|спасибо/.test(normalized)) {
      return this.result("acknowledgment", 0.84, false, true, sensitiveDataRequested, proposedSlots, ["Message is an acknowledgment"]);
    }

    return this.result("unknown", 0.5, true, false, sensitiveDataRequested, proposedSlots, ["No safe category matched"]);
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
    requiresReply: boolean,
    allowedAutoReply: boolean,
    sensitiveDataRequested: boolean,
    proposedSlots: ProposedSlot[],
    reasons: string[]
  ): MessageClassification {
    return {
      category,
      confidence,
      requiresReply,
      deadline: null,
      containsInterviewLink: false,
      proposedSlots,
      sensitiveDataRequested,
      allowedAutoReply: allowedAutoReply && !sensitiveDataRequested,
      reasons
    };
  }

  private extractSlots(text: string, timezone: string): ProposedSlot[] {
    const matches = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\b/g)];
    return matches.map((match) => ({
      date: match[1] ?? "1970-01-01",
      time: match[2] ?? "00:00",
      timezone
    }));
  }
}

export class InterviewCoordinator {
  chooseSlot(slots: ProposedSlot[], profile: CandidateProfile, now = new Date()): ProposedSlot | null {
    const minTime = now.getTime() + profile.availability.minNoticeHours * 60 * 60 * 1000;
    return (
      slots.find((slot) => {
        const candidate = new Date(`${slot.date}T${slot.time}:00`);
        return candidate.getTime() >= minTime;
      }) ?? null
    );
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
