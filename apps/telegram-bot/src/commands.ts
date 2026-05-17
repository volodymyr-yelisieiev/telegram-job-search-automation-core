import type { InMemoryDatabase } from "@job-search/db";
import { appModes } from "@job-search/domain";
import { renderDigest, renderJobCard, renderPipeline, renderProfile, renderStatus, supportedTelegramCommands } from "@job-search/telegram-ui";

export interface TelegramCommandState {
  mode: string;
  activeProfileId: string;
}

export function createTelegramCommandState(initialMode = "review_first"): TelegramCommandState {
  return {
    mode: initialMode,
    activeProfileId: "backend-node-main"
  };
}

export async function handleTelegramCommand(input: {
  text: string;
  db: InMemoryDatabase;
  state: TelegramCommandState;
}): Promise<string> {
  const [command = "", ...args] = input.text.trim().split(/\s+/);

  switch (command) {
    case "/start":
      return ["Telegram Job Search Automation Core", "Local-safe mode is active.", "Use /status or /pipeline."].join("\n");
    case "/status":
      return renderStatus({ ...input.db.status(), mode: input.state.mode });
    case "/pause":
      input.state.mode = "paused";
      return "Mode changed to paused. New irreversible actions are blocked.";
    case "/resume_bot":
      input.state.mode = "review_first";
      return "Mode changed to review_first. Prepared actions require approval.";
    case "/mode":
      if (args[0]) {
        if (!appModes.includes(args[0] as (typeof appModes)[number])) {
          return `Invalid mode: ${args[0]}. Supported modes: ${appModes.join(", ")}`;
        }
        input.state.mode = args[0];
        return `Mode changed to ${input.state.mode}`;
      }
      return `Mode: ${input.state.mode}`;
    case "/pipeline":
      return renderPipeline(pipelineStats(input.db));
    case "/jobs_applied":
    case "/jobs_applied_today":
    case "/jobs_applied_week":
      return listApplications(input.db);
    case "/job":
      return renderJob(input.db, args[0]);
    case "/responses":
      return input.db.messageClassifications.size
        ? [...input.db.messageClassifications.values()]
            .map((record) => `${record.classification.category}: ${record.inboundMessageId}`)
            .join("\n")
        : "Responses: fixture inbox sync is available; no live inbox connected.";
    case "/interviews":
      return input.db.interviewEvents.size
        ? [...input.db.interviewEvents.values()].map((event) => `${event.status}: ${event.dateTime} ${event.timezone}`).join("\n")
        : "Interviews: no scheduled interviews in local-safe state.";
    case "/sources":
      return input.db.providerHealth.size
        ? [...input.db.providerHealth.values()].map((health) => `${health.providerId}: ${health.status}`).join("\n")
        : "Sources: no health checks yet.";
    case "/profiles":
      return renderProfile(input.db.candidateProfile);
    case "/set_profile":
      if (!args[0]) {
        return "Usage: /set_profile <name>";
      }
      if (args[0] !== input.db.candidateProfile.id) {
        return `Profile not found: ${args[0]}`;
      }
      input.state.activeProfileId = args[0];
      return `Active profile: ${input.state.activeProfileId}`;
    case "/blacklist_company":
      return createCommandReview(input.db, "blacklist_company", args.join(" "), "Review company blacklist request");
    case "/whitelist_company":
      return createCommandReview(input.db, "whitelist_company", args.join(" "), "Review company whitelist request");
    case "/retry_provider":
      return createCommandReview(input.db, "retry_provider", args[0] ?? "", "Review provider retry request");
    case "/manual_review":
      return input.db.manualReviewItems.size
        ? [...input.db.manualReviewItems.values()]
            .map((item) => `${item.severity}: ${item.reasonCode} -> ${item.recommendedAction}`)
            .join("\n")
        : "Manual review: empty";
    case "/digest_now":
      return renderDigest({
        responses: 0,
        manualReviewItems: input.db.manualReviewItems.size,
        interviews: 0,
        providerIssues: [...input.db.providerHealth.values()].filter((health) => health.status !== "stable").map((health) => health.providerId),
        pipelineStats: renderPipeline(pipelineStats(input.db))
      });
    case "/logs":
      return listLogs(input.db, args[0]);
    default:
      return `Unknown command. Supported commands:\n${supportedTelegramCommands.join("\n")}`;
  }
}

function createCommandReview(db: InMemoryDatabase, command: string, value: string, action: string): string {
  if (value.trim().length === 0) {
    return `Usage: /${command} <value>`;
  }
  const item = db.createManualReview({
    userId: db.candidateProfile.userId,
    entityType: "telegram_command",
    entityId: `${command}:${value.trim()}`,
    reasonCode: command,
    severity: "low",
    recommendedAction: `${action}: ${value.trim()}`
  });
  return `Queued for manual review: ${item.reasonCode} (${item.id})`;
}

function pipelineStats(db: InMemoryDatabase) {
  const scores = [...db.jobScores.values()];
  return {
    discovered: db.jobs.size,
    normalized: db.jobs.size,
    shortlisted: scores.filter((score) => score.decision === "shortlisted").length,
    rejected: scores.filter((score) => score.decision === "rejected").length,
    prepared: db.applications.size,
    applied: [...db.applications.values()].filter((application) => application.status === "applied").length,
    interviews: 0
  };
}

function listApplications(db: InMemoryDatabase): string {
  const applications = [...db.applications.values()];
  if (applications.length === 0) {
    return "Applications: none prepared or submitted.";
  }
  return applications.map((application) => `${application.status}: ${application.providerId}/${application.externalJobId}`).join("\n");
}

function renderJob(db: InMemoryDatabase, jobId: string | undefined): string {
  if (!jobId) {
    return "Usage: /job <id>";
  }
  const job = db.jobs.get(jobId);
  if (!job) {
    return `Job not found: ${jobId}`;
  }
  return renderJobCard(job, db.jobScores.get(job.id) ?? null);
}

function listLogs(db: InMemoryDatabase, entityId: string | undefined): string {
  const events = entityId ? db.auditEvents.filter((event) => event.entityId === entityId) : db.auditEvents.slice(-10);
  if (events.length === 0) {
    return "Logs: no audit events found.";
  }
  return events.map((event) => `${event.timestamp} ${event.eventType} ${event.entityType}/${event.entityId}`).join("\n");
}
