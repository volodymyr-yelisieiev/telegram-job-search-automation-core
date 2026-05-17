import type { z } from "zod";
import type {
  applicationDraftSchema,
  candidateProfileSchema,
  coverLetterSchema,
  inboundMessageDraftSchema,
  normalizedJobSchema,
  outboundMessageSchema,
  providerHealthSchema,
  rawJobPayloadSchema,
  rawJobRefSchema,
  searchProfileSchema
} from "./schemas";

export const appModes = [
  "read_only",
  "dry_run_apply",
  "review_first",
  "controlled_auto_apply",
  "full_auto_apply",
  "conversation_only",
  "paused"
] as const;
export type AppMode = (typeof appModes)[number];

export const providerStatuses = [
  "stable",
  "degraded",
  "read_only",
  "apply_disabled",
  "blocked",
  "needs_review",
  "deprecated"
] as const;
export type ProviderStatus = (typeof providerStatuses)[number];

export const providerIds = ["hh", "robota", "telegram"] as const;
export type ProviderId = (typeof providerIds)[number] | string;

export const workFormats = ["remote", "hybrid", "office", "unknown"] as const;
export type WorkFormat = (typeof workFormats)[number];

export const compensationPeriods = ["hour", "month", "year", "unknown"] as const;
export type CompensationPeriod = (typeof compensationPeriods)[number];

export const policyDecisions = ["allow", "deny", "requires_user_approval", "requires_ops_review", "defer"] as const;
export type PolicyDecision = (typeof policyDecisions)[number];

export const applicationStatuses = [
  "application_prepared",
  "apply_queued",
  "apply_dry_run_passed",
  "applying",
  "applied",
  "apply_failed",
  "manual_review_required",
  "apply_blocked_by_policy",
  "apply_blocked_by_provider",
  "duplicate_prevented"
] as const;
export type ApplicationStatus = (typeof applicationStatuses)[number];

export const messageCategories = [
  "auto_reply",
  "acknowledgment",
  "recruiter_outreach",
  "clarifying_question",
  "request_for_details",
  "request_for_salary_expectation",
  "request_for_location",
  "request_for_notice_period",
  "test_assignment",
  "rejection",
  "interview_invitation",
  "scheduling_request",
  "spam_irrelevant",
  "unknown"
] as const;
export type MessageCategory = (typeof messageCategories)[number];

export const browserErrorCodes = [
  "page_fingerprint_mismatch",
  "selector_missing",
  "selector_ambiguous",
  "unexpected_modal",
  "navigation_timeout",
  "form_schema_changed",
  "confirmation_missing",
  "page_locale_changed",
  "javascript_error_detected",
  "network_error",
  "session_expired",
  "login_required",
  "auth_expired",
  "account_locked",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_terms_block",
  "captcha_required",
  "anti_automation_detected",
  "job_already_applied",
  "job_closed",
  "job_not_matching_policy",
  "resume_not_available",
  "cover_letter_policy_failed",
  "salary_policy_conflict",
  "location_policy_conflict",
  "facts_matrix_violation",
  "duplicate_company_thread_detected"
] as const;
export type ErrorCode = (typeof browserErrorCodes)[number];

export type CandidateProfile = z.infer<typeof candidateProfileSchema>;
export type SearchProfile = z.infer<typeof searchProfileSchema>;
export type NormalizedJob = z.infer<typeof normalizedJobSchema>;
export type RawJobRef = z.infer<typeof rawJobRefSchema>;
export type RawJobPayload = z.infer<typeof rawJobPayloadSchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
export type ApplicationDraft = z.infer<typeof applicationDraftSchema>;
export type CoverLetter = z.infer<typeof coverLetterSchema>;
export type InboundMessageDraft = z.infer<typeof inboundMessageDraftSchema>;
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

export interface ProviderCapabilities {
  jobDiscovery: boolean;
  jobDetailFetch: boolean;
  autoApply: boolean;
  inboxSync: boolean;
  recruiterReply: boolean;
  fileUpload: boolean;
  coverLetter: boolean;
  salaryFilter: boolean;
  remoteFilter: boolean;
  pagination: boolean;
  browserRequired: boolean;
  officialApiAvailable: boolean | "unknown";
  captchaExpected: boolean | "possible";
  deterministicFlowSupported: boolean;
}

export interface ProviderContext {
  now: Date;
  environment: "local" | "dev" | "staging" | "production";
}

export interface AuthContext extends ProviderContext {
  accountId: string;
}

export interface ProviderSearchPlan {
  providerId: string;
  searchProfileId: string;
  query: string;
  filters: Record<string, unknown>;
  maxPagesPerRun: number;
  maxJobsPerRun: number;
}

export interface DedupKey {
  providerJobKey: string;
  canonicalUrlKey: string | null;
  contentHashKey: string;
  companyRoleKey: string;
}

export interface DedupDecision {
  status: "duplicate" | "new" | "possible_duplicate";
  confidence: number;
  matchedEntities: Array<{ entityId: string; matchType: keyof DedupKey }>;
  actions: Array<"skip_apply" | "link_to_existing_company_thread" | "continue">;
}

export interface ScoreResult {
  score: number;
  interviewLikelihoodScore: number;
  decision: "rejected" | "shortlisted";
  reasons: string[];
  risks: string[];
  hardRejections: string[];
}

export interface PolicyCheck {
  name: string;
  result: "passed" | "failed" | "warning";
  severity?: "hard_deny" | "approval_required" | "warning";
  reason?: string;
}

export interface PolicyInput {
  action: "send_application" | "send_recruiter_reply" | "confirm_interview_slot";
  mode: AppMode;
  providerStatus: ProviderStatus;
  candidateProfile: CandidateProfile;
  score?: ScoreResult;
  dedupDecision?: DedupDecision;
  messageClassification?: MessageClassification;
  outboundMessage?: OutboundMessage;
  idempotencyKey?: string;
  proofReady: boolean;
  validationPassed: boolean;
  irreversibleActionsEnabled: boolean;
  rateLimitAvailable: boolean;
}

export interface PolicyOutput {
  decision: PolicyDecision;
  action: PolicyInput["action"];
  policyVersion: string;
  checks: PolicyCheck[];
  requiresUserApproval: boolean;
  reasons: string[];
}

export interface ResumeRoute {
  resumeId: string | null;
  confidence: number;
  rationale: string[];
}

export interface MessageClassification {
  category: MessageCategory;
  confidence: number;
  requiresReply: boolean;
  deadline: string | null;
  containsInterviewLink: boolean;
  proposedSlots: ProposedSlot[];
  sensitiveDataRequested: boolean;
  allowedAutoReply: boolean;
  reasons: string[];
}

export interface ProposedSlot {
  date: string;
  time: string;
  timezone: string;
}

export interface InterviewEvent {
  interviewId: string;
  jobId: string;
  companyId: string;
  conversationId: string;
  dateTime: string;
  timezone: string;
  format: "video_call" | "phone" | "onsite" | "unknown";
  link: string | null;
  recruiterName: string | null;
  status: "scheduled" | "pending_confirmation";
  summaryPackId: string;
}

export interface AuditEvent {
  eventId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actor: string;
  policyVersion: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ProofPack {
  proofPackId: string;
  provider: string;
  accountId: string;
  entityId: string;
  flowId: string;
  flowVersion: string;
  selectorPackVersion: string;
  startedAt: string;
  completedAt: string | null;
  preActionScreenshotKey: string | null;
  postActionScreenshotKey: string | null;
  domSnapshotBeforeKey: string | null;
  domSnapshotAfterKey: string | null;
  confirmationText: string | null;
  confirmationUrl: string | null;
  finalStatus: string;
  errorCode: ErrorCode | null;
  auditEventId: string | null;
}

export interface AuthResult {
  status: "authenticated" | "login_required" | "blocked";
  accountId: string;
  reason?: string;
}

export interface DryRunResult {
  status: "passed" | "failed" | "manual_review_required";
  reachedSubmitBoundary: boolean;
  proofPack: ProofPack;
  errors: ErrorCode[];
}

export interface ApplicationResult {
  status: "submitted" | "blocked" | "failed";
  providerConfirmationId: string | null;
  proofPack: ProofPack;
  errors: ErrorCode[];
}

export interface ReplayReport {
  flowRunId: string;
  status: "replayed" | "failed";
  summary: string;
  reproducedError: ErrorCode | null;
  recommendedAction: string;
}

export interface PrepareApplicationInput {
  job: NormalizedJob;
  profile: CandidateProfile;
  score: ScoreResult;
  resumeRoute: ResumeRoute;
  coverLetter: CoverLetter;
}

export interface ProviderModule {
  providerId: string;
  capabilities: ProviderCapabilities;
  healthcheck(ctx: ProviderContext): Promise<ProviderHealth>;
  authenticate(ctx: AuthContext): Promise<AuthResult>;
  compileSearchPlan(profile: SearchProfile): Promise<ProviderSearchPlan>;
  discoverJobs(plan: ProviderSearchPlan): Promise<RawJobRef[]>;
  fetchJob(ref: RawJobRef): Promise<RawJobPayload>;
  normalizeJob(raw: RawJobPayload): Promise<NormalizedJob>;
  deduplicateKey(job: NormalizedJob): Promise<DedupKey>;
  prepareApplication(input: PrepareApplicationInput): Promise<ApplicationDraft>;
  dryRunApplication(draft: ApplicationDraft): Promise<DryRunResult>;
  submitApplication(draft: ApplicationDraft): Promise<ApplicationResult>;
  syncInbox(accountId: string): Promise<InboundMessageDraft[]>;
  replayFlow(flowRunId: string): Promise<ReplayReport>;
}
