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
  strategy?: "aggressive" | "balanced" | "selective";
  scoreProfileVersion?: string;
  factorWeights?: Record<string, number>;
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
  schedulingDecision?: SchedulingDecision;
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

export interface RateLimitDecision {
  key: string;
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export interface DataQualityReport {
  totalJobs: number;
  averageExtractionConfidence: number;
  lowConfidenceJobIds: string[];
  duplicateLikeJobIds: string[];
  shortlisted: number;
  rejected: number;
  providerBreakdown: Record<string, { jobs: number; averageExtractionConfidence: number }>;
}

export interface SubmitGuardResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; reason: string | null }>;
}

export interface ReplyDraftResult {
  outboundMessage: OutboundMessage | null;
  validation: { valid: boolean; riskFlags: string[] };
  templateId: string | null;
  reason: string | null;
}

export interface AnalyticsFunnelReport {
  discovered: number;
  shortlisted: number;
  preparedApplications: number;
  applied: number;
  responses: number;
  interviews: number;
  shortlistRate: number;
  applyRate: number;
  interviewRate: number;
}

export interface AnalyticsDimensionedFunnelReport {
  dimensions: Record<string, AnalyticsFunnelReport>;
}

export interface ProviderReliabilityScore {
  providerId: string;
  score: number;
  recommendedStatus: "stable" | "read_only" | "apply_disabled" | "needs_review";
  signals: {
    jobVolume: number;
    averageExtractionConfidence: number;
    responseRate: number;
    canarySuccessRate: number;
    failureRate: number;
    automationRisk: number;
  };
  reasons: string[];
}

export interface TemplateExperimentAssignment {
  experimentId: string;
  templateId: string;
  variantId: string;
  eligible: boolean;
  guardrails: Array<{ name: string; passed: boolean; reason: string | null }>;
}

export interface ProfileReadinessReport {
  profileId: string;
  mode: AppMode;
  ready: boolean;
  blockers: string[];
  warnings: string[];
  missingFields: string[];
}

export interface ResumeRoute {
  resumeId: string | null;
  confidence: number;
  rationale: string[];
}

export interface MessageClassification {
  category: MessageCategory;
  confidence: number;
  priorityScore?: number;
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
  durationMinutes?: number;
  confidence?: number;
  sourceText?: string;
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
  status: "scheduled" | "pending_confirmation" | "cancelled";
  summaryPackId: string;
}

export interface CalendarBusyWindow {
  id: string;
  source: "interview_events" | "external_calendar" | "manual_block";
  start: string;
  end: string;
  timezone: string;
  title: string | null;
}

export interface SchedulingDecision {
  status: "confirm_slot" | "propose_alternatives" | "ask_clarification" | "manual_review";
  selectedSlot: ProposedSlot | null;
  alternatives: ProposedSlot[];
  reasons: string[];
  policyProof: {
    timezoneMatched: boolean;
    minNoticeSatisfied: boolean;
    insideAvailabilityWindow: boolean;
    noCalendarConflict: boolean;
    maxPerDaySatisfied: boolean;
    proofHash?: string;
  };
}

export interface OutboundDispatchProof {
  proofId: string;
  outboundMessageId: string;
  providerId: string;
  accountId: string;
  conversationId: string;
  inboundMessageId: string;
  idempotencyKey: string;
  transport: "fixture" | "provider" | "telegram" | "calendar";
  status: "proof_recorded" | "queued_for_review" | "blocked" | "sent";
  textHash: string;
  validationHash: string;
  policyDecision: PolicyDecision;
  createdAt: string;
  deliveredAt: string | null;
}

export interface OutboundDispatchResult {
  status: "dry_run_recorded" | "queued_for_review" | "blocked" | "sent";
  proof: OutboundDispatchProof;
  deliveryId: string | null;
  errors: string[];
}

export type SecretBackend = "env" | "aws_secrets_manager" | "gcp_secret_manager" | "vault" | "local_encrypted_file";

export interface SecretReference {
  id: string;
  providerId: string;
  purpose: "provider_api" | "browser_session" | "telegram_bot" | "llm_api" | "calendar";
  backend: SecretBackend;
  reference: string;
  createdAt: string;
  rotatedAt: string | null;
  expiresAt: string | null;
}

export interface SecretValidationResult {
  valid: boolean;
  riskFlags: string[];
  safeReference: Omit<SecretReference, "reference"> & { reference: string };
}

export type RetentionArtifactType =
  | "raw_job_payload"
  | "dom_snapshot"
  | "screenshot"
  | "trace"
  | "llm_prompt"
  | "recruiter_message"
  | "proof_pack"
  | "audit_log";

export interface RetentionPolicyRule {
  artifactType: RetentionArtifactType;
  retentionDays: number;
  hardDelete: boolean;
}

export interface RetentionArtifact {
  artifactId: string;
  artifactType: RetentionArtifactType;
  createdAt: string;
  retentionUntil: string | null;
  legalHold: boolean;
}

export interface RetentionDecision {
  artifactId: string;
  artifactType: RetentionArtifactType;
  action: "retain" | "purge" | "legal_hold";
  reason: string;
  purgeAfter: string | null;
}

export interface ReleaseGateCheck {
  name: string;
  passed: boolean;
  reason: string | null;
}

export interface ReleaseGateReport {
  readyForLiveAutomation: boolean;
  checks: ReleaseGateCheck[];
  blockers: string[];
}

export const releaseEvidenceTypes = [
  "live_credentials_configured",
  "external_secrets_backend",
  "live_canary_passed",
  "provider_submit_proof_ready",
  "calendar_integration_ready",
  "seven_day_soak_passed",
  "outbound_dispatch_proof_ready"
] as const;
export type ReleaseEvidenceType = (typeof releaseEvidenceTypes)[number];

export interface ReleaseEvidenceRecord {
  evidenceId: string;
  evidenceType: ReleaseEvidenceType;
  providerId: string | null;
  status: "passed" | "failed";
  observedAt: string;
  expiresAt: string | null;
  source: string;
  metadata: Record<string, unknown>;
}

export interface ReleaseEvidenceSummary {
  liveCredentialsConfigured: boolean;
  externalSecretsBackend: boolean;
  liveCanariesPassing: boolean;
  providerSubmitProofReady: boolean;
  calendarIntegrationReady: boolean;
  sevenDaySoakPassed: boolean;
  outboundDispatchProofReady: boolean;
  acceptedEvidenceIds: string[];
  invalidEvidenceIds: string[];
  blockers: string[];
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
  runtimeKind?: "fixture" | "live";
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
