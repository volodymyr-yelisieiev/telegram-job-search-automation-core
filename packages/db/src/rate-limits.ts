import {
  buildDedupKey,
  type CandidateProfile,
  type NormalizedJob,
  type RateLimitDecision
} from "@job-search/domain";

type ApplicationLimitRecord = {
  id: string;
  jobId: string;
  providerId: string;
  status: string;
  createdAt: string;
  submittedAt?: string | null;
};

type ConversationLimitRecord = {
  id: string;
  companyName: string | null;
};

type OutboundLimitRecord = {
  id: string;
  message: {
    conversationId: string;
  };
  status: string;
  createdAt: string;
};

export type RateLimitCheck = RateLimitDecision & {
  name: string;
  reason: string | null;
};

export interface RateLimitAssessment {
  allowed: boolean;
  checks: RateLimitCheck[];
  reasons: string[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const preparedApplicationStatuses = new Set([
  "application_prepared",
  "manual_review_required",
  "apply_queued",
  "apply_dry_run_passed",
  "applying",
  "applied"
]);

const irreversibleApplicationStatuses = new Set(["apply_queued", "applying", "applied"]);
const countedOutboundStatuses = new Set(["queued_for_review", "dry_run_recorded", "sent"]);

export function evaluateApplicationRateLimits(input: {
  profile: CandidateProfile;
  applications: Iterable<ApplicationLimitRecord>;
  jobs: Iterable<NormalizedJob>;
  job: NormalizedJob;
  providerId?: string;
  includePrepared?: boolean;
  excludeApplicationId?: string;
  now?: Date;
}): RateLimitAssessment {
  const now = input.now ?? new Date();
  const jobsById = new Map([...input.jobs].map((job) => [job.id, job]));
  const targetCompany = normalizeLimitKey(input.job.companyName);
  const targetCloneGroup = buildDedupKey(input.job).companyRoleKey;
  const statuses = input.includePrepared ? preparedApplicationStatuses : irreversibleApplicationStatuses;
  const applications = [...input.applications].filter((application) => {
    if (application.id === input.excludeApplicationId) {
      return false;
    }
    if (!statuses.has(application.status)) {
      return false;
    }
    return Number.isFinite(Date.parse(applicationTimestamp(application)));
  });

  const providerId = input.providerId ?? input.job.sourceProvider;
  const sameCompany = applications.filter((application) => {
    const job = jobsById.get(application.jobId);
    return targetCompany.length > 0 && normalizeLimitKey(job?.companyName) === targetCompany;
  });
  const sameCloneGroup = applications.filter((application) => {
    const job = jobsById.get(application.jobId);
    return job ? buildDedupKey(job).companyRoleKey === targetCloneGroup : false;
  });

  const checks = [
    buildWindowCheck({
      name: "applications_per_hour",
      key: `apply:${input.profile.userId}:hour`,
      limit: input.profile.rateLimits.applicationsPerHour,
      timestamps: applications.map(applicationTimestamp),
      windowMs: HOUR_MS,
      now
    }),
    buildWindowCheck({
      name: "applications_per_day",
      key: `apply:${input.profile.userId}:day`,
      limit: input.profile.rateLimits.applicationsPerDay,
      timestamps: applications.map(applicationTimestamp),
      windowMs: DAY_MS,
      now
    }),
    buildWindowCheck({
      name: "provider_applications_per_hour",
      key: `apply:${input.profile.userId}:${providerId}:hour`,
      limit: input.profile.rateLimits.applicationsPerHour,
      timestamps: applications.filter((application) => application.providerId === providerId).map(applicationTimestamp),
      windowMs: HOUR_MS,
      now
    }),
    buildWindowCheck({
      name: "company_applications_per_day",
      key: `apply:${input.profile.userId}:company:${targetCompany || "unknown"}:day`,
      limit: input.profile.rateLimits.maxPerCompanyPerDay,
      timestamps: sameCompany.map(applicationTimestamp),
      windowMs: DAY_MS,
      now
    }),
    buildWindowCheck({
      name: "company_applications_per_week",
      key: `apply:${input.profile.userId}:company:${targetCompany || "unknown"}:week`,
      limit: input.profile.rateLimits.maxPerCompanyPerWeek,
      timestamps: sameCompany.map(applicationTimestamp),
      windowMs: WEEK_MS,
      now
    }),
    buildWindowCheck({
      name: "clone_group_applications_per_day",
      key: `apply:${input.profile.userId}:clone:${targetCloneGroup}:day`,
      limit: input.profile.rateLimits.maxPerCompanyPerDay,
      timestamps: sameCloneGroup.map(applicationTimestamp),
      windowMs: DAY_MS,
      now
    }),
    buildWindowCheck({
      name: "clone_group_applications_per_week",
      key: `apply:${input.profile.userId}:clone:${targetCloneGroup}:week`,
      limit: input.profile.rateLimits.maxPerCompanyPerWeek,
      timestamps: sameCloneGroup.map(applicationTimestamp),
      windowMs: WEEK_MS,
      now
    })
  ];

  return summarizeChecks(checks);
}

function applicationTimestamp(application: ApplicationLimitRecord): string {
  return application.submittedAt ?? application.createdAt;
}

export function evaluateReplyRateLimits(input: {
  profile: CandidateProfile;
  conversations: Iterable<ConversationLimitRecord>;
  outboundMessages: Iterable<OutboundLimitRecord>;
  conversationId: string;
  excludeOutboundMessageId?: string;
  now?: Date;
}): RateLimitAssessment {
  const now = input.now ?? new Date();
  const conversationsById = new Map([...input.conversations].map((conversation) => [conversation.id, conversation]));
  const targetConversation = conversationsById.get(input.conversationId);
  const targetCompany = normalizeLimitKey(targetConversation?.companyName);
  const outboundMessages = [...input.outboundMessages].filter((message) => {
    if (message.id === input.excludeOutboundMessageId) {
      return false;
    }
    if (!countedOutboundStatuses.has(message.status)) {
      return false;
    }
    return Number.isFinite(Date.parse(message.createdAt));
  });
  const sameConversation = outboundMessages.filter((message) => message.message.conversationId === input.conversationId);
  const sameCompany = outboundMessages.filter((message) => {
    const conversation = conversationsById.get(message.message.conversationId);
    return targetCompany.length > 0 && normalizeLimitKey(conversation?.companyName) === targetCompany;
  });

  const checks = [
    buildWindowCheck({
      name: "replies_per_hour",
      key: `reply:${input.profile.userId}:hour`,
      limit: input.profile.rateLimits.applicationsPerHour,
      timestamps: outboundMessages.map((message) => message.createdAt),
      windowMs: HOUR_MS,
      now
    }),
    buildWindowCheck({
      name: "conversation_replies_per_day",
      key: `reply:${input.profile.userId}:conversation:${input.conversationId}:day`,
      limit: 1,
      timestamps: sameConversation.map((message) => message.createdAt),
      windowMs: DAY_MS,
      now
    }),
    buildWindowCheck({
      name: "company_replies_per_day",
      key: `reply:${input.profile.userId}:company:${targetCompany || "unknown"}:day`,
      limit: input.profile.rateLimits.maxPerCompanyPerDay,
      timestamps: sameCompany.map((message) => message.createdAt),
      windowMs: DAY_MS,
      now
    }),
    buildWindowCheck({
      name: "company_replies_per_week",
      key: `reply:${input.profile.userId}:company:${targetCompany || "unknown"}:week`,
      limit: input.profile.rateLimits.maxPerCompanyPerWeek,
      timestamps: sameCompany.map((message) => message.createdAt),
      windowMs: WEEK_MS,
      now
    })
  ];

  return summarizeChecks(checks);
}

function buildWindowCheck(input: {
  name: string;
  key: string;
  limit: number;
  timestamps: string[];
  windowMs: number;
  now: Date;
}): RateLimitCheck {
  const cutoff = input.now.getTime() - input.windowMs;
  const usedTimestamps = input.timestamps
    .map((timestamp) => Date.parse(timestamp))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > cutoff)
    .sort((left, right) => left - right);
  const used = usedTimestamps.length;
  const oldest = usedTimestamps[0];
  const resetAt = oldest ? oldest + input.windowMs : input.now.getTime() + input.windowMs;
  const remaining = Math.max(0, input.limit - used);
  const allowed = remaining > 0;
  return {
    name: input.name,
    key: input.key,
    allowed,
    limit: input.limit,
    used,
    remaining,
    resetAt: new Date(resetAt).toISOString(),
    reason: allowed ? null : `${input.name}_exhausted`
  };
}

function summarizeChecks(checks: RateLimitCheck[]): RateLimitAssessment {
  const reasons = checks.filter((check) => !check.allowed).map((check) => check.reason ?? `${check.name}_exhausted`);
  return {
    allowed: reasons.length === 0,
    checks,
    reasons
  };
}

function normalizeLimitKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-zа-яіїєґ0-9+#.\s-]/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
