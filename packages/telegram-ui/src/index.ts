import type {
  AuditEvent,
  CandidateProfile,
  InterviewEvent,
  NormalizedJob,
  ProfileReadinessReport,
  ProviderHealth,
  ScoreResult
} from "@job-search/domain";

export interface StatusView {
  mode: string;
  jobs: number;
  applications: number;
  manualReviewItems: number;
  providerHealth: ProviderHealth[];
  latestAuditEvents: AuditEvent[];
}

export function renderStatus(view: StatusView): string {
  const providers = view.providerHealth.length
    ? view.providerHealth.map((health) => `${health.providerId}: ${health.status}`).join("\n")
    : "No provider health checks yet";

  return [
    "Status",
    `Mode: ${view.mode}`,
    `Jobs: ${view.jobs}`,
    `Applications: ${view.applications}`,
    `Manual review: ${view.manualReviewItems}`,
    "Providers:",
    providers
  ].join("\n");
}

export function renderPipeline(stats: {
  discovered: number;
  normalized: number;
  shortlisted: number;
  rejected: number;
  prepared: number;
  applied: number;
  interviews: number;
}): string {
  return [
    "Pipeline",
    `Discovered: ${stats.discovered}`,
    `Normalized: ${stats.normalized}`,
    `Shortlisted: ${stats.shortlisted}`,
    `Rejected: ${stats.rejected}`,
    `Prepared: ${stats.prepared}`,
    `Applied: ${stats.applied}`,
    `Interviews: ${stats.interviews}`
  ].join("\n");
}

export function renderJobCard(job: NormalizedJob, score: ScoreResult | null): string {
  return [
    `${score?.decision === "shortlisted" ? "Shortlisted" : "Job"}: ${job.title}`,
    `Company: ${job.companyName ?? "Unknown"}`,
    `Provider: ${job.sourceProvider}`,
    `Score: ${score ? `${score.score} / 100` : "not scored"}`,
    `Work: ${job.workFormat}`,
    `Compensation: ${formatCompensation(job)}`,
    `Reasons: ${score?.reasons.slice(0, 3).join("; ") ?? "not available"}`
  ].join("\n");
}

export function renderApplicationCard(input: {
  title: string;
  company: string | null;
  provider: string;
  score: number;
  resumeId: string;
  status: string;
  proofAvailable: boolean;
}): string {
  return [
    `Applied: ${input.title}`,
    `Company: ${input.company ?? "Unknown"}`,
    `Provider: ${input.provider}`,
    `Score: ${input.score} / 100`,
    `Resume: ${input.resumeId}`,
    `Status: ${input.status}`,
    `Proof: ${input.proofAvailable ? "available" : "missing"}`,
    "Actions: approve | reject | regenerate | manual_review",
    "Next: waiting for recruiter response"
  ].join("\n");
}

export function renderInterviewCard(event: InterviewEvent, job: NormalizedJob | null): string {
  return [
    "Interview Scheduled",
    `Company: ${job?.companyName ?? event.companyId}`,
    `Role: ${job?.title ?? "Unknown role"}`,
    `Time: ${event.dateTime} ${event.timezone}`,
    `Format: ${event.format}`,
    `Link: ${event.link ?? "pending"}`,
    `Recruiter: ${event.recruiterName ?? "unknown"}`,
    `Summary pack: ${event.summaryPackId}`,
    `Expectations: role context, prior messages, resume highlights and scheduling proof are attached when available`
  ].join("\n");
}

export function renderProfile(profile: CandidateProfile): string {
  return [
    `Profile: ${profile.displayName}`,
    `Roles: ${profile.targetTitles.join(", ")}`,
    `Stack: ${profile.primaryStack.join(", ")}`,
    `Location: ${profile.geography.currentLocation}`,
    `Default strategy: ${profile.strategies.default}`,
    `Active resumes: ${profile.resumes.filter((resume) => resume.active).length}`
  ].join("\n");
}

export function renderProfileReadiness(report: ProfileReadinessReport): string {
  return [
    `Profile readiness: ${report.ready ? "ready" : "blocked"}`,
    `Mode: ${report.mode}`,
    `Missing: ${report.missingFields.length ? report.missingFields.join(", ") : "none"}`,
    `Blockers: ${report.blockers.length ? report.blockers.join("; ") : "none"}`,
    `Warnings: ${report.warnings.length ? report.warnings.join("; ") : "none"}`
  ].join("\n");
}

export function renderAvailability(input: { profile: CandidateProfile; interviews: InterviewEvent[] }): string {
  const windows = Object.entries(input.profile.availability.defaultWindows)
    .map(([day, ranges]) => `${day}: ${ranges.join(", ")}`)
    .join("\n");
  const conflicts = input.interviews
    .filter((event) => event.status !== "cancelled")
    .map((event) => `${event.status}: ${event.dateTime} ${event.timezone}`)
    .slice(0, 5);
  return [
    "Availability",
    `Timezone: ${input.profile.availability.timezone}`,
    `Min notice: ${input.profile.availability.minNoticeHours}h`,
    `Max interviews/day: ${input.profile.availability.maxInterviewsPerDay}`,
    `Buffer: ${input.profile.availability.bufferMinutesBefore}/${input.profile.availability.bufferMinutesAfter} min`,
    "Windows:",
    windows || "none configured",
    "Current conflicts:",
    conflicts.length ? conflicts.join("\n") : "none"
  ].join("\n");
}

export function renderDigest(input: {
  responses: number;
  manualReviewItems: number;
  interviews: number;
  providerIssues: string[];
  pipelineStats: string;
}): string {
  return [
    "Digest",
    `New responses: ${input.responses}`,
    `Manual review: ${input.manualReviewItems}`,
    `Interviews: ${input.interviews}`,
    `Provider issues: ${input.providerIssues.length ? input.providerIssues.join(", ") : "none"}`,
    input.pipelineStats
  ].join("\n");
}

export const supportedTelegramCommands = [
  "/start",
  "/status",
  "/pause",
  "/resume_bot",
  "/mode",
  "/jobs_applied",
  "/jobs_applied_today",
  "/jobs_applied_week",
  "/job <id>",
  "/responses",
  "/availability",
  "/interviews [id]",
  "/pipeline",
  "/sources",
  "/profiles",
  "/set_profile <name>",
  "/blacklist_company <name>",
  "/whitelist_company <name>",
  "/retry_provider <provider>",
  "/manual_review",
  "/dlq",
  "/approve <manual_review_id>",
  "/reject <manual_review_id>",
  "/defer <manual_review_id>",
  "/digest_now",
  "/logs <entity_id>"
] as const;

function formatCompensation(job: NormalizedJob): string {
  if (job.compensationMin === null && job.compensationMax === null) {
    return "not specified";
  }
  const range = [job.compensationMin, job.compensationMax].filter((value): value is number => value !== null).join("-");
  return `${range} ${job.compensationCurrency ?? ""}/${job.compensationPeriod}`.trim();
}
