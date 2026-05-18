import { evaluateApplicationRateLimits, evaluateReplyRateLimits, type ApprovalRequest, type InMemoryDatabase, type QueueAdapter, type TaskRunStore } from "@job-search/db";
import {
  appModes,
  ConversationEngine,
  InMemoryCalendarAdapter,
  OutboundDispatchService,
  PolicyEngine,
  ProfileReadinessValidator,
  ResponsePriorityService,
  SchedulingDecisionEngine,
  stableHash,
  SubmitApprovalOrchestrator,
  ThreadContradictionChecker,
  type PolicyOutput,
  type ProviderCapabilities
} from "@job-search/domain";
import {
  renderAvailability,
  renderDigest,
  renderInterviewCard,
  renderJobCard,
  renderPipeline,
  renderProfile,
  renderProfileReadiness,
  renderStatus,
  supportedTelegramCommands
} from "@job-search/telegram-ui";

export interface TelegramCommandState {
  mode: string;
  activeProfileId: string;
}

export interface TelegramSourceCatalogItem {
  providerId: string;
  mode: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
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
  queue?: QueueAdapter;
  taskRunStore?: TaskRunStore;
  irreversibleActionsEnabled?: boolean;
  sourceCatalog?: TelegramSourceCatalogItem[];
}): Promise<string> {
  const [command = "", ...args] = input.text.trim().split(/\s+/);

  switch (command) {
    case "/start":
      return ["Telegram Job Search Automation Core", "Local-safe mode is active.", "Use /status or /pipeline."].join("\n");
    case "/status":
      return renderStatus({ ...input.db.status(), mode: input.state.mode });
    case "/pause":
      input.state.mode = "paused";
      input.db.setMode({ nextMode: "paused", actor: "telegram", reason: "/pause" });
      return "Mode changed to paused. New irreversible actions are blocked.";
    case "/resume_bot":
      input.state.mode = "review_first";
      input.db.setMode({ nextMode: "review_first", actor: "telegram", reason: "/resume_bot" });
      return "Mode changed to review_first. Prepared actions require approval.";
    case "/mode":
      if (args[0]) {
        if (!appModes.includes(args[0] as (typeof appModes)[number])) {
          return `Invalid mode: ${args[0]}. Supported modes: ${appModes.join(", ")}`;
        }
        input.state.mode = args[0];
        input.db.setMode({ nextMode: args[0] as (typeof appModes)[number], actor: "telegram", reason: "/mode" });
        return `Mode changed to ${input.state.mode}`;
      }
      return `Mode: ${input.state.mode}`;
    case "/pipeline":
      return renderPipeline(pipelineStats(input.db));
    case "/jobs_applied":
      return listApplications(input.db, "all");
    case "/jobs_applied_today":
      return listApplications(input.db, "today");
    case "/jobs_applied_week":
      return listApplications(input.db, "week");
    case "/job":
      return renderJob(input.db, args[0]);
    case "/responses":
      return listResponses(input.db);
    case "/availability":
      return renderAvailability({ profile: input.db.candidateProfile, interviews: [...input.db.interviewEvents.values()] });
    case "/interviews":
      return listInterviews(input.db, args[0]);
    case "/sources":
      return listSources(input.db, input.state, input.sourceCatalog);
    case "/profiles":
      return [
        renderProfile(input.db.candidateProfile),
        renderProfileReadiness(new ProfileReadinessValidator().validate(input.db.candidateProfile, input.state.mode as (typeof appModes)[number]))
      ].join("\n");
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
            .map((item) => {
              const approval = [...input.db.approvalRequests.values()].find(
                (request) => request.manualReviewId === item.id && request.status === "pending"
              );
              return `${item.severity}: ${item.id}${approval ? ` approval=${approval.id}` : ""} ${item.entityType}/${item.entityId} ${item.reasonCode} -> ${item.recommendedAction}`;
            })
            .join("\n")
        : "Manual review: empty";
    case "/dlq":
      return renderDlq(input.taskRunStore);
    case "/approve":
      return resolveReviewCommand(input, args[0], "approved");
    case "/reject":
      return resolveReviewCommand(input, args[0], "rejected");
    case "/defer":
      return resolveReviewCommand(input, args[0], "deferred");
    case "/digest_now":
      return renderDigest({
        responses: input.db.messageClassifications.size,
        manualReviewItems: input.db.manualReviewItems.size,
        interviews: input.db.interviewEvents.size,
        providerIssues: [...input.db.providerHealth.values()].filter((health) => health.status !== "stable").map((health) => health.providerId),
        pipelineStats: renderPipeline(pipelineStats(input.db))
      });
    case "/logs":
      return listLogs(input.db, args[0]);
    default:
      return `Unknown command. Supported commands:\n${supportedTelegramCommands.join("\n")}`;
  }
}

function renderDlq(taskRunStore: TaskRunStore | undefined): string {
  if (!taskRunStore) {
    return "DLQ: task-run store is not connected.";
  }
  const records = taskRunStore.listDeadLetters();
  if (records.length === 0) {
    return "DLQ: empty";
  }
  return records
    .map((record) => `${record.status}: ${record.id} ${record.queueName} ${record.errorCode}${record.assignedTo ? ` -> ${record.assignedTo}` : ""}`)
    .join("\n");
}

async function resolveReviewCommand(
  input: {
    db: InMemoryDatabase;
    queue?: QueueAdapter;
    irreversibleActionsEnabled?: boolean;
  },
  id: string | undefined,
  resolution: "approved" | "rejected" | "deferred"
): Promise<string> {
  if (!id) {
    return `Usage: /${resolution === "approved" ? "approve" : resolution === "rejected" ? "reject" : "defer"} <manual_review_id>`;
  }
  const existingItem = input.db.manualReviewItems.get(id);
  if (existingItem && resolution === "approved" && existingItem.entityType === "application") {
    return approveApplicationManualReview(input, existingItem.id, existingItem.entityId);
  }
  const item = input.db.resolveManualReview({ id, resolution, actor: "telegram", reason: `/${resolution}` });
  if (!item) {
    const approvalRequest = input.db.approvalRequests.get(id);
    if (approvalRequest && resolution !== "deferred") {
      if (approvalRequest.entityType === "outbound_message" && approvalRequest.requestedAction === "send_recruiter_reply") {
        return approveOutboundReply(input.db, approvalRequest, resolution);
      }
      if (approvalRequest.entityType === "interview" && approvalRequest.requestedAction === "confirm_interview_slot") {
        return approveInterviewConfirmation(input.db, approvalRequest, resolution, input.irreversibleActionsEnabled ?? false);
      }
      if (approvalRequest.entityType !== "application" || approvalRequest.requestedAction !== "send_application") {
        return `Approval request action is unsupported in Telegram: ${approvalRequest.requestedAction}`;
      }
      const application = input.db.applications.get(approvalRequest.entityId);
      if (!application) {
        return `Approval request application not found: ${approvalRequest.entityId}`;
      }
      const currentDraftHash = application.draftVariantKey;
      if (!currentDraftHash) {
        return `Approval request application draft hash missing: ${application.id}`;
      }
      let pendingSubmitPlan: ReturnType<SubmitApprovalOrchestrator["plan"]> | null = null;
      if (resolution === "approved") {
        const job = input.db.jobs.get(application.jobId) ?? null;
        const rateLimit = job
          ? evaluateApplicationRateLimits({
              profile: input.db.candidateProfile,
              applications: input.db.applications.values(),
              jobs: input.db.jobs.values(),
              job,
              providerId: application.providerId,
              excludeApplicationId: application.id
            })
          : null;
        const policy = buildTelegramSubmitPolicy({
          irreversibleActionsEnabled: input.irreversibleActionsEnabled ?? false,
          rateLimit,
          missingJob: !job
        });
        if (policy.decision !== "allow") {
          return `Approval request not approved: ${policy.reasons.join(", ") || policy.decision}`;
        }
        pendingSubmitPlan = new SubmitApprovalOrchestrator().plan({
          applicationId: application.id,
          approvalRequest: { ...approvalRequest, status: "approved" },
          currentDraftHash,
          policy,
          liveSubmitEnabled: input.irreversibleActionsEnabled ?? false
        });
        if (!pendingSubmitPlan.enqueue) {
          return `Approval request not approved: ${pendingSubmitPlan.reasons.join(", ")}`;
        }
      }
      const resolved = input.db.resolveApprovalRequest({
        id,
        resolution,
        actor: "telegram",
        draftHash: currentDraftHash,
        reason: `/${resolution}`
      });
      if (!resolved) {
        return `Approval request not found or draft hash mismatch: ${id}`;
      }
      let suffix = "";
      if (resolved.status === "approved" && resolved.entityType === "application" && resolved.requestedAction === "send_application") {
        const submitPlan = pendingSubmitPlan!;
        if (submitPlan.enqueue && input.queue) {
          input.db.setApplicationStatus({ id: application.id, status: "apply_queued", submittedAt: new Date().toISOString() });
          try {
            const task = await input.queue.enqueue(
              submitPlan.queueName,
              { applicationId: application.id, providerId: application.providerId, approvalRequestId: resolved.id, approvedDraftHash: currentDraftHash },
              { idempotencyKey: submitPlan.idempotencyKey, deduplicationKey: application.idempotencyKey }
            );
            suffix = ` Queued submit task: ${task.id}`;
          } catch (error) {
            input.db.setApplicationStatus({ id: application.id, status: "manual_review_required", submittedAt: null });
            suffix = ` Submit not queued: ${String(error)}`;
          }
        } else if (submitPlan.reasons.length > 0) {
          suffix = ` Submit not queued: ${submitPlan.reasons.join(", ")}`;
        }
      }
      return `Approval request ${resolved.status}: ${resolved.id}.${suffix}`;
    }
    return `Manual review not found: ${id}`;
  }
  return `Manual review ${resolution}: ${item.id}`;
}

async function approveApplicationManualReview(
  input: {
    db: InMemoryDatabase;
    queue?: QueueAdapter;
    irreversibleActionsEnabled?: boolean;
  },
  manualReviewId: string,
  applicationId: string
): Promise<string> {
  const application = input.db.applications.get(applicationId);
  if (!application) {
    return `Manual review application not found: ${applicationId}`;
  }
  const currentDraftHash = application.draftVariantKey;
  if (!currentDraftHash) {
    return `Manual review application draft hash missing: ${application.id}`;
  }
  const job = input.db.jobs.get(application.jobId) ?? null;
  const rateLimit = job
    ? evaluateApplicationRateLimits({
        profile: input.db.candidateProfile,
        applications: input.db.applications.values(),
        jobs: input.db.jobs.values(),
        job,
        providerId: application.providerId,
        excludeApplicationId: application.id
      })
    : null;
  const policy = buildTelegramSubmitPolicy({
    irreversibleActionsEnabled: input.irreversibleActionsEnabled ?? false,
    rateLimit,
    missingJob: !job
  });
  if (policy.decision !== "allow") {
    input.db.recordPolicyCheck({ entityType: "application", entityId: application.id, result: policy });
    return `Manual review not approved: ${policy.reasons.join(", ") || policy.decision}`;
  }
  if (!input.queue) {
    return "Manual review not approved: queue_missing";
  }
  const approvalRequest = input.db.createApprovalRequest({
    userId: input.db.candidateProfile.userId,
    entityType: "application",
    entityId: application.id,
    requestedAction: "send_application",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    policyDecisionId: null,
    draftHash: currentDraftHash,
    manualReviewId
  });
  const resolved = input.db.resolveApprovalRequest({
    id: approvalRequest.id,
    resolution: "approved",
    actor: "telegram",
    draftHash: currentDraftHash,
    reason: "/approve manual review"
  });
  if (!resolved || resolved.status !== "approved") {
    return `Manual review not approved: approval_request_not_resolved`;
  }
  const submitPlan = new SubmitApprovalOrchestrator().plan({
    applicationId: application.id,
    approvalRequest: resolved,
    currentDraftHash,
    policy,
    liveSubmitEnabled: input.irreversibleActionsEnabled ?? false
  });
  if (!submitPlan.enqueue) {
    return `Manual review not approved: ${submitPlan.reasons.join(", ")}`;
  }
  input.db.setApplicationStatus({ id: application.id, status: "apply_queued", submittedAt: new Date().toISOString() });
  let task;
  try {
    task = await input.queue.enqueue(
      submitPlan.queueName,
      { applicationId: application.id, providerId: application.providerId, approvalRequestId: resolved.id, approvedDraftHash: currentDraftHash },
      { idempotencyKey: submitPlan.idempotencyKey, deduplicationKey: application.idempotencyKey }
    );
  } catch (error) {
    input.db.setApplicationStatus({ id: application.id, status: "manual_review_required", submittedAt: null });
    return `Manual review approved but submit not queued: ${String(error)}`;
  }
  input.db.resolveManualReview({ id: manualReviewId, resolution: "approved", actor: "telegram", reason: "/approve queued submit" });
  return `Manual review approved: ${manualReviewId}. Queued submit task: ${task.id}`;
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

function buildTelegramSubmitPolicy(input: {
  irreversibleActionsEnabled: boolean;
  rateLimit: ReturnType<typeof evaluateApplicationRateLimits> | null;
  missingJob: boolean;
}): PolicyOutput {
  const reasons = [
    ...(input.irreversibleActionsEnabled ? [] : ["irreversible_actions_disabled"]),
    ...(input.rateLimit?.reasons ?? [])
  ];
  const allow = input.irreversibleActionsEnabled && (input.rateLimit?.allowed ?? true);
  const blocked = input.rateLimit?.allowed === false;
  return {
    decision: allow ? "allow" : blocked ? "deny" : "requires_user_approval",
    action: "send_application",
    policyVersion: "telegram-approval-resolution-v2",
    checks: [
      input.irreversibleActionsEnabled ? {
        name: "irreversible_actions_enabled",
        result: "passed"
      } : {
        name: "irreversible_actions_enabled",
        result: "warning",
        severity: "approval_required",
        reason: "irreversible_actions_disabled"
      },
      input.missingJob ? {
        name: "job_available_for_rate_limit",
        result: "warning",
        severity: "warning",
        reason: "job_missing_for_rate_limit_check"
      } : {
        name: "job_available_for_rate_limit",
        result: "passed"
      },
      ...(input.rateLimit?.checks.map((check) =>
        check.allowed
          ? { name: check.name, result: "passed" as const }
          : { name: check.name, result: "failed" as const, severity: "hard_deny" as const, reason: check.reason ?? `${check.name}_exhausted` }
      ) ?? [])
    ],
    requiresUserApproval: !allow && !blocked && !input.irreversibleActionsEnabled,
    reasons: allow ? [] : reasons
  };
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
    interviews: db.interviewEvents.size
  };
}

function listApplications(db: InMemoryDatabase, window: "all" | "today" | "week"): string {
  const now = Date.now();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const applications = [...db.applications.values()].filter((application) => {
    const createdAtMs = Date.parse(application.createdAt);
    if (window === "today") {
      return createdAtMs >= todayStart.getTime();
    }
    if (window === "week") {
      return createdAtMs >= now - 7 * 24 * 60 * 60 * 1000;
    }
    return true;
  });
  if (applications.length === 0) {
    return `Applications: none ${window === "all" ? "prepared or submitted" : `in ${window}`}.`;
  }
  return applications.map((application) => `${application.status}: ${application.providerId}/${application.externalJobId}`).join("\n");
}

function listSources(db: InMemoryDatabase, state: TelegramCommandState, catalog: TelegramSourceCatalogItem[] | undefined): string {
  const healthRecords = [...db.providerHealth.values()];
  if (healthRecords.length === 0) {
    return "Sources: no health checks yet.";
  }
  const catalogById = new Map((catalog ?? []).map((item) => [item.providerId, item]));
  return healthRecords
    .map((health) => {
      const source = catalogById.get(health.providerId);
      const runs = db.searchRuns.filter((run) => run.providerId === health.providerId);
      const latestRun = runs.at(-1);
      const failedRuns = runs.filter((run) => run.stopCondition !== "completed" || run.errors.length > 0).length;
      const failureRate = runs.length === 0 ? 0 : Math.round((failedRuns / runs.length) * 100);
      const latestCanary = [...db.canaryRuns.values()].filter((run) => run.providerId === health.providerId).at(-1);
      const capabilities = source
        ? Object.entries(source.capabilities)
            .filter(([, enabled]) => enabled === true)
            .map(([name]) => name)
            .join(",")
        : "unknown";
      return [
        `${health.providerId}: ${health.status}`,
        `mode=${source?.mode ?? state.mode}`,
        `enabled=${source?.enabled ?? "unknown"}`,
        `capabilities=${capabilities || "none"}`,
        `message=${health.message}`,
        `lastRun=${latestRun ? `${latestRun.stopCondition} raw=${latestRun.rawCount} normalized=${latestRun.normalizedCount}` : "none"}`,
        `failureRate=${failureRate}%`,
        `canary=${latestCanary?.status ?? "none"}`
      ].join(" ");
    })
    .join("\n");
}

function approveOutboundReply(db: InMemoryDatabase, approvalRequest: ApprovalRequest, resolution: "approved" | "rejected"): string {
  const existing = [...db.outboundMessages.values()].find((record) => record.message.idempotencyKey === approvalRequest.entityId);
  if (!existing) {
    return `Approval request outbound draft not found: ${approvalRequest.entityId}`;
  }
  const currentDraftHash = stableHash(existing.message.text);
  if (approvalRequest.draftHash !== currentDraftHash) {
    return "Approval request not approved: approval_draft_hash_mismatch";
  }
  if (resolution === "rejected") {
    const rejected = db.resolveApprovalRequest({ id: approvalRequest.id, resolution: "rejected", actor: "telegram", draftHash: currentDraftHash, reason: "/reject" });
    return rejected ? `Approval request rejected: ${rejected.id}` : `Approval request not found or draft hash mismatch: ${approvalRequest.id}`;
  }

  const validation = new ConversationEngine().validateOutbound(existing.message, db.candidateProfile);
  const contradiction = new ThreadContradictionChecker().check({
    draft: existing.message,
    previousMessages: [...db.inboundMessages.values()]
      .filter((message) => message.conversationId === existing.message.conversationId)
      .map((message) => ({ text: message.text }))
  });
  const rateLimit = evaluateReplyRateLimits({
    profile: db.candidateProfile,
    conversations: db.conversations.values(),
    outboundMessages: db.outboundMessages.values(),
    conversationId: existing.message.conversationId,
    excludeOutboundMessageId: existing.id
  });
  const policy = new PolicyEngine().check({
    action: "send_recruiter_reply",
    mode: db.systemMode,
    providerStatus: "stable",
    candidateProfile: db.candidateProfile,
    messageClassification: db.messageClassifications.get(existing.message.inboundMessageId)?.classification ?? {
      category: existing.message.category,
      confidence: 0.95,
      requiresReply: true,
      deadline: null,
      containsInterviewLink: false,
      proposedSlots: [],
      sensitiveDataRequested: false,
      allowedAutoReply: true,
      reasons: ["telegram approved reply"]
    },
    outboundMessage: existing.message,
    idempotencyKey: existing.message.idempotencyKey,
    proofReady: true,
    validationPassed: validation.valid && contradiction.valid,
    irreversibleActionsEnabled: false,
    rateLimitAvailable: rateLimit.allowed
  });
  if (policy.decision === "deny") {
    db.recordPolicyCheck({ entityType: "outbound_message", entityId: existing.id, result: policy });
    return `Approval request not approved: ${policy.reasons.join(", ") || "reply_policy_denied"}`;
  }
  const resolved = db.resolveApprovalRequest({ id: approvalRequest.id, resolution: "approved", actor: "telegram", draftHash: currentDraftHash, reason: "/approve" });
  if (!resolved || resolved.status !== "approved") {
    return `Approval request not found or draft hash mismatch: ${approvalRequest.id}`;
  }
  const result = new OutboundDispatchService().dispatch({
    message: existing.message,
    profile: db.candidateProfile,
    providerId: existing.providerId,
    accountId: existing.accountId,
    policy,
    approval: "approved",
    liveSendEnabled: false,
    irreversibleActionsEnabled: false
  });
  db.recordPolicyCheck({ entityType: "outbound_message", entityId: result.proof.outboundMessageId, result: policy });
  const record = db.recordOutboundDispatch({ providerId: existing.providerId, accountId: existing.accountId, message: existing.message, result, actor: "telegram" });
  return `Approval request approved: ${resolved.id}. Recorded outbound dispatch: ${record.status}`;
}

function approveInterviewConfirmation(
  db: InMemoryDatabase,
  approvalRequest: ApprovalRequest,
  resolution: "approved" | "rejected",
  irreversibleActionsEnabled: boolean
): string {
  const event = db.interviewEvents.get(approvalRequest.entityId);
  if (!event) {
    return `Approval request interview not found: ${approvalRequest.entityId}`;
  }
  const slot = slotFromInterviewEvent(event);
  const currentDraftHash = stableHash(JSON.stringify(slot));
  if (approvalRequest.draftHash !== currentDraftHash) {
    return "Approval request not approved: approval_draft_hash_mismatch";
  }
  if (resolution === "rejected") {
    const rejected = db.resolveApprovalRequest({ id: approvalRequest.id, resolution: "rejected", actor: "telegram", draftHash: currentDraftHash, reason: "/reject" });
    if (!rejected) {
      return `Approval request not found or draft hash mismatch: ${approvalRequest.id}`;
    }
    db.recordInterviewEvent({ ...event, status: "cancelled" });
    return `Approval request rejected: ${rejected.id}. Interview cancelled: ${event.interviewId}`;
  }
  const schedulingDecision = buildTelegramInterviewSchedulingDecision(db, slot, event.interviewId);
  const policy = new PolicyEngine().check({
    action: "confirm_interview_slot",
    mode: db.systemMode,
    providerStatus: "stable",
    candidateProfile: db.candidateProfile,
    schedulingDecision,
    idempotencyKey: `interview_confirm:${event.interviewId}`,
    proofReady: schedulingDecision.status === "confirm_slot",
    validationPassed: schedulingDecision.status === "confirm_slot",
    irreversibleActionsEnabled,
    rateLimitAvailable: Boolean(schedulingDecision.policyProof?.maxPerDaySatisfied)
  });
  db.recordPolicyCheck({ entityType: "interview_confirmation", entityId: event.interviewId, result: policy });
  if (schedulingDecision.status !== "confirm_slot" || policy.decision === "deny" || !irreversibleActionsEnabled) {
    return `Approval request not approved: ${policy.reasons.join(", ") || schedulingDecision.status}`;
  }
  const resolved = db.resolveApprovalRequest({ id: approvalRequest.id, resolution: "approved", actor: "telegram", draftHash: currentDraftHash, reason: "/approve" });
  if (!resolved || resolved.status !== "approved") {
    return `Approval request not found or draft hash mismatch: ${approvalRequest.id}`;
  }
  db.recordInterviewEvent({ ...event, status: "scheduled" });
  return `Approval request approved: ${resolved.id}. Interview scheduled: ${event.interviewId}`;
}

function buildTelegramInterviewSchedulingDecision(
  db: InMemoryDatabase,
  slot: { date: string; time: string; timezone: string },
  excludeInterviewId: string
): ReturnType<SchedulingDecisionEngine["decide"]> {
  const existingEvents = [...db.interviewEvents.values()].filter((event) => event.interviewId !== excludeInterviewId);
  const calendar = InMemoryCalendarAdapter.fromInterviewEvents(existingEvents, db.candidateProfile);
  return new SchedulingDecisionEngine(calendar).decide({
    proposedSlots: [slot],
    profile: db.candidateProfile,
    existingEvents
  });
}

function slotFromInterviewEvent(event: { dateTime: string; timezone: string }): { date: string; time: string; timezone: string } {
  return {
    date: event.dateTime.slice(0, 10),
    time: event.dateTime.slice(11, 16),
    timezone: event.timezone
  };
}

function listResponses(db: InMemoryDatabase): string {
  const records = [...db.messageClassifications.values()];
  if (records.length === 0) {
    return "Responses: fixture inbox sync is available; no live inbox connected.";
  }
  const recordsById = new Map(records.map((record) => [record.inboundMessageId, record]));
  return new ResponsePriorityService()
    .rank(records.map((record) => ({ inboundMessageId: record.inboundMessageId, classification: record.classification })))
    .map((item) => {
      const classification = recordsById.get(item.inboundMessageId)?.classification;
      const action = classification?.requiresReply ? "reply" : "fyi";
      const category = classification?.category ?? "unknown";
      return `${item.bucket}: ${item.inboundMessageId} ${category} priority=${item.priorityScore} action=${action}`;
    })
    .join("\n");
}

function listInterviews(db: InMemoryDatabase, interviewId: string | undefined): string {
  const interviews = [...db.interviewEvents.values()];
  if (interviews.length === 0) {
    return "Interviews: no scheduled interviews in local-safe state.";
  }
  if (interviewId) {
    const event = db.interviewEvents.get(interviewId);
    if (!event) {
      return `Interview not found: ${interviewId}`;
    }
    return renderInterviewCard(event, db.jobs.get(event.jobId) ?? null);
  }
  return interviews.map((event) => `${event.status}: ${event.interviewId} ${event.dateTime} ${event.timezone}`).join("\n");
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
