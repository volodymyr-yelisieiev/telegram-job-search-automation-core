import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { RuntimeConfig } from "@job-search/config";
import {
  DataQualityService,
  AnalyticsService,
  ArtifactAccessPolicy,
  ConversationEngine,
  FollowUpScheduler,
  InterviewCoordinator,
  InMemoryCalendarAdapter,
  OutboundDispatchService,
  appModes,
  PolicyEngine,
  ProfileReadinessValidator,
  ResponsePriorityService,
  ReleaseEvidenceEvaluator,
  ReleaseGateEvaluator,
  RetentionEnforcementPlanner,
  RetentionPolicyEngine,
  SchedulingDecisionEngine,
  SubmitApprovalOrchestrator,
  ThreadContradictionChecker,
  createAuditEvent,
  releaseEvidenceTypes,
  stableHash,
  type AppMode,
  type MessageCategory,
  type OutboundMessage,
  type PolicyInput,
  type PolicyOutput,
  type ProviderStatus,
  type ReleaseEvidenceType
} from "@job-search/domain";
import {
  evaluateApplicationRateLimits,
  evaluateReplyRateLimits,
  InMemoryTaskRunStore,
  PostgresRuntimeDatabase,
  createRuntimeQueue,
  localDb,
  queueNames,
  queuePolicies,
  type InMemoryDatabase,
  type OutboundMessageRecord,
  type QueueAdapter,
  type TaskRunStore
} from "@job-search/db";
import { renderDigest, renderJobCard, renderPipeline, renderProfile, renderProfileReadiness, renderStatus } from "@job-search/telegram-ui";
import { buildDashboardDefinitions, createLogger, evaluateCoreAlerts, MetricsRegistry } from "@job-search/observability";
import {
  buildProviderReadinessEvidenceFromReleaseEvidence,
  collectProviderReadinessReports,
  createProviderOnboardingChecklist,
  createRuntimeProviderRegistryWithOverrides,
  fixtureJobsByProvider,
  pageFingerprints,
  selectorPacks,
  type ProviderRegistry
} from "@job-search/providers";
import { createTelegramCommandState, handleTelegramCommand } from "../../telegram-bot/src/commands";
import { runLocalPipeline } from "./runtime";

export interface ServerDependencies {
  config: RuntimeConfig;
  db?: InMemoryDatabase;
  registry?: ProviderRegistry;
  queue?: QueueAdapter;
  taskRunStore?: TaskRunStore;
}

export async function buildServer(deps: ServerDependencies) {
  const logger = createLogger("api");
  const metrics = new MetricsRegistry();
  metrics.setGauge("api_up", { service: "api" }, 1);
  const db = deps.db ?? localDb;
  if (!(db instanceof PostgresRuntimeDatabase)) {
    db.systemMode = deps.config.app.mode;
  }
  const registry = deps.registry ?? createRuntimeProviderRegistryWithOverrides(deps.config.providers.map((provider) => JSON.parse(JSON.stringify(provider))));
  const taskRunStore = deps.taskRunStore ?? (db instanceof PostgresRuntimeDatabase ? db.taskRunStore : new InMemoryTaskRunStore());
  const queue = deps.queue ?? createRuntimeQueue({ backend: deps.config.queue.backend, redisUrl: deps.config.queue.redisUrl, taskRunStore });
  const telegramCommandState = createTelegramCommandState(db.systemMode);
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: deps.config.api.corsOrigins });

  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?")[0] ?? request.url;
    if (requestPath === "/health") {
      return;
    }
    if (requestPath === "/telegram/webhook") {
      if (isTelegramWebhookAuthorized(request, deps.config.telegram.webhookSecret)) {
        return;
      }
      return reply.code(401).send({ error: "unauthorized_telegram_webhook" });
    }
    if (!isAuthorized(request, deps.config.api.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "control-plane-api",
    mode: db.systemMode,
    irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled
  }));

  app.get("/status", async () => db.status());

  app.get("/status/telegram", async () => renderStatus(db.status()));

  app.post<{
    Body: TelegramWebhookUpdate;
  }>("/telegram/webhook", async (request) => {
    const message = request.body?.message;
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    const senderId = message?.from?.id === undefined ? "" : String(message.from.id);
    const chatId = message?.chat?.id;
    if (!text.startsWith("/")) {
      return { ok: true, accepted: true, ignored: true, reason: text ? "non_command_text" : "non_text_message" };
    }
    if (deps.config.telegram.allowedUserIds.length > 0 && !deps.config.telegram.allowedUserIds.includes(senderId)) {
      metrics.increment("telegram_webhook_updates_total", { status: "denied" });
      return { ok: true, accepted: true, ignored: true, reason: "sender_not_allowed" };
    }
    telegramCommandState.mode = db.systemMode;
    const response = await handleTelegramCommand({
      text,
      db,
      state: telegramCommandState,
      queue,
      taskRunStore,
      irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled
    });
    await flushRuntimePersistence(db);
    metrics.increment("telegram_webhook_updates_total", { status: "handled" });
    if (chatId === undefined || chatId === null) {
      return { ok: true, accepted: true, responseHash: stableHash(response), responseLength: response.length };
    }
    return {
      method: "sendMessage",
      chat_id: chatId,
      text: truncateTelegramMessage(response),
      disable_web_page_preview: true
    };
  });

  app.get("/mode", async () => ({
    mode: db.systemMode,
    supportedModes: appModes
  }));

  app.post<{ Body: { mode?: string; reason?: string } }>("/mode", async (request, reply) => {
    const nextMode = request.body.mode;
    if (!nextMode || !appModes.includes(nextMode as AppMode)) {
      await reply.code(400).send({ error: "invalid_mode", supportedModes: appModes });
      return;
    }
    const mode = db.setMode({
      nextMode: nextMode as AppMode,
      actor: "api",
      reason: request.body.reason ?? null
    });
    await flushRuntimePersistence(db);
    return { mode };
  });

  app.post("/ingest/run", async () => {
    const result = await runLocalPipeline({ db, registry, config: deps.config });
    metrics.increment("local_pipeline_runs_total", { status: "completed" });
    logger.info("local_pipeline_completed", result);
    return result;
  });

  app.get("/pipeline", async () => {
    const scores = [...db.jobScores.values()];
    const stats = {
      discovered: db.jobs.size,
      normalized: db.jobs.size,
      shortlisted: scores.filter((score) => score.decision === "shortlisted").length,
      rejected: scores.filter((score) => score.decision === "rejected").length,
      prepared: db.applications.size,
      applied: [...db.applications.values()].filter((application) => application.status === "applied").length,
      interviews: db.interviewEvents.size
    };
    return {
      stats,
      text: renderPipeline(stats)
    };
  });

  app.get("/data-quality", async () =>
    new DataQualityService().evaluate({
      jobs: [...db.jobs.values()],
      dedupDecisions: db.dedupDecisions,
      scores: db.jobScores
    })
  );

  app.get("/analytics", async () => {
    const analytics = new AnalyticsService();
    const jobs = [...db.jobs.values()];
    const applications = [...db.applications.values()];
    const funnel = analytics.funnel({
      jobs,
      scores: db.jobScores,
      applications,
      responses: db.messageClassifications.size,
      interviews: db.interviewEvents.size
    });
    return {
      ...funnel,
      dimensioned: analytics.dimensionedFunnel({
        jobs,
        scores: db.jobScores,
        applications,
        responses: [
          ...[...db.inboundMessages.values()].map((message) => {
            const linkedJob = [...db.jobs.values()].find((job) => job.externalId === message.linkedJobExternalId || job.id === message.linkedJobExternalId);
            return linkedJob
              ? { providerId: message.providerId, jobId: linkedJob.id, createdAt: message.receivedAt }
              : { providerId: message.providerId, createdAt: message.receivedAt };
          }),
          ...[...db.outboundMessages.values()].map((message) => {
            const linkedExternalId = [...db.inboundMessages.values()].find((inbound) => inbound.id === message.message.inboundMessageId)?.linkedJobExternalId;
            const linkedJob = [...db.jobs.values()].find((job) => job.externalId === linkedExternalId || job.id === linkedExternalId);
            return {
              providerId: message.providerId,
              templateId: templateIdFromReplyIdempotencyKey(message.message.idempotencyKey),
              createdAt: message.createdAt,
              ...(linkedJob ? { jobId: linkedJob.id } : {})
            };
          })
        ],
        interviews: [...db.interviewEvents.values()].map((event) => ({ jobId: event.jobId, createdAt: event.dateTime })),
        dimensions: ["provider", "strategy", "company", "role", "resume", "template", "time_window"]
      }),
      providerReliability: [...new Set(jobs.map((job) => job.sourceProvider))].map((providerId) =>
        analytics.providerReliability({
          providerId,
          jobVolume: jobs.filter((job) => job.sourceProvider === providerId).length,
          averageExtractionConfidence:
            Math.round(
              jobs.filter((job) => job.sourceProvider === providerId).reduce((sum, job) => sum + job.extractionConfidence, 0) /
                Math.max(1, jobs.filter((job) => job.sourceProvider === providerId).length)
            ),
          responseRate: 0,
          canaryRuns: [...db.canaryRuns.values()]
            .filter((run) => run.providerId === providerId)
            .map((run) => ({ status: run.status === "passed" ? "passed" : "failed" })),
          flowFailures: 0,
          totalFlows: Math.max(1, applications.filter((application) => application.providerId === providerId).length),
          blockingIncidents: 0
        })
      )
    };
  });

  app.get("/providers", async () => {
    const providers = registry.list();
    const health = await Promise.all(
      providers.map((provider) => provider.healthcheck({ now: new Date(), environment: deps.config.app.environment }))
    );
    for (const item of health) {
      db.updateProviderHealth(item);
    }
    const readiness = await collectProviderReadinessReports({
      registry,
      environment: deps.config.app.environment,
      canaryRuns: db.canaryRuns.values(),
      replayReports: db.replayReports.values(),
      providerConfigs: deps.config.providers
    });
    const readinessById = new Map(readiness.map((item) => [item.providerId, item]));
    const configById = new Map(deps.config.providers.map((provider) => [provider.providerId, provider]));
    return providers.map((provider, index) => {
      const providerConfig = configById.get(provider.providerId);
      return {
        providerId: provider.providerId,
        mode: db.systemMode,
        health: health[index]!,
        capabilities: provider.capabilities,
        config: {
          enabled: providerConfig?.enabled ?? true,
          statusOverride: providerConfig?.statusOverride ?? null,
          queries: providerConfig?.queries ?? null,
          filters: providerConfig?.filters ?? null,
          maxPagesPerRun: providerConfig?.maxPagesPerRun ?? null,
          maxJobsPerRun: providerConfig?.maxJobsPerRun ?? null,
          concurrency: providerConfig?.concurrency ?? null
        },
        readiness: readinessById.get(provider.providerId) ?? null
      };
    });
  });

  app.get("/providers/readiness", async () =>
    collectProviderReadinessReports({
      registry,
      environment: deps.config.app.environment,
      canaryRuns: db.canaryRuns.values(),
      replayReports: db.replayReports.values(),
      providerConfigs: deps.config.providers
    })
  );

  app.get("/providers/onboarding", async () => {
    const readiness = await collectProviderReadinessReports({
      registry,
      environment: deps.config.app.environment,
      canaryRuns: db.canaryRuns.values(),
      replayReports: db.replayReports.values(),
      providerConfigs: deps.config.providers
    });
    const readinessById = new Map(readiness.map((report) => [report.providerId, report]));
    return registry.list().map((provider) => {
      const report = readinessById.get(provider.providerId);
      const blockers = new Set(report?.blockers ?? []);
      return createProviderOnboardingChecklist({
        providerId: provider.providerId,
        owner: "provider-automation",
        capabilities: provider.capabilities,
        fixtureCount: fixtureJobsByProvider[provider.providerId]?.length ?? 0,
        selectorPackVersion: selectorPacks[provider.providerId]?.version ?? null,
        fingerprintCount: pageFingerprints[provider.providerId]?.length ?? 0,
        canaryPassed: Boolean(report) && !blockers.has("canary_missing") && !blockers.has("canary_failed"),
        dryRunSubmitBoundaryPassed: Boolean(report) && !blockers.has("dry_run_submit_boundary_missing"),
        replayAvailable: Boolean(report) && !blockers.has("replay_missing"),
        manualFallbackAvailable: Boolean(report) && !blockers.has("manual_fallback_missing"),
        disableSwitchAvailable: Boolean(report) && !blockers.has("disable_switch_missing"),
        providerPolicyReviewed: false,
        snippetReviewComplete: false
      });
    });
  });

  app.get("/release-evidence", async () => ({
    records: [...db.releaseEvidence.values()],
    summary: new ReleaseEvidenceEvaluator().summarize({
      records: [...db.releaseEvidence.values()],
      expectedProviderIds: registry.list().map((provider) => provider.providerId)
    })
  }));

  app.post<{
    Body: {
      evidenceType?: string;
      providerId?: string | null;
      status?: "passed" | "failed";
      observedAt?: string;
      expiresAt?: string | null;
      source?: string;
      metadata?: Record<string, unknown>;
    };
  }>("/release-evidence", async (request, reply) => {
    const evidenceType = request.body.evidenceType;
    if (!evidenceType || !releaseEvidenceTypes.includes(evidenceType as ReleaseEvidenceType)) {
      await reply.code(400).send({ error: "invalid_evidence_type", supportedTypes: releaseEvidenceTypes });
      return;
    }
    if (request.body.status && !["passed", "failed"].includes(request.body.status)) {
      await reply.code(400).send({ error: "invalid_evidence_status" });
      return;
    }
    if (!request.body.source?.trim()) {
      await reply.code(400).send({ error: "source_required" });
      return;
    }
    const candidateRecord = {
      evidenceId: "candidate",
      evidenceType: evidenceType as ReleaseEvidenceType,
      providerId: request.body.providerId ?? null,
      status: request.body.status ?? "passed",
      observedAt: request.body.observedAt ?? new Date().toISOString(),
      expiresAt: request.body.expiresAt ?? null,
      source: request.body.source,
      metadata: request.body.metadata ?? {}
    };
    if (Number.isNaN(Date.parse(candidateRecord.observedAt))) {
      await reply.code(400).send({ error: "invalid_observedAt" });
      return;
    }
    if (candidateRecord.expiresAt !== null) {
      const expiresAtMs = Date.parse(candidateRecord.expiresAt);
      if (Number.isNaN(expiresAtMs)) {
        await reply.code(400).send({ error: "invalid_expiresAt" });
        return;
      }
      if (candidateRecord.status === "passed" && expiresAtMs <= Date.now()) {
        await reply.code(400).send({ error: "expired_release_evidence" });
        return;
      }
    }
    if (candidateRecord.status === "passed") {
      const failures = new ReleaseEvidenceEvaluator().validateRecord({
        record: candidateRecord,
        expectedProviderIds: registry.list().map((provider) => provider.providerId)
      });
      if (failures.length > 0) {
        await reply.code(400).send({ error: "invalid_release_evidence_metadata", failures });
        return;
      }
    }
    const record = db.recordReleaseEvidence({
      evidenceType: candidateRecord.evidenceType,
      providerId: candidateRecord.providerId,
      status: candidateRecord.status,
      expiresAt: candidateRecord.expiresAt,
      source: candidateRecord.source,
      metadata: candidateRecord.metadata,
      ...(request.body.observedAt ? { observedAt: candidateRecord.observedAt } : {})
    });
    await flushRuntimePersistence(db);
    return record;
  });

  app.get("/release-gates", async () => {
    const expectedProviderIds = registry.list().map((provider) => provider.providerId);
    const evidenceSummary = new ReleaseEvidenceEvaluator().summarize({
      records: [...db.releaseEvidence.values()],
      expectedProviderIds
    });
    const providerReadinessEvidence = buildProviderReadinessEvidenceFromReleaseEvidence({
      records: [...db.releaseEvidence.values()],
      expectedProviderIds,
      providerConfigs: deps.config.providers
    });
    const providerReadiness = await collectProviderReadinessReports({
      registry,
      environment: deps.config.app.environment,
      canaryRuns: [...db.canaryRuns.values(), ...(providerReadinessEvidence.canaryRuns ?? [])],
      replayReports: [...db.replayReports.values(), ...(providerReadinessEvidence.replayReports ?? [])],
      providerConfigs: providerReadinessEvidence.providerConfigs
    });
    const autoApplyProviderIds = new Set(registry.list().filter((provider) => provider.capabilities.autoApply).map((provider) => provider.providerId));
    return new ReleaseGateEvaluator().evaluate({
      mode: db.systemMode,
      irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled,
      providerReadiness: providerReadiness.filter((provider) => autoApplyProviderIds.has(provider.providerId)),
      liveCredentialsConfigured: evidenceSummary.liveCredentialsConfigured,
      externalSecretsBackend: deps.config.security.secretsBackend !== "env" && evidenceSummary.externalSecretsBackend,
      liveCanariesPassing: evidenceSummary.liveCanariesPassing,
      providerSubmitProofReady: evidenceSummary.providerSubmitProofReady,
      calendarIntegrationReady: evidenceSummary.calendarIntegrationReady,
      sevenDaySoakPassed: evidenceSummary.sevenDaySoakPassed,
      outboundDispatchProofReady: evidenceSummary.outboundDispatchProofReady
    });
  });

  app.get("/sources", async () => {
    const health = await app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: `Bearer ${deps.config.api.token}` }
    });
    return JSON.parse(health.body);
  });

  app.get("/profiles", async () => ({
    active: db.candidateProfile,
    text: renderProfile(db.candidateProfile)
  }));

  app.get("/profiles/readiness", async () => {
    const report = new ProfileReadinessValidator().validate(db.candidateProfile, db.systemMode);
    return {
      report,
      text: renderProfileReadiness(report)
    };
  });

  app.post<{
    Body: {
      action?: PolicyInput["action"];
      mode?: string;
      providerStatus?: ProviderStatus;
      proofReady?: boolean;
      validationPassed?: boolean;
      irreversibleActionsEnabled?: boolean;
      rateLimitAvailable?: boolean;
      scoreDecision?: "shortlisted" | "rejected";
      dedupStatus?: "new" | "duplicate" | "possible_duplicate";
    };
  }>("/policy/simulate", async (request) => {
    const mode = appModes.includes(request.body.mode as AppMode) ? (request.body.mode as AppMode) : db.systemMode;
    const result = new PolicyEngine().check({
      action: request.body.action ?? "send_application",
      mode,
      providerStatus: request.body.providerStatus ?? "stable",
      candidateProfile: db.candidateProfile,
      score: {
        score: request.body.scoreDecision === "rejected" ? 10 : 90,
        interviewLikelihoodScore: request.body.scoreDecision === "rejected" ? 10 : 90,
        decision: request.body.scoreDecision ?? "shortlisted",
        reasons: ["policy simulation"],
        risks: [],
        hardRejections: []
      },
      dedupDecision: {
        status: request.body.dedupStatus ?? "new",
        confidence: 1,
        matchedEntities: [],
        actions: ["continue"]
      },
      idempotencyKey: "simulate:idempotency",
      proofReady: request.body.proofReady ?? true,
      validationPassed: request.body.validationPassed ?? true,
      irreversibleActionsEnabled: request.body.irreversibleActionsEnabled ?? deps.config.app.irreversibleActionsEnabled,
      rateLimitAvailable: request.body.rateLimitAvailable ?? true
    });
    return result;
  });

  app.get("/jobs", async () => [...db.jobs.values()]);

  app.get<{ Params: { id: string } }>("/job/:id", async (request, reply) => {
    const job = db.jobs.get(request.params.id);
    if (!job) {
      await reply.code(404).send({ error: "job_not_found" });
      return;
    }
    return {
      job,
      score: db.jobScores.get(job.id) ?? null,
      timeline: [
        ...[...db.applications.values()]
          .filter((application) => application.jobId === job.id)
          .map((application) => ({ type: "application", at: application.createdAt, status: application.status, id: application.id })),
        ...[...db.inboundMessages.values()]
          .filter((message) => message.linkedJobExternalId === job.externalId || message.linkedJobExternalId === job.id)
          .map((message) => ({ type: "inbound_message", at: message.receivedAt, status: message.classificationState, id: message.id })),
        ...[...db.interviewEvents.values()]
          .filter((event) => event.jobId === job.id)
          .map((event) => ({ type: "interview", at: event.dateTime, status: event.status, id: event.interviewId }))
      ].sort((left, right) => String(left.at).localeCompare(String(right.at))),
      text: renderJobCard(job, db.jobScores.get(job.id) ?? null)
    };
  });

  app.get("/applications", async () => [...db.applications.values()]);
  app.get("/manual-review", async () => [...db.manualReviewItems.values()]);
  app.get("/approval-requests", async () => [...db.approvalRequests.values()]);
  app.post<{
    Body: {
      userId?: string;
      entityType?: string;
      entityId?: string;
      requestedAction?: string;
      expiresAt?: string;
      policyDecisionId?: string | null;
      draftHash?: string | null;
      manualReviewId?: string | null;
    };
  }>("/approval-requests", async (request, reply) => {
    if (!request.body.entityType || !request.body.entityId || !request.body.requestedAction || !request.body.expiresAt) {
      await reply.code(400).send({ error: "entityType_entityId_requestedAction_expiresAt_required" });
      return;
    }
	    if (Number.isNaN(Date.parse(request.body.expiresAt))) {
	      await reply.code(400).send({ error: "invalid_expiresAt" });
	      return;
	    }
    if (request.body.entityType === "application" && request.body.requestedAction === "send_application") {
      const application = db.applications.get(request.body.entityId);
      if (!application) {
        await reply.code(404).send({ error: "application_not_found" });
        return;
      }
      if (!application.draftVariantKey) {
        await reply.code(409).send({ error: "application_draft_hash_missing" });
        return;
      }
      if (request.body.draftHash !== application.draftVariantKey) {
        await reply.code(409).send({ error: "application_draft_hash_required_or_mismatch" });
        return;
      }
    }
    if (
      request.body.requestedAction &&
      ["send_recruiter_reply", "confirm_interview_slot"].includes(request.body.requestedAction) &&
      !request.body.draftHash
    ) {
      await reply.code(409).send({ error: "draft_hash_required_for_irreversible_approval" });
      return;
    }
	    const approvalRequest = db.createApprovalRequest({
      userId: request.body.userId ?? db.candidateProfile.userId,
      entityType: request.body.entityType,
      entityId: request.body.entityId,
      requestedAction: request.body.requestedAction,
      expiresAt: request.body.expiresAt,
      policyDecisionId: request.body.policyDecisionId ?? null,
      draftHash: request.body.draftHash ?? null,
      manualReviewId: request.body.manualReviewId ?? null
    });
    await flushRuntimePersistence(db);
    return approvalRequest;
  });
  app.post<{
    Params: { id: string };
    Body: { resolution?: "approved" | "rejected"; draftHash?: string | null; reason?: string; now?: string };
  }>("/approval-requests/:id/resolve", async (request, reply) => {
    const resolution = request.body.resolution;
    if (!resolution || !["approved", "rejected"].includes(resolution)) {
      await reply.code(400).send({ error: "invalid_resolution" });
      return;
    }
    const now = request.body.now ? new Date(request.body.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      await reply.code(400).send({ error: "invalid_now" });
      return;
    }
    const pendingApprovalRequest = db.approvalRequests.get(request.params.id);
    if (!pendingApprovalRequest) {
      await reply.code(409).send({ error: "approval_request_not_found_or_draft_hash_mismatch" });
      return;
    }
	    const application =
	      pendingApprovalRequest.entityType === "application" && pendingApprovalRequest.requestedAction === "send_application"
	        ? db.applications.get(pendingApprovalRequest.entityId)
	        : null;
	    const applicationJob = application ? db.jobs.get(application.jobId) ?? null : null;
    const submitRateLimit = application && applicationJob
      ? evaluateApplicationRateLimits({
          profile: db.candidateProfile,
          applications: db.applications.values(),
          jobs: db.jobs.values(),
          job: applicationJob,
          providerId: application.providerId,
	          excludeApplicationId: application.id
	        })
	      : null;
	    const submitPolicy = application
	      ? buildApprovalSubmitPolicy({
	          approvalStatus: resolution === "approved" ? "approved" : pendingApprovalRequest.status,
	          irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled,
	          rateLimit: submitRateLimit,
	          missingJob: !applicationJob
	        })
	      : null;
    if (resolution === "approved" && application) {
      if (!application.draftVariantKey || request.body.draftHash !== application.draftVariantKey) {
        await reply.code(409).send({ error: "application_draft_hash_required_or_mismatch" });
        return;
      }
      if (!submitPolicy || submitPolicy.decision !== "allow") {
        if (submitPolicy) {
          db.recordPolicyCheck({ entityType: "application", entityId: application.id, result: submitPolicy });
        }
        await flushRuntimePersistence(db);
        await reply.code(409).send({ error: "submit_policy_failed", policy: submitPolicy });
        return;
      }
    }
    const approvalRequest = db.resolveApprovalRequest({
      id: request.params.id,
      resolution,
      actor: "api",
      draftHash: request.body.draftHash ?? null,
      now,
      reason: request.body.reason ?? null
    });
    if (!approvalRequest) {
      await reply.code(409).send({ error: "approval_request_not_found_or_draft_hash_mismatch" });
      return;
    }
	    const submitPlan = application && resolution === "approved"
	      ? new SubmitApprovalOrchestrator().plan({
	          applicationId: application.id,
	          approvalRequest,
	          currentDraftHash: application.draftVariantKey!,
	          policy: submitPolicy!,
	          liveSubmitEnabled: deps.config.app.irreversibleActionsEnabled
	        })
	      : null;
	    let queuedTask = null;
	    if (submitPlan?.enqueue && application) {
	      db.setApplicationStatus({ id: application.id, status: "apply_queued", submittedAt: now.toISOString() });
	      try {
	        queuedTask = await queue.enqueue(
	          submitPlan.queueName,
	          {
	            applicationId: application.id,
	            providerId: application.providerId,
	            approvalRequestId: approvalRequest.id,
	            approvedDraftHash: application.draftVariantKey
	          },
	          { idempotencyKey: submitPlan.idempotencyKey, deduplicationKey: application.idempotencyKey }
	        );
	      } catch (error) {
	        db.setApplicationStatus({ id: application.id, status: "manual_review_required" });
	        throw error;
	      }
	    }
    await flushRuntimePersistence(db);
    return { ...approvalRequest, submitPlan, queuedTask };
  });
  app.post<{
    Params: { id: string };
    Body: { resolution?: "approved" | "rejected" | "deferred"; reason?: string };
  }>("/manual-review/:id/resolve", async (request, reply) => {
    const resolution = request.body.resolution;
    if (!resolution || !["approved", "rejected", "deferred"].includes(resolution)) {
      await reply.code(400).send({ error: "invalid_resolution" });
      return;
    }
    const item = db.resolveManualReview({
      id: request.params.id,
      resolution,
      actor: "api",
      reason: request.body.reason ?? null
    });
    if (!item) {
      await reply.code(404).send({ error: "manual_review_not_found" });
      return;
    }
    await flushRuntimePersistence(db);
    return item;
  });
  app.get("/audit", async () => db.auditEvents);
  app.get<{ Params: { entityId: string } }>("/logs/:entityId", async (request) =>
    db.auditEvents.filter((event) => event.entityId === request.params.entityId)
  );
  app.get("/metrics", async () => metrics.snapshot());
  app.get("/metrics/prometheus", async (_request, reply) => reply.type("text/plain; version=0.0.4").send(metrics.prometheusText()));
  app.get("/dashboards", async () => buildDashboardDefinitions());
  app.get("/alerts", async () => {
    const applications = [...db.applications.values()];
    const outboundMessages = [...db.outboundMessages.values()];
    const manualReviews = [...db.manualReviewItems.values()];
    const providerHealth = [...db.providerHealth.values()];
    const dataQuality = new DataQualityService().evaluate({ jobs: [...db.jobs.values()], dedupDecisions: db.dedupDecisions, scores: db.jobScores });
    const queueBacklogs = await Promise.all(
      queueNames.map(async (queueName) => ({
        queueName,
        depth: await queue.depth(queueName),
        oldestAgeSeconds: await queue.oldestAgeSeconds(queueName)
      }))
    );
    const queueBacklog = queueBacklogs
      .filter((backlog) => backlog.depth > 0)
      .sort((left, right) => right.oldestAgeSeconds - left.oldestAgeSeconds)[0] ?? null;
    const duplicateApplicationAttempted =
      new Set(applications.map((application) => application.idempotencyKey)).size < applications.length ||
      db.auditEvents.some((event) => event.eventType === "application_duplicate_suppressed");
    const replyValidationFailures = manualReviews.filter((item) => item.reasonCode === "reply_draft_validation_failed").length +
      outboundMessages.filter((message) => message.errors.length > 0).length;
    const unsupportedFactAttempted =
      outboundMessages.some((message) => message.errors.some((error) => error.startsWith("unsupported_fact:") || error === "facts_matrix_violation")) ||
      manualReviews.some((item) => item.reasonCode === "reply_draft_validation_failed" && item.recommendedAction.includes("unsupported_fact:"));
    const threadContradictionDetected = manualReviews.some((item) => item.reasonCode === "reply_thread_context_conflict");
    const outboundDeliveryFailureCount = outboundMessages.filter((message) =>
      message.errors.some((error) => /delivery|dispatch|transport|send/i.test(error))
    ).length;
    return evaluateCoreAlerts({
      duplicateApplicationAttempted,
      irreversibleActionWithoutProof: applications.some((application) => application.status === "applied" && !application.proofPackId),
      providerFailureRate: providerHealth.length === 0 ? 0 : providerHealth.filter((health) => health.status !== "stable").length / providerHealth.length,
      dlqCount: taskRunStore.listDeadLetters("open").length,
      llmSchemaValidationFailures: [...db.messageClassifications.values()].filter((record) => !record.llmOk).length,
      parseFailureRate: dataQuality.totalJobs === 0 ? 0 : dataQuality.lowConfidenceJobIds.length / dataQuality.totalJobs,
      dedupPossibleDuplicateRate: dataQuality.totalJobs === 0 ? 0 : dataQuality.duplicateLikeJobIds.length / dataQuality.totalJobs,
      unsupportedFactAttempted,
      replyValidationFailures,
      threadContradictionDetected,
      outboundDeliveryFailureCount,
      queueBacklog
    });
  });
  app.get("/queues", async () => ({
    queues: await Promise.all(
      queueNames.map(async (queueName) => ({
        queueName,
        depth: await queue.depth(queueName),
        oldestAgeSeconds: await queue.oldestAgeSeconds(queueName),
        policy: queuePolicies[queueName]
      }))
    )
  }));
  app.get<{ Querystring: { status?: string } }>("/dlq", async (request, reply) => {
    const status = request.query.status;
    if (status && !["open", "assigned", "resolved", "discarded"].includes(status)) {
      await reply.code(400).send({ error: "invalid_dlq_status" });
      return;
    }
    return taskRunStore.listDeadLetters(status as Parameters<TaskRunStore["listDeadLetters"]>[0]);
  });

  app.post<{ Params: { id: string }; Body: { assignee?: string; note?: string } }>("/dlq/:id/assign", async (request, reply) => {
    const assignee = request.body.assignee?.trim();
    if (!assignee) {
      await reply.code(400).send({ error: "assignee_required" });
      return;
    }
    const record = taskRunStore.assignDeadLetter(request.params.id, { assignee, actor: "api", note: request.body.note ?? null });
    if (!record) {
      await reply.code(404).send({ error: "dead_letter_not_found_or_closed" });
      return;
    }
    db.recordAuditEvent(dlqAudit("dead_letter_assigned", record.id, { assignee, note: request.body.note ?? null }));
    await flushRuntimePersistence(db);
    return record;
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>("/dlq/:id/resolve", async (request, reply) => {
    const record = taskRunStore.resolveDeadLetter(request.params.id, { actor: "api", note: request.body.note ?? null });
    if (!record) {
      await reply.code(404).send({ error: "dead_letter_not_found_or_closed" });
      return;
    }
    db.recordAuditEvent(dlqAudit("dead_letter_resolved", record.id, { note: request.body.note ?? null }));
    await flushRuntimePersistence(db);
    return record;
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>("/dlq/:id/discard", async (request, reply) => {
    const record = taskRunStore.discardDeadLetter(request.params.id, { actor: "api", note: request.body.note ?? null });
    if (!record) {
      await reply.code(404).send({ error: "dead_letter_not_found_or_closed" });
      return;
    }
    db.recordAuditEvent(dlqAudit("dead_letter_discarded", record.id, { note: request.body.note ?? null }));
    await flushRuntimePersistence(db);
    return record;
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>("/dlq/:id/retry", async (request, reply) => {
    const record = taskRunStore.getDeadLetter(request.params.id);
    if (!record || record.status === "resolved" || record.status === "discarded") {
      await reply.code(404).send({ error: "dead_letter_not_found_or_closed" });
      return;
    }
    const task = await queue.enqueue(
      "retry_queue",
      { taskRunId: record.taskRunId, deadLetterId: record.id, sourceQueueName: record.queueName },
      { idempotencyKey: `retry:${record.id}`, deduplicationKey: record.taskRunId }
    );
    const resolved = taskRunStore.resolveDeadLetter(record.id, { actor: "api", note: request.body.note ?? `Retry queued: ${task.id}` });
    db.recordAuditEvent(dlqAudit("dead_letter_retry_queued", record.id, { retryTaskId: task.id }));
    await flushRuntimePersistence(db);
    return { deadLetter: resolved, retryTask: task };
  });

  app.get("/outbound", async () => [...db.outboundMessages.values()]);

  app.post<{
    Body: {
      providerId?: string;
      accountId?: string;
      conversationId?: string;
      inboundMessageId?: string;
      category?: MessageCategory;
      text?: string;
      factsUsed?: string[];
      approval?: "approved" | "pending" | "rejected";
      approvalRequestId?: string;
    };
  }>("/outbound/dispatch/review-first", async (request, reply) => {
    if (!request.body.conversationId || !request.body.inboundMessageId || !request.body.text) {
      await reply.code(400).send({ error: "conversationId_inboundMessageId_text_required" });
      return;
    }
    const category = request.body.category ?? "acknowledgment";
    const message: OutboundMessage = {
      conversationId: request.body.conversationId,
      inboundMessageId: request.body.inboundMessageId,
      category,
      language: db.candidateProfile.languages.communicationDefault,
      text: request.body.text,
      factsUsed: request.body.factsUsed ?? [],
      idempotencyKey: `reply:${request.body.conversationId}:${request.body.inboundMessageId}:${category}`
    };
    const approval = request.body.approval ?? "pending";
    if (approval === "approved") {
      if (!request.body.approvalRequestId) {
        await reply.code(400).send({ error: "approvalRequestId_required_for_approved_dispatch" });
        return;
      }
      const approvalRequest = db.approvalRequests.get(request.body.approvalRequestId);
      const draftHash = stableHash(message.text);
      if (
        !approvalRequest ||
        approvalRequest.entityType !== "outbound_message" ||
        approvalRequest.entityId !== message.idempotencyKey ||
        approvalRequest.requestedAction !== "send_recruiter_reply" ||
        approvalRequest.draftHash !== draftHash
      ) {
        await reply.code(409).send({ error: "approval_request_not_found_or_text_hash_mismatch" });
        return;
      }
      const resolved = db.resolveApprovalRequest({
        id: approvalRequest.id,
        resolution: "approved",
        actor: "api",
        draftHash,
        reason: "review-first outbound dispatch"
      });
      if (!resolved || resolved.status !== "approved") {
        await reply.code(409).send({ error: "approval_request_not_approved", status: resolved?.status ?? null });
        return;
      }
    }
    const validation = new ConversationEngine().validateOutbound(message, db.candidateProfile);
    const contradiction = new ThreadContradictionChecker().check({
      draft: message,
      previousMessages: [...db.inboundMessages.values()]
        .filter((inboundMessage) => inboundMessage.conversationId === message.conversationId)
        .map((inboundMessage) => ({ text: inboundMessage.text }))
    });
    if (!contradiction.valid) {
      db.createManualReview({
        userId: db.candidateProfile.userId,
        entityType: "outbound_message",
        entityId: message.idempotencyKey,
        reasonCode: "reply_thread_context_conflict",
        severity: "high",
        recommendedAction: `Review contradiction flags before dispatch: ${contradiction.riskFlags.join(", ")}`
      });
    }
    const replyRateLimit = evaluateReplyRateLimits({
      profile: db.candidateProfile,
      conversations: db.conversations.values(),
      outboundMessages: db.outboundMessages.values(),
      conversationId: message.conversationId,
      excludeOutboundMessageId: `outbound_${stableHash(message.idempotencyKey)}`
    });
    const policy = new PolicyEngine().check({
      action: "send_recruiter_reply",
      mode: db.systemMode,
      providerStatus: "stable",
      candidateProfile: db.candidateProfile,
      messageClassification: {
        category,
        confidence: 0.95,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["api review-first dispatch"]
      },
      outboundMessage: message,
	      idempotencyKey: message.idempotencyKey,
	      proofReady: true,
	      validationPassed: validation.valid && contradiction.valid,
	      irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled,
	      rateLimitAvailable: replyRateLimit.allowed
	    });
    const result = new OutboundDispatchService().dispatch({
      message,
      profile: db.candidateProfile,
      providerId: request.body.providerId ?? "fixture",
      accountId: request.body.accountId ?? "fixture-account",
	      policy,
	      approval,
	      liveSendEnabled: false,
	      irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled
	    });
    const record = db.recordOutboundDispatch({
      providerId: request.body.providerId ?? "fixture",
      accountId: request.body.accountId ?? "fixture-account",
      message,
      result,
      actor: "api"
    });
    await flushRuntimePersistence(db);
    return { record, policy };
  });

  app.get("/availability", async () => ({
    availability: db.candidateProfile.availability,
    interviews: [...db.interviewEvents.values()]
  }));

  app.post<{
    Body: { proposedSlots?: Array<{ date: string; time: string; timezone: string }> };
  }>("/schedule/decide", async (request, reply) => {
    if (!Array.isArray(request.body.proposedSlots)) {
      await reply.code(400).send({ error: "proposedSlots_required" });
      return;
    }
    const calendar = InMemoryCalendarAdapter.fromInterviewEvents([...db.interviewEvents.values()], db.candidateProfile);
    return new SchedulingDecisionEngine(calendar).decide({
      proposedSlots: request.body.proposedSlots,
      profile: db.candidateProfile,
      existingEvents: [...db.interviewEvents.values()]
    });
  });

  app.post<{
    Body: {
      jobId?: string;
      companyId?: string;
      conversationId?: string;
      slot?: { date: string; time: string; timezone: string; durationMinutes?: number };
      link?: string | null;
      recruiterName?: string | null;
    };
  }>("/schedule/confirmations", async (request, reply) => {
    if (!request.body.jobId || !request.body.conversationId || !request.body.slot) {
      await reply.code(400).send({ error: "jobId_conversationId_slot_required" });
      return;
    }
    const job = db.jobs.get(request.body.jobId);
    if (!job) {
      await reply.code(404).send({ error: "job_not_found" });
      return;
    }
    if (![...db.conversations.values()].some((conversation) => conversation.id === request.body.conversationId)) {
      await reply.code(404).send({ error: "conversation_not_found" });
      return;
    }
    const schedulingDecision = buildInterviewSchedulingDecision(db, request.body.slot);
    const schedulingPolicy = buildInterviewSchedulingPolicy({
      db,
      schedulingDecision,
      idempotencyKey: `interview_confirm:${job.id}:${request.body.conversationId}:${stableHash(JSON.stringify(canonicalInterviewSlot(request.body.slot)))}`,
      irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled
    });
    db.recordPolicyCheck({ entityType: "interview_confirmation", entityId: job.id, result: schedulingPolicy });
    if (schedulingDecision.status !== "confirm_slot" || schedulingPolicy.decision === "deny") {
      await flushRuntimePersistence(db);
      await reply.code(409).send({ error: "scheduling_policy_failed", schedulingDecision, policy: schedulingPolicy });
      return;
    }
    const event = new InterviewCoordinator().createPendingConfirmation({
      jobId: job.id,
      companyId: request.body.companyId ?? job.companyExternalId ?? job.companyName ?? "unknown-company",
      conversationId: request.body.conversationId,
      slot: request.body.slot,
      link: request.body.link ?? null,
      recruiterName: request.body.recruiterName ?? null
    });
    db.recordInterviewEvent(event);
    const approvalRequest = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: event.interviewId,
      requestedAction: "confirm_interview_slot",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      policyDecisionId: null,
      draftHash: stableHash(JSON.stringify(canonicalInterviewSlot(request.body.slot))),
      manualReviewId: null
    });
    await flushRuntimePersistence(db);
    return { event, approvalRequest };
  });

  app.post<{ Params: { id: string }; Body: { resolution?: "approved" | "rejected"; draftHash?: string | null } }>(
    "/schedule/confirmations/:id/resolve",
    async (request, reply) => {
      if (!request.body.resolution || !["approved", "rejected"].includes(request.body.resolution)) {
        await reply.code(400).send({ error: "invalid_resolution" });
        return;
      }
      const event = db.interviewEvents.get(request.params.id);
      if (!event) {
        await reply.code(404).send({ error: "interview_confirmation_not_found" });
        return;
      }
      const approvalRequest = [...db.approvalRequests.values()].find(
        (requestItem) => requestItem.entityType === "interview" && requestItem.entityId === event.interviewId && requestItem.requestedAction === "confirm_interview_slot"
      );
      if (!approvalRequest) {
        await reply.code(404).send({ error: "approval_request_not_found" });
        return;
      }
	      if (request.body.resolution === "approved") {
	        const currentSlot = slotFromInterviewEvent(event);
	        const currentDraftHash = stableHash(JSON.stringify(currentSlot));
	        if (!request.body.draftHash || request.body.draftHash !== currentDraftHash || approvalRequest.draftHash !== currentDraftHash) {
	          await reply.code(409).send({ error: "interview_slot_hash_required_or_mismatch" });
	          return;
	        }
	        const schedulingDecision = buildInterviewSchedulingDecision(db, currentSlot, event.interviewId);
	        const schedulingPolicy = buildInterviewSchedulingPolicy({
	          db,
          schedulingDecision,
          idempotencyKey: `interview_confirm:${event.interviewId}`,
          irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled
        });
        db.recordPolicyCheck({ entityType: "interview_confirmation", entityId: event.interviewId, result: schedulingPolicy });
	        if (schedulingDecision.status !== "confirm_slot" || schedulingPolicy.decision === "deny" || !deps.config.app.irreversibleActionsEnabled) {
	          await flushRuntimePersistence(db);
	          await reply.code(409).send({ error: "scheduling_policy_failed", schedulingDecision, policy: schedulingPolicy });
	          return;
	        }
	      }
	      const resolved = db.resolveApprovalRequest({
	        id: approvalRequest.id,
	        resolution: request.body.resolution,
	        actor: "api",
	        draftHash: request.body.draftHash ?? approvalRequest.draftHash
	      });
	      if (!resolved || resolved.status !== request.body.resolution) {
	        await reply.code(409).send({ error: "approval_request_not_resolved", status: resolved?.status ?? null });
	        return;
	      }
	      const updated = { ...event, status: resolved.status === "approved" ? "scheduled" as const : "cancelled" as const };
      db.recordInterviewEvent(updated);
      await flushRuntimePersistence(db);
      return { event: updated, approvalRequest: resolved };
    }
  );

  app.get("/retention", async () => {
    const artifacts = [
      ...[...db.objectArtifacts.values()].map((artifact) => ({
        artifactId: artifact.objectKey,
        artifactType: artifact.artifactType === "proof_pack" ? "proof_pack" as const : "screenshot" as const,
        createdAt: artifact.createdAt,
        retentionUntil: null,
        legalHold: false
      })),
      ...[...db.inboundMessages.values()].map((message) => ({
        artifactId: message.id,
        artifactType: "recruiter_message" as const,
        createdAt: message.receivedAt,
        retentionUntil: null,
        legalHold: false
      }))
    ];
    return new RetentionPolicyEngine().evaluate(artifacts);
  });
  app.get("/retention/enforcement", async () => {
    const artifacts = [
      ...[...db.objectArtifacts.values()].map((artifact) => ({
        artifactId: artifact.objectKey,
        artifactType: artifact.artifactType === "proof_pack" ? "proof_pack" as const : "screenshot" as const,
        createdAt: artifact.createdAt,
        retentionUntil: null,
        legalHold: false
      })),
      ...[...db.inboundMessages.values()].map((message) => ({
        artifactId: message.id,
        artifactType: "recruiter_message" as const,
        createdAt: message.receivedAt,
        retentionUntil: null,
        legalHold: false
      }))
    ];
    return new RetentionEnforcementPlanner().plan(new RetentionPolicyEngine().evaluate(artifacts));
  });
  app.post<{ Body: { artifactId?: string; requesterRole?: "owner" | "ops" | "security" | "viewer"; purpose?: string; containsSensitiveData?: boolean } }>(
    "/artifacts/access",
    async (request, reply) => {
      if (!request.body.artifactId || !request.body.requesterRole || !request.body.purpose) {
        await reply.code(400).send({ error: "artifactId_requesterRole_purpose_required" });
        return;
      }
      return new ArtifactAccessPolicy().authorize({
        artifactId: request.body.artifactId,
        requesterRole: request.body.requesterRole,
        purpose: request.body.purpose,
        containsSensitiveData: request.body.containsSensitiveData ?? false
      });
    }
  );

  app.get("/responses", async () => {
    const priority = new ResponsePriorityService().rank([...db.messageClassifications.entries()].map(([inboundMessageId, record]) => {
      const receivedAt = [...db.inboundMessages.values()].find((message) => message.id === inboundMessageId)?.receivedAt;
      return {
        inboundMessageId,
        classification: record.classification,
        ...(receivedAt ? { receivedAt } : {})
      };
    }));
    return {
      responses: [...db.messageClassifications.values()],
      priority,
      groups: {
        urgent: priority.filter((item) => item.bucket === "urgent"),
        needs_reply: priority.filter((item) => item.bucket === "needs_reply"),
        fyi: priority.filter((item) => item.bucket === "fyi")
      },
      message: "Inbox sync is fixture-backed and available through worker-inbox."
    };
  });

  app.post<{ Body: { now?: string } }>("/follow-ups/plan", async (request, reply) => {
    const now = request.body.now ? new Date(request.body.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      await reply.code(400).send({ error: "invalid_now" });
      return;
    }
    const result = planConservativeFollowUps(db, now);
    await flushRuntimePersistence(db);
    return result;
  });

  app.get("/interviews", async () => ({
    interviews: [...db.interviewEvents.values()],
    message: "No scheduled interviews in local-safe seed state."
  }));

  app.get("/digest", async () => {
    const pipeline = await app.inject({
      method: "GET",
      url: "/pipeline",
      headers: { authorization: `Bearer ${deps.config.api.token}` }
    });
    const pipelineBody = JSON.parse(pipeline.body) as { text: string };
    return renderDigest({
      responses: db.messageClassifications.size,
      manualReviewItems: db.manualReviewItems.size,
      interviews: db.interviewEvents.size,
      providerIssues: [...db.providerHealth.values()].filter((health) => health.status !== "stable").map((health) => health.providerId),
      pipelineStats: pipelineBody.text
    });
  });

  return app;
}

function isAuthorized(request: FastifyRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${token}`) {
    return true;
  }
  const apiToken = request.headers["x-api-token"];
  return apiToken === token;
}

interface TelegramWebhookUpdate {
  update_id?: number;
  message?: {
    text?: string;
    from?: { id?: number | string };
    chat?: { id?: number | string };
  };
}

function isTelegramWebhookAuthorized(request: FastifyRequest, webhookSecret: string): boolean {
  if (webhookSecret.length === 0) {
    return false;
  }
  const header = request.headers["x-telegram-bot-api-secret-token"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return false;
  }
  const expected = Buffer.from(webhookSecret);
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function truncateTelegramMessage(value: string): string {
  return value.length <= 4096 ? value : value.slice(0, 4090) + "\n[...]";
}

function buildApprovalSubmitPolicy(input: {
  approvalStatus: string;
  irreversibleActionsEnabled: boolean;
  rateLimit: ReturnType<typeof evaluateApplicationRateLimits> | null;
  missingJob: boolean;
}): PolicyOutput {
  const approved = input.approvalStatus === "approved";
  const rateLimitAllowed = input.rateLimit?.allowed ?? true;
  const reasons = [
    ...(approved ? [] : [`approval_status_${input.approvalStatus}`]),
    ...(input.irreversibleActionsEnabled ? [] : ["irreversible_actions_disabled"]),
    ...(input.rateLimit?.reasons ?? [])
  ];
  const allow = approved && input.irreversibleActionsEnabled && rateLimitAllowed;
  const requiresUserApproval = approved && !input.irreversibleActionsEnabled && rateLimitAllowed;
  return {
    decision: allow ? "allow" : requiresUserApproval ? "requires_user_approval" : "deny",
    action: "send_application",
    policyVersion: "approval-resolution-v2",
    checks: [
      approved ? {
        name: "approval_status_approved",
        result: "passed",
        severity: "hard_deny"
      } : {
        name: "approval_status_approved",
        result: "failed",
        severity: "hard_deny",
        reason: `approval_status_${input.approvalStatus}`
      },
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
    requiresUserApproval,
    reasons: allow ? [] : reasons
  };
}

function buildInterviewSchedulingDecision(
  db: InMemoryDatabase,
  slot: { date: string; time: string; timezone: string; durationMinutes?: number },
  excludeInterviewId?: string
) {
  const existingEvents = [...db.interviewEvents.values()].filter((event) => event.interviewId !== excludeInterviewId);
  const calendar = InMemoryCalendarAdapter.fromInterviewEvents(existingEvents, db.candidateProfile);
  return new SchedulingDecisionEngine(calendar).decide({
    proposedSlots: [slot],
    profile: db.candidateProfile,
    existingEvents
  });
}

function buildInterviewSchedulingPolicy(input: {
  db: InMemoryDatabase;
  schedulingDecision: ReturnType<SchedulingDecisionEngine["decide"]>;
  idempotencyKey: string;
  irreversibleActionsEnabled: boolean;
}) {
  return new PolicyEngine().check({
    action: "confirm_interview_slot",
    mode: input.db.systemMode,
    providerStatus: "stable",
    candidateProfile: input.db.candidateProfile,
    schedulingDecision: input.schedulingDecision,
    idempotencyKey: input.idempotencyKey,
    proofReady: input.schedulingDecision.status === "confirm_slot",
    validationPassed: input.schedulingDecision.status === "confirm_slot",
    irreversibleActionsEnabled: input.irreversibleActionsEnabled,
    rateLimitAvailable: Boolean(input.schedulingDecision.policyProof?.maxPerDaySatisfied)
  });
}

function slotFromInterviewEvent(event: { dateTime: string; timezone: string }): { date: string; time: string; timezone: string } {
  return {
    date: event.dateTime.slice(0, 10),
    time: event.dateTime.slice(11, 16),
    timezone: event.timezone
  };
}

function canonicalInterviewSlot(slot: { date: string; time: string; timezone: string }): { date: string; time: string; timezone: string } {
  return {
    date: slot.date,
    time: slot.time,
    timezone: slot.timezone
  };
}

function templateIdFromReplyIdempotencyKey(idempotencyKey: string): string {
  const [templateId] = idempotencyKey.split(":").slice(-1);
  return templateId && templateId.length > 0 ? templateId : "unknown";
}

function planConservativeFollowUps(db: InMemoryDatabase, now: Date): {
  planned: Array<{ conversationId: string; scheduledAt: string; manualReviewId: string | null; reason: string }>;
  skipped: Array<{ conversationId: string; reason: string }>;
} {
  const scheduler = new FollowUpScheduler();
  const planned: Array<{ conversationId: string; scheduledAt: string; manualReviewId: string | null; reason: string }> = [];
  const skipped: Array<{ conversationId: string; reason: string }> = [];
  const outboundByConversation = [...db.outboundMessages.values()].reduce((map, message) => {
    const messages = map.get(message.message.conversationId) ?? [];
    messages.push(message);
    map.set(message.message.conversationId, messages);
    return map;
  }, new Map<string, OutboundMessageRecord[]>());

  for (const conversation of db.conversations.values()) {
    const inboundMessages = [...db.inboundMessages.values()]
      .filter((message) => message.conversationId === conversation.id)
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    const lastInbound = inboundMessages.at(-1);
    if (!lastInbound) {
      skipped.push({ conversationId: conversation.id, reason: "no_inbound_message" });
      continue;
    }
    const category = db.messageClassifications.get(lastInbound.id)?.classification.category ?? "unknown";
    const followUpOutbounds = (outboundByConversation.get(conversation.id) ?? []).filter((message) =>
      templateIdFromReplyIdempotencyKey(message.message.idempotencyKey).includes("follow_up")
    );
    const lastFollowUp = followUpOutbounds.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
    const openFollowUpReview = [...db.manualReviewItems.values()].find(
      (item) => item.entityType === "conversation" && item.entityId === conversation.id && item.reasonCode === "follow_up_due" && item.status === "open"
    );
    const companyConversationIds = new Set(
      [...db.conversations.values()]
        .filter((item) => item.companyName !== null && item.companyName === conversation.companyName)
        .map((item) => item.id)
    );
    const companyScheduledCount = [...db.manualReviewItems.values()].filter(
      (item) => item.entityType === "conversation" && companyConversationIds.has(item.entityId) && item.reasonCode === "follow_up_due"
    ).length;
    const plan = scheduler.plan({
      conversationId: conversation.id,
      lastInboundAt: lastInbound.receivedAt,
      category,
      alreadyScheduledCount:
        followUpOutbounds.length +
        [...db.manualReviewItems.values()].filter(
          (item) => item.entityType === "conversation" && item.entityId === conversation.id && item.reasonCode === "follow_up_due"
        ).length,
      recruiterRepliedAfterLastFollowUp: lastFollowUp ? Date.parse(lastInbound.receivedAt) > Date.parse(lastFollowUp.createdAt) : false,
      threadClosed: ["closed", "archived", "rejected"].includes(conversation.status) || category === "rejection" || category === "spam_irrelevant",
      companyScheduledCount
    });
    if (!plan.shouldSchedule || !plan.scheduledAt) {
      skipped.push({ conversationId: conversation.id, reason: plan.reason });
      continue;
    }
    if (Date.parse(plan.scheduledAt) > now.getTime()) {
      skipped.push({ conversationId: conversation.id, reason: "follow_up_not_due" });
      continue;
    }
    if (openFollowUpReview) {
      planned.push({ conversationId: conversation.id, scheduledAt: plan.scheduledAt, manualReviewId: openFollowUpReview.id, reason: "follow_up_already_pending" });
      continue;
    }
    const review = db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "conversation",
      entityId: conversation.id,
      reasonCode: "follow_up_due",
      severity: "low",
      recommendedAction: `Review conservative follow-up scheduled for ${plan.scheduledAt}: ${plan.reason}`
    });
    planned.push({ conversationId: conversation.id, scheduledAt: plan.scheduledAt, manualReviewId: review.id, reason: plan.reason });
  }

  return { planned, skipped };
}

async function flushRuntimePersistence(db: InMemoryDatabase): Promise<void> {
  if ("flushPersistence" in db && typeof db.flushPersistence === "function") {
    await db.flushPersistence();
  }
}

function dlqAudit(eventType: string, entityId: string, payload: Record<string, unknown>) {
  return createAuditEvent({
    entityType: "dead_letter_task",
    entityId,
    eventType,
    actor: "api",
    payload
  });
}
