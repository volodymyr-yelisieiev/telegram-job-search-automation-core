import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@job-search/config";
import { InMemoryDatabase, InMemoryQueueAdapter, InMemoryTaskRunStore, PostgresRuntimeDatabase } from "@job-search/db";
import { createAuditEvent, InterviewCoordinator, stableHash, type OutboundDispatchResult, type OutboundMessage, type ProofPack } from "@job-search/domain";
import { createFixtureProviderRegistry, createFixtureProviderRegistryWithOverrides } from "@job-search/providers";
import { createScoredFixtureJobs } from "@job-search/testing";
import { runLocalPipeline } from "../../apps/api/src/runtime";
import { buildServer } from "../../apps/api/src/server";
import { createTelegramCommandState, handleTelegramCommand } from "../../apps/telegram-bot/src/commands";
import { runApprovedSubmitWorker, runApplyWorker } from "../../apps/worker-apply/src/runner";
import { runCanaryWorker } from "../../apps/worker-canary/src/runner";
import { runDigestWorker, runQueuedDigestWorker } from "../../apps/worker-digest/src/runner";
import { runInboxWorker } from "../../apps/worker-inbox/src/runner";
import { runIngestWorker } from "../../apps/worker-ingest/src/runner";
import { runReplyWorker } from "../../apps/worker-reply/src/runner";
import {
  buildAcceptancePackage,
  buildGaSignoffChecklist,
  loadGaSignoffFile,
  loadReleaseEvidenceFile,
  parseGaSignoffFile,
  parseReleaseEvidenceRecords
} from "../../scripts/acceptance-package";
import { runAcceleratedSoak } from "../../scripts/accelerated-soak";
import { buildCanaryEvidenceReport, parseCanaryEvidenceResults } from "../../scripts/canary-evidence";
import { buildCalendarEvidenceReport, parseCalendarEvidenceInput } from "../../scripts/calendar-evidence";
import { buildGaSignoffValidationReport } from "../../scripts/ga-signoff-validate";
import { buildOutboundDispatchEvidenceReport, parseOutboundDispatchEvidenceInput } from "../../scripts/outbound-evidence";
import { buildProviderSubmitEvidenceReport, parseProviderSubmitEvidenceInput } from "../../scripts/provider-submit-evidence";
import { buildReleaseEvidenceValidationReport } from "../../scripts/release-evidence-validate";
import { buildSoakEvidenceReport, parseSoakEvidenceInput } from "../../scripts/soak-evidence";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const TEST_NOW = new Date("2026-05-18T00:00:00.000Z");

describe("API, Telegram and worker hardening", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("does not overwrite persisted Postgres mode with startup config defaults", async () => {
    const config = loadConfig({ APP_MODE: "controlled_auto_apply", IRREVERSIBLE_ACTIONS_ENABLED: "true", API_TOKEN: "test-token" });
    const db = new PostgresRuntimeDatabase({
      query: async () => ({ rows: [], rowCount: 1 })
    } as never);
    db.systemMode = "paused";
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });

    expect(db.systemMode).toBe("paused");
    await server.close();
  });

  it("requires auth, keeps mode consistent, and renders digest text", async () => {
    const config = loadConfig({ APP_MODE: "paused", API_TOKEN: "test-token", TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret" });
    const db = new InMemoryDatabase();
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });

    expect((await server.inject({ method: "GET", url: "/status" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ mode: "paused" });

    const status = await server.inject({ method: "GET", url: "/status", headers: auth(config.api.token) });
    const telegramStatus = await server.inject({ method: "GET", url: "/status/telegram", headers: auth(config.api.token) });
    expect(status.json().mode).toBe("paused");
    expect(telegramStatus.body).toContain("Mode: paused");

    expect(
      (await server.inject({ method: "POST", url: "/telegram/webhook", payload: { update_id: 1, message: { text: "/status", from: { id: 123 }, chat: { id: 456 } } } }))
        .statusCode
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: { "x-telegram-bot-api-secret-token": "fake-webhook-secret" },
          payload: { update_id: 2, message: { text: "/status", from: { id: 123 }, chat: { id: 456 } } }
        })
      ).statusCode
    ).toBe(401);
    const webhookStatus = await server.inject({
      method: "POST",
      url: "/telegram/webhook?source=telegram",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { update_id: 3, message: { text: "/status", from: { id: 123 }, chat: { id: 456 } } }
    });
    expect(webhookStatus.json()).toMatchObject({
      method: "sendMessage",
      chat_id: 456,
      disable_web_page_preview: true
    });
    expect(webhookStatus.json().text).toContain("Mode: paused");

    const nonCommandText = await server.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { update_id: 4, message: { text: "hello", from: { id: 123 }, chat: { id: 456 } } }
    });
    expect(nonCommandText.json()).toMatchObject({ ok: true, ignored: true, reason: "non_command_text" });

    const nonTextMessage = await server.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { update_id: 5, message: { from: { id: 123 }, chat: { id: 456 } } }
    });
    expect(nonTextMessage.json()).toMatchObject({ ok: true, ignored: true, reason: "non_text_message" });

    const noChat = await server.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { update_id: 6, message: { text: "/status", from: { id: 123 } } }
    });
    expect(noChat.json()).toMatchObject({ ok: true, accepted: true, responseHash: expect.any(String), responseLength: expect.any(Number) });

    const noWebhookSecretServer = await buildServer({
      config: loadConfig({ APP_MODE: "paused", API_TOKEN: "test-token" }),
      db: new InMemoryDatabase(),
      registry: createFixtureProviderRegistry()
    });
    expect(
      (
        await noWebhookSecretServer.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
          payload: { update_id: 7, message: { text: "/status", from: { id: 123 }, chat: { id: 456 } } }
        })
      ).statusCode
    ).toBe(401);
    await noWebhookSecretServer.close();

    const digest = await server.inject({ method: "GET", url: "/digest", headers: auth(config.api.token) });
    expect(digest.body).toContain("Pipeline\nDiscovered:");
    expect(digest.body).not.toContain('"stats"');

    await server.close();
  });

  it("guards Telegram webhook commands by secret token and allowed sender list", async () => {
    const config = loadConfig({
      API_TOKEN: "test-token",
      TELEGRAM_BOT_TOKEN: "live-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret"
    });
    const db = new InMemoryDatabase();
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });

    const denied = await server.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { update_id: 3, message: { text: "/pause", from: { id: 999 }, chat: { id: 456 } } }
    });
    expect(denied.json()).toMatchObject({ ok: true, ignored: true, reason: "sender_not_allowed" });
    expect(db.systemMode).toBe("review_first");

    const handled = await server.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { update_id: 4, message: { text: "/pause", from: { id: 123 }, chat: { id: 456 } } }
    });
    expect(handled.json()).toMatchObject({ method: "sendMessage", chat_id: 456 });
    expect(handled.json().text).toContain("paused");
    expect(db.systemMode).toBe("paused");

    await server.close();
  });

  it("runs pipeline with exact fixture counts and blocked policy status", async () => {
    const config = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const result = await runLocalPipeline({ config, db, registry: createFixtureProviderRegistry() });

    expect(result.normalized).toBe(4);
    expect(db.jobs.size).toBe(4);
    expect(db.applications.size).toBe(2);
    expect([...db.applications.values()].every((application) => application.status === "apply_blocked_by_policy")).toBe(true);
    expect(db.auditEvents.some((event) => event.eventType === "application_record_created")).toBe(true);
    expect(db.proofPacks.size).toBe(2);
    expect([...db.proofPacks.values()].every((proof) => proof.auditEventId)).toBe(true);
    expect(db.policyChecks.size).toBe(2);
    expect(db.searchRuns).toHaveLength(3);
    expect(db.searchRuns[0]).toMatchObject({ searchProfileId: db.searchProfile.searchProfileId, query: expect.any(String), filters: expect.any(Object) });
  });

  it("keeps read-only and blocked-provider ingest from creating apply artifacts", async () => {
    const readOnlyDb = new InMemoryDatabase();
    readOnlyDb.setMode({ nextMode: "read_only", actor: "test", reason: "roadmap read-only gate" });
    const readOnlyResult = await runLocalPipeline({
      config: loadConfig({ APP_MODE: "read_only", API_TOKEN: "test-token" }),
      db: readOnlyDb,
      registry: createFixtureProviderRegistry()
    });
    expect(readOnlyResult).toMatchObject({ normalized: 4, prepared: 0, manualReview: 0 });
    expect(readOnlyDb.applications.size).toBe(0);
    expect(readOnlyDb.proofPacks.size).toBe(0);

    const blockedRegistry = createFixtureProviderRegistry();
    blockedRegistry.get("hh").healthcheck = async () => ({
      providerId: "hh",
      status: "blocked",
      checkedAt: "2026-05-18T00:00:00.000Z",
      latencyMs: 1,
      message: "blocked by provider policy"
    });
    const blockedDb = new InMemoryDatabase();
    const blockedResult = await runIngestWorker({
      config: loadConfig({ API_TOKEN: "test-token" }),
      db: blockedDb,
      registry: blockedRegistry
    });
    expect(blockedResult.processed).toBe(2);
    expect([...blockedDb.jobs.values()].map((job) => job.sourceProvider)).not.toContain("hh");
    expect(blockedDb.searchRuns.find((run) => run.providerId === "hh")).toMatchObject({ stopCondition: "provider_blocked" });
  });

  it("branches pipeline applications by approval, allow, and CAPTCHA safe-mode results", async () => {
    const reviewConfig = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });
    const reviewDb = new InMemoryDatabase();
    reviewDb.candidateProfile.userConsent.autoApply = true;
    const reviewResult = await runLocalPipeline({ config: reviewConfig, db: reviewDb, registry: createFixtureProviderRegistry() });
    expect(reviewResult.manualReview).toBe(2);
    expect([...reviewDb.applications.values()].every((application) => application.status === "manual_review_required")).toBe(true);
    expect([...reviewDb.approvalRequests.values()]).toHaveLength(2);
    expect([...reviewDb.approvalRequests.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "application",
          requestedAction: "send_application",
          manualReviewId: expect.any(String),
          draftHash: expect.any(String)
        })
      ])
    );

    const allowConfig = loadConfig({
      APP_MODE: "controlled_auto_apply",
      IRREVERSIBLE_ACTIONS_ENABLED: "true",
      API_TOKEN: "test-token"
    });
    const allowDb = new InMemoryDatabase();
    allowDb.candidateProfile.userConsent.autoApply = true;
    await runLocalPipeline({ config: allowConfig, db: allowDb, registry: createFixtureProviderRegistry() });
    expect([...allowDb.applications.values()].every((application) => application.status === "application_prepared")).toBe(true);

    const captchaRegistry = createFixtureProviderRegistry();
    const hh = captchaRegistry.get("hh");
    const originalDryRun = hh.dryRunApplication.bind(hh);
    hh.dryRunApplication = async (draft) => ({
      ...(await originalDryRun(draft)),
      status: "failed",
      errors: ["captcha_required"]
    });
    const captchaDb = new InMemoryDatabase();
    captchaDb.candidateProfile.userConsent.autoApply = true;
    await runLocalPipeline({ config: allowConfig, db: captchaDb, registry: captchaRegistry });
    expect(captchaDb.providerHealth.get("hh")?.status).toBe("needs_review");
    expect([...captchaDb.applications.values()].some((application) => application.status === "apply_blocked_by_policy")).toBe(true);
  });

  it("records search-run errors and draft validation failures instead of preparing invalid applications", async () => {
    const config = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });

    const failingRegistry = createFixtureProviderRegistry();
    const failingProvider = failingRegistry.get("hh");
    failingProvider.fetchJob = async () => {
      throw new Error("fixture fetch failed");
    };
    const failingDb = new InMemoryDatabase();
    expect(await runLocalPipeline({ config, db: failingDb, registry: failingRegistry })).toMatchObject({ normalized: 2 });
    expect(failingDb.searchRuns.find((run) => run.providerId === "hh")?.stopCondition).toBe("completed_with_errors");

    const invalidRegistry = createFixtureProviderRegistry();
    const invalidProvider = invalidRegistry.get("hh");
    const originalNormalize = invalidProvider.normalizeJob.bind(invalidProvider);
    invalidProvider.normalizeJob = async (raw) => ({
      ...(await originalNormalize(raw)),
      id: `missing_provider_${raw.externalId}`,
      sourceProvider: "missing-provider"
    });
    const invalidDb = new InMemoryDatabase();
    invalidDb.candidateProfile.userConsent.autoApply = true;
    const invalidResult = await runLocalPipeline({ config, db: invalidDb, registry: invalidRegistry });
    expect(invalidResult.manualReview).toBe(2);
    expect([...invalidDb.applications.values()].some((application) => application.jobId.startsWith("missing_provider"))).toBe(false);
    expect([...invalidDb.manualReviewItems.values()].some((item) => item.reasonCode === "application_draft_validation_failed")).toBe(true);
  });

  it("supports API job success/404 and provider health endpoints", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });
    await server.inject({ method: "POST", url: "/ingest/run", headers: auth(config.api.token) });

    const found = await server.inject({ method: "GET", url: "/job/hh_hh-1001", headers: auth(config.api.token) });
    expect(found.statusCode).toBe(200);
    expect(found.body).toContain("Senior Node.js Backend Developer");

    const missing = await server.inject({ method: "GET", url: "/job/missing", headers: auth(config.api.token) });
    expect(missing.statusCode).toBe(404);

    const providers = await server.inject({ method: "GET", url: "/providers", headers: auth(config.api.token) });
    expect(providers.json()).toHaveLength(3);
    expect(providers.json()[0]).toMatchObject({
      providerId: expect.any(String),
      mode: "review_first",
      health: { status: expect.any(String) },
      capabilities: expect.any(Object),
      config: { enabled: true },
      readiness: { providerId: expect.any(String), recommendedStatus: expect.any(String) }
    });
    const readiness = await server.inject({ method: "GET", url: "/providers/readiness", headers: auth(config.api.token) });
    expect(readiness.json()).toHaveLength(3);

    await server.close();

    const configuredConfig = loadConfig({
      API_TOKEN: "test-token",
      PROVIDER_CONFIG_JSON: JSON.stringify([{ providerId: "hh", enabled: true, statusOverride: "stable" }])
    });
    const configuredDb = new InMemoryDatabase();
    configuredDb.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });
    configuredDb.recordReplayReport({
      flowRunId: "hh-flow-replay",
      status: "replayed",
      summary: "hh replay passed",
      reproducedError: null,
      recommendedAction: "none"
    });
    const configuredServer = await buildServer({ config: configuredConfig, db: configuredDb, registry: createFixtureProviderRegistry() });
    const onboarding = await configuredServer.inject({ method: "GET", url: "/providers/onboarding", headers: auth(configuredConfig.api.token) });
    const hhOnboarding = onboarding.json().find((item: { providerId: string }) => item.providerId === "hh");
    expect(hhOnboarding.checklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "canary_passed", passed: true }),
        expect.objectContaining({ code: "replay_available", passed: true }),
        expect.objectContaining({ code: "disable_switch_available", passed: true })
      ])
    );
    await configuredServer.close();

    const defaultServer = await buildServer({ config });
    expect((await defaultServer.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await defaultServer.close();
  });

  it("sweeps authenticated API endpoints with x-api-token and persisted local state", async () => {
    const config = loadConfig({ API_TOKEN: "test-token", IRREVERSIBLE_ACTIONS_ENABLED: "true" });
    class FlushingDatabase extends InMemoryDatabase {
      flushCount = 0;

      async flushPersistence(): Promise<void> {
        this.flushCount += 1;
      }
    }
    const db = new FlushingDatabase();
    db.candidateProfile.userConsent.autoReply = true;
    const [scored] = await createScoredFixtureJobs();
    expect(scored).toBeDefined();
    db.upsertJob(scored!.job);
    db.saveScore(scored!.job.id, scored!.score);
    const seededApplication = db.createApplication({
      jobId: scored!.job.id,
      providerId: scored!.job.sourceProvider,
      externalJobId: scored!.job.externalId,
      status: "applied",
      idempotencyKey: "apply:user-001:hh:hh-1001",
      dedupKey: "hh:hh-1001",
      draftVariantKey: "draft-hash-1",
      proofPackId: "proof-1",
      policyDecision: "allow",
      policyVersion: "test-policy"
    });
    db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "job",
      entityId: scored!.job.id,
      reasonCode: "test_review",
      severity: "low",
      recommendedAction: "Review seeded item"
    });
    const seededReviewId = [...db.manualReviewItems.values()][0]!.id;
    db.updateProviderHealth({
      providerId: "hh",
      status: "degraded",
      checkedAt: new Date().toISOString(),
      latencyMs: 5,
      message: "seeded degraded provider"
    });
    db.objectArtifacts.set("proof-1", {
      objectKey: "proof/1/metadata.json",
      artifactType: "proof_pack",
      entityId: "app-1",
      bytes: 0,
      createdAt: "2026-05-01T00:00:00.000Z"
    });
    db.objectArtifacts.set("screen-1", {
      objectKey: "proof/1/pre.png",
      artifactType: "screenshot",
      entityId: "app-1",
      bytes: 100,
      createdAt: "2026-05-01T00:00:00.000Z"
    });

    const inbound = db.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "msg-1",
      conversationExternalId: "conv-1",
      receivedAt: new Date().toISOString(),
      senderName: "Recruiter",
      text: "Thanks",
      linkedJobExternalId: scored!.job.externalId
    });
    db.saveMessageClassification({
      inboundMessageId: inbound.record.id,
      classification: {
        category: "acknowledgment",
        confidence: 0.9,
        requiresReply: false,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["seeded"]
      },
      llmOk: true
    });
    db.recordInterviewEvent(
      new InterviewCoordinator().createEvent({
        jobId: scored!.job.id,
        companyId: "company-1",
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" },
        link: "https://meet.example/1",
        recruiterName: "Recruiter"
      })
    );
    db.recordCanaryRun({ providerId: scored!.job.sourceProvider, status: "passed", checks: ["search"], failures: [] });
    db.recordCanaryRun({ providerId: scored!.job.sourceProvider, status: "failed", checks: ["apply_form"], failures: ["selector_missing"] });

    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });
    const headers = { "x-api-token": config.api.token };

    for (const route of [
      "/pipeline",
      "/data-quality",
      "/analytics",
      "/profiles",
      "/profiles/readiness",
      "/providers/onboarding",
      "/release-evidence",
      "/jobs",
      "/applications",
      "/manual-review",
      "/approval-requests",
      "/audit",
      "/logs/global",
      "/metrics",
      "/metrics/prometheus",
      "/dashboards",
      "/alerts",
      "/mode",
      "/queues",
      "/dlq",
      "/outbound",
      "/availability",
      "/retention",
      "/retention/enforcement",
      "/sources",
      "/release-gates",
      "/responses",
      "/interviews",
      "/digest"
    ]) {
      const response = await server.inject({ method: "GET", url: route, headers });
      expect(response.statusCode).toBe(200);
    }

    expect((await server.inject({ method: "GET", url: "/pipeline", headers })).json().stats.applied).toBe(1);
    expect((await server.inject({ method: "GET", url: "/metrics/prometheus", headers })).body).toContain("api_up");
    expect((await server.inject({ method: "GET", url: "/data-quality", headers })).json().totalJobs).toBe(1);
    expect((await server.inject({ method: "GET", url: "/analytics", headers })).json().preparedApplications).toBe(1);
    expect((await server.inject({ method: "GET", url: `/job/${scored!.job.id}`, headers })).json().timeline.map((item: { type: string }) => item.type)).toEqual(
      ["application", "inbound_message", "interview"]
    );
    expect((await server.inject({ method: "GET", url: "/profiles/readiness", headers })).json().text).toContain("Profile readiness");
    const invalidMode = await server.inject({ method: "POST", url: "/mode", headers, payload: { mode: "unsafe" } });
    expect(invalidMode.statusCode).toBe(400);
    const modeChange = await server.inject({ method: "POST", url: "/mode", headers, payload: { mode: "paused", reason: "test" } });
    expect(modeChange.json().mode).toBe("paused");
    expect((await server.inject({ method: "GET", url: "/logs/global", headers })).json()).toHaveLength(1);
    expect(db.flushCount).toBeGreaterThan(0);
    const simulatedPolicy = await server.inject({
      method: "POST",
      url: "/policy/simulate",
      headers,
      payload: { mode: "controlled_auto_apply", irreversibleActionsEnabled: true, rateLimitAvailable: false }
    });
    expect(simulatedPolicy.json().decision).toBe("deny");
    const missingReview = await server.inject({
      method: "POST",
      url: "/manual-review/missing/resolve",
      headers,
      payload: { resolution: "approved" }
    });
    expect(missingReview.statusCode).toBe(404);
    const invalidResolution = await server.inject({
      method: "POST",
      url: `/manual-review/${seededReviewId}/resolve`,
      headers,
      payload: { resolution: "invalid" }
    });
    expect(invalidResolution.statusCode).toBe(400);
    const resolvedReview = await server.inject({
      method: "POST",
      url: `/manual-review/${seededReviewId}/resolve`,
      headers,
      payload: { resolution: "approved", reason: "test" }
    });
    expect(resolvedReview.json().status).toBe("approved");
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/approval-requests",
          headers,
          payload: { entityType: "application", entityId: "app-1", requestedAction: "send_application" }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/approval-requests",
          headers,
          payload: {
            entityType: "application",
            entityId: "app-1",
            requestedAction: "send_application",
            expiresAt: "not-a-date"
          }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/approval-requests",
          headers,
          payload: {
            entityType: "outbound_message",
            entityId: "reply:missing-hash",
            requestedAction: "send_recruiter_reply",
            expiresAt: "2026-05-19T00:00:00.000Z"
          }
        })
      ).json()
    ).toMatchObject({ error: "draft_hash_required_for_irreversible_approval" });
    const approvalRequest = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
	          payload: {
	            entityType: "application",
	            entityId: seededApplication.id,
	            requestedAction: "send_application",
	            expiresAt: "2026-05-19T00:00:00.000Z",
	            draftHash: "draft-hash-1",
        manualReviewId: seededReviewId
      }
    });
    expect(approvalRequest.json()).toMatchObject({ status: "pending", draftHash: "draft-hash-1" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/approval-requests/${approvalRequest.json().id}/resolve`,
          headers,
          payload: { resolution: "invalid" }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/approval-requests/${approvalRequest.json().id}/resolve`,
          headers,
          payload: { resolution: "approved", now: "not-a-date" }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/approval-requests/${approvalRequest.json().id}/resolve`,
          headers,
          payload: { resolution: "approved", now: "2026-05-18T00:00:00.000Z" }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/approval-requests/${approvalRequest.json().id}/resolve`,
          headers,
          payload: { resolution: "approved", draftHash: "changed-hash", now: "2026-05-18T00:00:00.000Z" }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/approval-requests/${approvalRequest.json().id}/resolve`,
          headers,
          payload: { resolution: "approved", draftHash: "draft-hash-1", now: "2026-05-18T00:00:00.000Z" }
        })
      ).json()
    ).toMatchObject({ status: "approved", resolvedAt: "2026-05-18T00:00:00.000Z" });
    db.approvalRequests.get(approvalRequest.json().id)!.expiresAt = "2026-05-19T00:00:00.000Z";
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/approval-requests/${approvalRequest.json().id}/resolve`,
          headers,
          payload: { resolution: "approved", draftHash: "draft-hash-1", now: "2026-05-20T00:00:00.000Z" }
        })
      ).json()
    ).toMatchObject({ status: "expired", submitPlan: { enqueue: false } });
    const expiredApproval = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
      payload: {
        entityType: "outbound_message",
        entityId: "out-1",
        requestedAction: "send_recruiter_reply",
        expiresAt: "2026-05-17T00:00:00.000Z",
        draftHash: "reply-hash-1"
      }
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/approval-requests/${expiredApproval.json().id}/resolve`,
          headers,
          payload: { resolution: "approved", draftHash: "reply-hash-1", now: "2026-05-18T00:00:00.000Z" }
        })
      ).json()
    ).toMatchObject({ status: "expired" });
    expect((await server.inject({ method: "GET", url: "/queues", headers })).json().queues.length).toBeGreaterThan(0);
    expect((await server.inject({ method: "GET", url: "/providers/onboarding", headers })).json()).toHaveLength(3);
    expect((await server.inject({ method: "GET", url: "/release-evidence", headers })).json().summary.blockers).toContain(
      "missing_live_credentials_evidence"
    );
    expect((await server.inject({ method: "POST", url: "/release-evidence", headers, payload: { evidenceType: "unsafe", source: "test" } })).statusCode).toBe(400);
    expect(
      (await server.inject({ method: "POST", url: "/release-evidence", headers, payload: { evidenceType: "live_credentials_configured", status: "unknown", source: "test" } })).statusCode
    ).toBe(400);
    expect((await server.inject({ method: "POST", url: "/release-evidence", headers, payload: { evidenceType: "live_credentials_configured" } })).statusCode).toBe(400);
    const weakEvidence = await server.inject({
      method: "POST",
      url: "/release-evidence",
      headers,
      payload: { evidenceType: "live_credentials_configured", source: "test evidence", metadata: { ticket: "SEC-1" } }
    });
    expect(weakEvidence.statusCode).toBe(400);
    expect(weakEvidence.json()).toMatchObject({
      error: "invalid_release_evidence_metadata",
      failures: expect.arrayContaining([
        "secret_reference_ids_required",
        "credential_coverage_missing:hh|robota|telegram",
	        "telegram_bot_credential_required",
	        "checked_at_required",
	        "credentials_expires_at_required",
	        "live_evidence_source_required"
	      ])
	    });
    const localSourceEvidence = await server.inject({
      method: "POST",
      url: "/release-evidence",
      headers,
      payload: {
        evidenceType: "live_credentials_configured",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-05-19T00:00:00.000Z",
        source: "local credential workflow",
        metadata: {
          checkedAt: "2026-05-18T00:00:00.000Z",
          secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/robota/session", "vault://job-search/telegram/bot"],
          coveredProviderIds: ["hh", "robota", "telegram"],
          telegramBot: true
        }
      }
    });
    expect(localSourceEvidence.statusCode).toBe(400);
    expect(localSourceEvidence.json().failures).toContain("live_evidence_source_required");
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/release-evidence",
          headers,
          payload: { evidenceType: "live_credentials_configured", status: "failed", observedAt: "not-a-date", source: "failed credential check" }
        })
      ).json()
    ).toMatchObject({ error: "invalid_observedAt" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/release-evidence",
          headers,
          payload: { evidenceType: "live_credentials_configured", status: "failed", expiresAt: "not-a-date", source: "failed credential check" }
        })
      ).json()
    ).toMatchObject({ error: "invalid_expiresAt" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/release-evidence",
          headers,
          payload: {
            evidenceType: "live_credentials_configured",
            source: "expired credential check",
            expiresAt: "2000-01-02T00:00:00.000Z",
            metadata: {
              checkedAt: "2000-01-01T00:00:00.000Z",
              secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/robota/session", "vault://job-search/telegram/bot"],
              coveredProviderIds: ["hh", "robota", "telegram"],
              telegramBot: true
            }
          }
        })
      ).json()
    ).toMatchObject({ error: "expired_release_evidence" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/release-evidence",
          headers,
          payload: { evidenceType: "live_credentials_configured", status: "failed", source: "failed credential check", metadata: { ticket: "SEC-1" } }
        })
      ).json()
    ).toMatchObject({ evidenceType: "live_credentials_configured", status: "failed" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/release-evidence",
          headers,
          payload: {
            evidenceType: "live_credentials_configured",
            observedAt: "2026-05-18T00:00:00.000Z",
            source: "production credential workflow 9",
            expiresAt: "2026-05-19T00:00:00.000Z",
            metadata: {
              checkedAt: "2026-05-18T00:00:00.000Z",
              secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/robota/session", "vault://job-search/telegram/bot"],
              coveredProviderIds: ["hh", "robota", "telegram"],
              telegramBot: true
            }
          }
        })
      ).json()
    ).toMatchObject({ evidenceType: "live_credentials_configured", status: "passed" });
    expect((await server.inject({ method: "GET", url: "/release-gates", headers })).json()).toMatchObject({
      readyForLiveAutomation: false,
      blockers: expect.arrayContaining(["External secrets backend is not configured", "Live provider canaries are missing or failing"])
    });
    expect((await server.inject({ method: "GET", url: "/responses", headers })).json().responses).toHaveLength(1);
    db.saveMessageClassification({
      inboundMessageId: "orphan-classification",
      classification: {
        category: "request_for_details",
        confidence: 0.8,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: false,
        reasons: ["seeded orphan response"]
      },
      llmOk: true
    });
    expect((await server.inject({ method: "GET", url: "/responses", headers })).json().priority.map((item: { inboundMessageId: string }) => item.inboundMessageId)).toContain(
      "orphan-classification"
    );
    expect((await server.inject({ method: "GET", url: "/interviews", headers })).json().interviews).toHaveLength(1);
    expect((await server.inject({ method: "GET", url: "/retention", headers })).json().map((item: { artifactType: string }) => item.artifactType)).toEqual(
      expect.arrayContaining(["proof_pack", "screenshot", "recruiter_message"])
    );
    await server.inject({ method: "POST", url: "/mode", headers, payload: { mode: "review_first", reason: "outbound test" } });
    const schedule = await server.inject({
      method: "POST",
      url: "/schedule/decide",
      headers,
      payload: { proposedSlots: [{ date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" }] }
    });
    expect(schedule.json().status).toBe("propose_alternatives");
    expect((await server.inject({ method: "POST", url: "/schedule/decide", headers, payload: {} })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/schedule/confirmations", headers, payload: {} })).statusCode).toBe(400);
    expect(
      (await server.inject({ method: "POST", url: "/schedule/confirmations/missing/resolve", headers, payload: { resolution: "approved" } })).statusCode
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/schedule/confirmations",
          headers,
          payload: {
            jobId: "missing-job",
            conversationId: inbound.record.conversationId,
            slot: { date: "2026-05-21", time: "09:00", timezone: "Europe/Vienna" }
          }
        })
      ).statusCode
    ).toBe(404);
    const orphanConfirmation = new InterviewCoordinator().createPendingConfirmation({
      jobId: scored!.job.id,
      companyId: "company-orphan",
      conversationId: inbound.record.conversationId,
      slot: { date: "2026-05-22", time: "11:00", timezone: "Europe/Vienna" }
    });
    db.recordInterviewEvent(orphanConfirmation);
    expect(
      (await server.inject({ method: "POST", url: `/schedule/confirmations/${orphanConfirmation.interviewId}/resolve`, headers, payload: { resolution: "approved" } })).statusCode
    ).toBe(404);
    const policyBlockedConfirmation = await server.inject({
      method: "POST",
      url: "/schedule/confirmations",
      headers,
      payload: {
        jobId: scored!.job.id,
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna", durationMinutes: 45 }
      }
    });
    expect(policyBlockedConfirmation.statusCode).toBe(409);
    expect(policyBlockedConfirmation.json()).toMatchObject({
      error: "scheduling_policy_failed",
      policy: { decision: "deny", reasons: expect.arrayContaining(["Interview scheduling consent is missing"]) }
    });
    db.candidateProfile.userConsent.interviewScheduling = true;
    const pendingConfirmation = await server.inject({
      method: "POST",
      url: "/schedule/confirmations",
      headers,
      payload: {
        jobId: scored!.job.id,
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna", durationMinutes: 45 },
        link: "https://meet.example/review-first",
        recruiterName: "Recruiter"
      }
    });
    expect(pendingConfirmation.json()).toMatchObject({
      event: { status: "pending_confirmation" },
      approvalRequest: { requestedAction: "confirm_interview_slot" }
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/schedule/confirmations/${pendingConfirmation.json().event.interviewId}/resolve`,
          headers,
          payload: { resolution: "approved", draftHash: "wrong-hash" }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/schedule/confirmations/${pendingConfirmation.json().event.interviewId}/resolve`,
          headers,
          payload: { resolution: "unsafe" }
        })
      ).statusCode
    ).toBe(400);
    const changedSlotConfirmation = await server.inject({
      method: "POST",
      url: "/schedule/confirmations",
      headers,
      payload: {
        jobId: scored!.job.id,
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-25", time: "10:30", timezone: "Europe/Vienna" }
      }
    });
    const changedSlotEvent = changedSlotConfirmation.json().event;
    db.interviewEvents.set(changedSlotEvent.interviewId, {
      ...db.interviewEvents.get(changedSlotEvent.interviewId)!,
      dateTime: "2026-05-25T11:00:00"
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/schedule/confirmations/${changedSlotEvent.interviewId}/resolve`,
          headers,
          payload: { resolution: "approved", draftHash: changedSlotConfirmation.json().approvalRequest.draftHash }
        })
      ).json()
    ).toMatchObject({ error: "interview_slot_hash_required_or_mismatch" });
    const resolvedConfirmation = await server.inject({
      method: "POST",
      url: `/schedule/confirmations/${pendingConfirmation.json().event.interviewId}/resolve`,
      headers,
      payload: { resolution: "approved", draftHash: pendingConfirmation.json().approvalRequest.draftHash }
    });
    expect(resolvedConfirmation.json()).toMatchObject({ event: { status: "scheduled" }, approvalRequest: { status: "approved" } });
    const rejectedConfirmation = await server.inject({
      method: "POST",
      url: "/schedule/confirmations",
      headers,
      payload: {
        jobId: scored!.job.id,
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-26", time: "10:30", timezone: "Europe/Vienna" }
      }
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/schedule/confirmations/${rejectedConfirmation.json().event.interviewId}/resolve`,
          headers,
          payload: { resolution: "rejected", draftHash: rejectedConfirmation.json().approvalRequest.draftHash }
        })
      ).json()
    ).toMatchObject({ event: { status: "cancelled" }, approvalRequest: { status: "rejected" } });
    expect(
      (await server.inject({ method: "POST", url: "/artifacts/access", headers, payload: { artifactId: "proof-1", requesterRole: "viewer", purpose: "debug", containsSensitiveData: true } })).json()
    ).toMatchObject({ allowed: false });
    expect((await server.inject({ method: "POST", url: "/artifacts/access", headers, payload: { artifactId: "proof-1" } })).statusCode).toBe(400);

    const outboundText = "Thank you for the update.";
    const outboundIdempotencyKey = `reply:${inbound.record.conversationId}:${inbound.record.id}:acknowledgment`;
    const outboundApproval = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
      payload: {
        entityType: "outbound_message",
        entityId: outboundIdempotencyKey,
        requestedAction: "send_recruiter_reply",
        expiresAt: "2026-05-19T00:00:00.000Z",
        draftHash: stableHash(outboundText)
      }
    });
    const mismatchedOutboundApproval = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
      payload: {
        entityType: "outbound_message",
        entityId: outboundIdempotencyKey,
        requestedAction: "send_recruiter_reply",
        expiresAt: "2026-05-19T00:00:00.000Z",
        draftHash: "wrong-hash"
      }
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/outbound/dispatch/review-first",
          headers,
          payload: {
            providerId: "hh",
            accountId: "fixture-account",
            conversationId: inbound.record.conversationId,
            inboundMessageId: inbound.record.id,
            category: "acknowledgment",
            text: outboundText,
            approval: "approved"
          }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/outbound/dispatch/review-first",
          headers,
          payload: {
            providerId: "hh",
            accountId: "fixture-account",
            conversationId: inbound.record.conversationId,
            inboundMessageId: inbound.record.id,
            category: "acknowledgment",
            text: outboundText,
            approval: "approved",
            approvalRequestId: mismatchedOutboundApproval.json().id
          }
        })
      ).statusCode
    ).toBe(409);
    const expiredOutboundText = "I am based in Vienna.";
    const expiredOutboundApproval = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
      payload: {
        entityType: "outbound_message",
        entityId: `reply:${inbound.record.conversationId}:${inbound.record.id}:location_reply`,
        requestedAction: "send_recruiter_reply",
        expiresAt: "2026-05-17T00:00:00.000Z",
        draftHash: stableHash(expiredOutboundText)
      }
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/outbound/dispatch/review-first",
          headers,
          payload: {
            providerId: "hh",
            accountId: "fixture-account",
            conversationId: inbound.record.conversationId,
            inboundMessageId: inbound.record.id,
            category: "location_reply",
            text: expiredOutboundText,
            approval: "approved",
            approvalRequestId: expiredOutboundApproval.json().id
          }
        })
      ).statusCode
    ).toBe(409);
    const outbound = await server.inject({
      method: "POST",
      url: "/outbound/dispatch/review-first",
      headers,
      payload: {
        providerId: "hh",
        accountId: "fixture-account",
        conversationId: inbound.record.conversationId,
        inboundMessageId: inbound.record.id,
        category: "acknowledgment",
        text: outboundText,
        approval: "approved",
        approvalRequestId: outboundApproval.json().id
      }
    });
    expect(outbound.json().record.status).toBe("dry_run_recorded");
    const defaultOutbound = await server.inject({
      method: "POST",
      url: "/outbound/dispatch/review-first",
      headers,
      payload: {
        conversationId: inbound.record.conversationId,
        inboundMessageId: "msg-default",
        text: "Thank you."
      }
    });
    expect(defaultOutbound.json().record.providerId).toBe("fixture");
    expect(defaultOutbound.json().record.status).toBe("blocked");
    const conflictInbound = db.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "api-conflict-msg",
      conversationExternalId: "api-conflict-conv",
      receivedAt: "2026-05-18T00:00:00.000Z",
      senderName: "Recruiter",
      text: "I am not available then, can we find another time?",
      linkedJobExternalId: null
    });
    const conflictText = "I can attend and confirm this time.";
    const conflictApproval = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
      payload: {
        entityType: "outbound_message",
        entityId: `reply:${conflictInbound.record.conversationId}:${conflictInbound.record.id}:acknowledgment`,
        requestedAction: "send_recruiter_reply",
        expiresAt: "2026-05-19T00:00:00.000Z",
        draftHash: stableHash(conflictText)
      }
    });
    const contradictoryOutbound = await server.inject({
      method: "POST",
      url: "/outbound/dispatch/review-first",
      headers,
      payload: {
        providerId: "hh",
        accountId: "fixture-account",
        conversationId: conflictInbound.record.conversationId,
        inboundMessageId: conflictInbound.record.id,
        category: "acknowledgment",
        text: conflictText,
        approval: "approved",
        approvalRequestId: conflictApproval.json().id
      }
    });
    expect(contradictoryOutbound.json().record.status).toBe("blocked");
    expect(contradictoryOutbound.json().policy.reasons).toContain("Validation failed");
    expect([...db.manualReviewItems.values()].map((item) => item.reasonCode)).toContain("reply_thread_context_conflict");
    expect((await server.inject({ method: "GET", url: "/outbound", headers })).json()).toHaveLength(3);
    expect((await server.inject({ method: "GET", url: "/analytics", headers })).json().dimensioned.dimensions["time_window:30d"].responses).toBeGreaterThan(0);
    expect((await server.inject({ method: "POST", url: "/outbound/dispatch/review-first", headers, payload: {} })).statusCode).toBe(400);

    await server.close();
  });

  it("reports queue backlog age through queues and alerts endpoints", async () => {
    const config = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });
    const queue = new InMemoryQueueAdapter();
    const task = await queue.enqueue("auto_apply_queue", { applicationId: "app-backlog" }, {
      idempotencyKey: "apply:backlog",
      deduplicationKey: "app-backlog"
    });
    task.createdAt = new Date(Date.now() - 600_000).toISOString();
    const replyTask = await queue.enqueue("reply_dispatch_queue", { outboundMessageId: "out-backlog" }, {
      idempotencyKey: "reply:backlog",
      deduplicationKey: "out-backlog"
    });
    replyTask.createdAt = new Date(Date.now() - 700_000).toISOString();
    const server = await buildServer({ config, db: new InMemoryDatabase(), registry: createFixtureProviderRegistry(), queue });
    const headers = auth(config.api.token);

    const queues = (await server.inject({ method: "GET", url: "/queues", headers })).json();
    expect(queues.queues.find((item: { queueName: string }) => item.queueName === "auto_apply_queue")).toMatchObject({
      depth: 1,
      oldestAgeSeconds: expect.any(Number)
    });
    expect(queues.queues.find((item: { queueName: string }) => item.queueName === "auto_apply_queue").oldestAgeSeconds).toBeGreaterThanOrEqual(599);
    const alerts = (await server.inject({ method: "GET", url: "/alerts", headers })).json();
    expect(alerts.find((alert: { code: string }) => alert.code === "queue_backlog_age")).toMatchObject({
      triggered: true,
      labels: { queueName: "reply_dispatch_queue", depth: "1" }
    });

    await server.close();
  });

  it("reports suppressed duplicate application attempts through alerts", async () => {
    const config = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const applicationInput = {
      jobId: "job-duplicate",
      providerId: "hh",
      externalJobId: "hh-duplicate",
      status: "application_prepared",
      idempotencyKey: "apply:duplicate",
      dedupKey: "hh:duplicate"
    };
    const first = db.createApplication(applicationInput);
    expect(db.createApplication(applicationInput).id).toBe(first.id);
    expect(db.auditEvents.some((event) => event.eventType === "application_duplicate_suppressed")).toBe(true);
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });

    const alerts = (await server.inject({ method: "GET", url: "/alerts", headers: auth(config.api.token) })).json();
    expect(alerts.find((alert: { code: string }) => alert.code === "duplicate_application_attempted")).toMatchObject({
      triggered: true
    });

    await server.close();
  });

  it("reports outbound reply safety alerts through alerts endpoint", async () => {
    const config = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "inbound_message",
      entityId: "inbound-unsupported",
      reasonCode: "reply_draft_validation_failed",
      severity: "medium",
      recommendedAction: "Review reply draft: unsupported_fact:salary"
    });
    db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "inbound_message",
      entityId: "inbound-conflict",
      reasonCode: "reply_thread_context_conflict",
      severity: "high",
      recommendedAction: "Review contradiction flags before dispatch"
    });
    const outboundMessage: OutboundMessage = {
      conversationId: "conv-alert",
      inboundMessageId: "inbound-alert",
      category: "acknowledgment",
      language: "en",
      text: "Thanks.",
      factsUsed: [],
      idempotencyKey: "reply:conv-alert:inbound-alert:ack"
    };
    const outboundResult: OutboundDispatchResult = {
      status: "blocked",
      deliveryId: null,
      errors: ["delivery_failed"],
      proof: {
        proofId: "proof-alert",
        outboundMessageId: "outbound-alert",
        providerId: "telegram",
        accountId: "bot",
        conversationId: outboundMessage.conversationId,
        inboundMessageId: outboundMessage.inboundMessageId,
        idempotencyKey: outboundMessage.idempotencyKey,
        transport: "telegram",
        status: "blocked",
        textHash: "text-hash",
        validationHash: "validation-hash",
        policyDecision: "deny",
        createdAt: "2026-05-18T00:00:00.000Z",
        deliveredAt: null
      }
    };
    db.recordOutboundDispatch({ providerId: "telegram", accountId: "bot", message: outboundMessage, result: outboundResult, actor: "test" });
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });

    const alerts = (await server.inject({ method: "GET", url: "/alerts", headers: auth(config.api.token) })).json();
    expect(alerts.filter((alert: { triggered: boolean }) => alert.triggered).map((alert: { code: string }) => alert.code)).toEqual(
      expect.arrayContaining(["unsupported_fact_attempted", "reply_validation_spike", "thread_contradiction_detected", "outbound_delivery_failure"])
    );

    await server.close();
  });

  it("plans conservative follow-ups without duplicate review items", async () => {
    const config = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const dueInbound = db.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "follow-up-due",
      conversationExternalId: "follow-up-conv",
      receivedAt: "2026-05-14T00:00:00.000Z",
      senderName: "Recruiter",
      text: "Thanks, please send details.",
      linkedJobExternalId: null
    });
    db.saveMessageClassification({
      inboundMessageId: dueInbound.record.id,
      classification: {
        category: "recruiter_outreach",
        confidence: 0.91,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["follow-up fixture"]
      },
      llmOk: true
    });
    const rejectedInbound = db.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "follow-up-rejected",
      conversationExternalId: "follow-up-rejected-conv",
      receivedAt: "2026-05-14T00:00:00.000Z",
      senderName: "Recruiter",
      text: "We decided not to proceed.",
      linkedJobExternalId: null
    });
    db.saveMessageClassification({
      inboundMessageId: rejectedInbound.record.id,
      classification: {
        category: "rejection",
        confidence: 0.92,
        requiresReply: false,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: false,
        reasons: ["follow-up stop fixture"]
      },
      llmOk: true
    });
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });
    const headers = auth(config.api.token);

    const first = await server.inject({
      method: "POST",
      url: "/follow-ups/plan",
      headers,
      payload: { now: "2026-05-18T00:00:00.000Z" }
    });
    expect(first.json().planned).toHaveLength(1);
    expect(first.json().skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "thread_closed" })]));
    expect([...db.manualReviewItems.values()].filter((item) => item.reasonCode === "follow_up_due")).toHaveLength(1);
    const second = await server.inject({
      method: "POST",
      url: "/follow-ups/plan",
      headers,
      payload: { now: "2026-05-18T00:00:00.000Z" }
    });
    expect(second.json().planned[0]).toMatchObject({ reason: "follow_up_already_pending" });
    expect([...db.manualReviewItems.values()].filter((item) => item.reasonCode === "follow_up_due")).toHaveLength(1);
    expect((await server.inject({ method: "POST", url: "/follow-ups/plan", headers, payload: { now: "invalid" } })).statusCode).toBe(400);

    await server.close();
  });

  it("derives release gate provider readiness from accepted release-evidence canaries", async () => {
    const config = loadConfig({
      API_TOKEN: "test-token",
      PROVIDER_CONFIG_JSON: JSON.stringify([
        { providerId: "hh", enabled: true, statusOverride: "stable" },
        { providerId: "robota", enabled: true, statusOverride: "stable" }
      ])
    });
    const db = new InMemoryDatabase();
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });
    const headers = auth(config.api.token);

    for (const providerId of ["hh", "robota", "telegram"]) {
      const response = await server.inject({
        method: "POST",
        url: "/release-evidence",
        headers,
        payload: {
          evidenceType: "live_canary_passed",
          providerId,
          source: "production provider canary workflow run 900",
          observedAt: "2026-05-18T00:00:00.000Z",
          expiresAt: "2099-01-02T00:00:00.000Z",
          metadata: {
            canaryRunId: `canary-${providerId}-900`,
            checkedAt: "2026-05-18T00:00:00.000Z",
            result: "passed"
          }
        }
      });
      expect(response.statusCode).toBe(200);
    }

    const releaseGate = (await server.inject({ method: "GET", url: "/release-gates", headers })).json();
    expect(releaseGate.blockers).not.toContain("Providers not ready: hh, robota");
    expect(releaseGate.blockers).not.toContain("Live provider canaries are missing or failing");
    expect(releaseGate.blockers).toEqual(expect.arrayContaining(["Live provider/Telegram credentials are not configured", "Provider submit proof is not ready"]));

    await server.close();
  });

  it("triages DLQ items through API with audited idempotent retry", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const taskRunStore = new InMemoryTaskRunStore();
    const queue = new InMemoryQueueAdapter(taskRunStore);
    const task = await queue.enqueue("auto_apply_queue", { applicationId: "app-1" }, { idempotencyKey: "apply:dlq", deduplicationKey: "app-1" });
    taskRunStore.markRunning(task.id);
    const deadLetter = taskRunStore.moveToDeadLetter(task.id, { code: "captcha_required", message: "CAPTCHA" });
    expect(deadLetter).not.toBeNull();
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry(), queue, taskRunStore });
    const headers = auth(config.api.token);

    expect((await server.inject({ method: "GET", url: "/dlq?status=open", headers })).json()).toHaveLength(1);
    expect((await server.inject({ method: "GET", url: "/dlq?status=invalid", headers })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: `/dlq/${deadLetter!.id}/assign`, headers, payload: {} })).statusCode).toBe(400);
    expect(
      (await server.inject({ method: "POST", url: `/dlq/${deadLetter!.id}/assign`, headers, payload: { assignee: "ops", note: "triage" } })).json()
    ).toMatchObject({ status: "assigned", assignedTo: "ops" });
    const assignNoNoteTask = await queue.enqueue("auto_apply_queue", { applicationId: "app-assign" }, { idempotencyKey: "apply:assign-no-note", deduplicationKey: "app-assign" });
    taskRunStore.markRunning(assignNoNoteTask.id);
    const assignNoNote = taskRunStore.moveToDeadLetter(assignNoNoteTask.id, { code: "captcha_required", message: "CAPTCHA" });
    expect(assignNoNote).not.toBeNull();
    expect(
      (await server.inject({ method: "POST", url: `/dlq/${assignNoNote!.id}/assign`, headers, payload: { assignee: "ops" } })).json()
    ).toMatchObject({ status: "assigned", assignedTo: "ops", resolutionNote: "assigned by api" });
    const retry = await server.inject({ method: "POST", url: `/dlq/${deadLetter!.id}/retry`, headers, payload: { note: "retry once" } });
    expect(retry.json().retryTask.id).toContain("retry_queue");
    expect((await server.inject({ method: "POST", url: `/dlq/${deadLetter!.id}/resolve`, headers, payload: {} })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: `/dlq/${deadLetter!.id}/assign`, headers, payload: { assignee: "ops" } })).statusCode).toBe(404);
    expect(db.auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["dead_letter_assigned", "dead_letter_retry_queued"])
    );

    const resolveTask = await queue.enqueue("auto_apply_queue", { applicationId: "app-2" }, { idempotencyKey: "apply:resolve", deduplicationKey: "app-2" });
    taskRunStore.markRunning(resolveTask.id);
    const resolved = taskRunStore.moveToDeadLetter(resolveTask.id, { code: "selector_missing", message: "missing" });
    expect(resolved).not.toBeNull();
    expect(
      (await server.inject({ method: "POST", url: `/dlq/${resolved!.id}/resolve`, headers, payload: { note: "fixed selector" } })).json()
    ).toMatchObject({ status: "resolved", resolutionNote: "fixed selector" });

    const resolveNoNoteTask = await queue.enqueue("auto_apply_queue", { applicationId: "app-4" }, { idempotencyKey: "apply:resolve-no-note", deduplicationKey: "app-4" });
    taskRunStore.markRunning(resolveNoNoteTask.id);
    const resolvedNoNote = taskRunStore.moveToDeadLetter(resolveNoNoteTask.id, { code: "selector_missing", message: "missing" });
    expect(resolvedNoNote).not.toBeNull();
    expect(
      (await server.inject({ method: "POST", url: `/dlq/${resolvedNoNote!.id}/resolve`, headers, payload: {} })).json()
    ).toMatchObject({ status: "resolved", resolutionNote: null });

    const retryDefaultTask = await queue.enqueue("auto_apply_queue", { applicationId: "app-3" }, { idempotencyKey: "apply:retry-default", deduplicationKey: "app-3" });
    taskRunStore.markRunning(retryDefaultTask.id);
    const retryDefault = taskRunStore.moveToDeadLetter(retryDefaultTask.id, { code: "provider_terms_block", message: "terms" });
    expect(retryDefault).not.toBeNull();
    expect(
      (await server.inject({ method: "POST", url: `/dlq/${retryDefault!.id}/retry`, headers, payload: {} })).json().deadLetter.resolutionNote
    ).toContain("Retry queued:");

    const discardTask = await queue.enqueue("reply_dispatch_queue", { outboundMessageId: "out-1" }, { idempotencyKey: "reply:dlq", deduplicationKey: "out-1" });
    taskRunStore.markRunning(discardTask.id);
    const discarded = taskRunStore.moveToDeadLetter(discardTask.id, { code: "policy_failed", message: "policy" });
    expect(discarded).not.toBeNull();
    expect(
      (await server.inject({ method: "POST", url: `/dlq/${discarded!.id}/discard`, headers, payload: { note: "not retryable" } })).json()
    ).toMatchObject({ status: "discarded" });

    const discardNoNoteTask = await queue.enqueue("reply_dispatch_queue", { outboundMessageId: "out-2" }, { idempotencyKey: "reply:discard-no-note", deduplicationKey: "out-2" });
    taskRunStore.markRunning(discardNoNoteTask.id);
    const discardedNoNote = taskRunStore.moveToDeadLetter(discardNoNoteTask.id, { code: "policy_failed", message: "policy" });
    expect(discardedNoNote).not.toBeNull();
    expect(
      (await server.inject({ method: "POST", url: `/dlq/${discardedNoNote!.id}/discard`, headers, payload: {} })).json()
    ).toMatchObject({ status: "discarded", resolutionNote: null });
    expect((await server.inject({ method: "POST", url: "/dlq/missing/retry", headers, payload: {} })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: "/dlq/missing/discard", headers, payload: {} })).statusCode).toBe(404);

    await server.close();
  });

  it("queues approved application submit tasks when irreversible actions are enabled", async () => {
    const config = loadConfig({
      APP_MODE: "controlled_auto_apply",
      IRREVERSIBLE_ACTIONS_ENABLED: "true",
      API_TOKEN: "test-token"
    });
    const db = new InMemoryDatabase();
    const taskRunStore = new InMemoryTaskRunStore();
    const queue = new InMemoryQueueAdapter(taskRunStore);
    const application = db.createApplication({
      jobId: "job-approval",
      providerId: "hh",
      externalJobId: "hh-approval",
      status: "application_prepared",
      idempotencyKey: "apply:user-001:hh:approval",
      dedupKey: "hh:approval",
      draftVariantKey: "draft-hash-approved"
    });
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry(), queue, taskRunStore });
    const headers = auth(config.api.token);
    const approval = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
      payload: {
        entityType: "application",
        entityId: application.id,
        requestedAction: "send_application",
        expiresAt: "2026-05-19T00:00:00.000Z",
        draftHash: "draft-hash-approved"
      }
    });
    const resolved = await server.inject({
      method: "POST",
      url: `/approval-requests/${approval.json().id}/resolve`,
      headers,
      payload: { resolution: "approved", draftHash: "draft-hash-approved", now: "2026-05-18T00:00:00.000Z" }
    });

    expect(resolved.json()).toMatchObject({
      status: "approved",
      submitPlan: { enqueue: true },
      queuedTask: { queueName: "auto_apply_queue", payload: { applicationId: application.id } }
    });
    expect(await queue.depth("auto_apply_queue")).toBe(1);

    await server.close();
  });

  it("blocks approved submit worker when history-backed application limits are exhausted", async () => {
    const config = loadConfig({ APP_MODE: "controlled_auto_apply", IRREVERSIBLE_ACTIONS_ENABLED: "true", API_TOKEN: "test-token" });
    const registry = createFixtureProviderRegistry();
    const db = new InMemoryDatabase();
    db.candidateProfile.userConsent.autoApply = true;
    db.candidateProfile.rateLimits.applicationsPerHour = 1;
    db.candidateProfile.rateLimits.applicationsPerDay = 1;
    db.candidateProfile.rateLimits.maxPerCompanyPerDay = 1;
    db.candidateProfile.rateLimits.maxPerCompanyPerWeek = 1;
    db.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "rate limit regression" });
    const fixture = (await createScoredFixtureJobs()).find((item) => item.job.sourceProvider === "hh")!;
    db.upsertJob(fixture.job);
    db.saveScore(fixture.job.id, { ...fixture.score, score: 90, decision: "shortlisted", hardRejections: [] });
    db.saveDedupDecision(fixture.job, { status: "new", confidence: 1, matchedEntities: [], actions: ["continue"] });
    db.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });
    const existingProof = db.recordProofPack({ proofPack: makeProofPack("existing-proof", fixture.job.id), entityType: "application", entityId: "existing", actor: "test" });
    const targetProof = db.recordProofPack({ proofPack: makeProofPack("target-proof", fixture.job.id), entityType: "application", entityId: "target", actor: "test" });
    db.createApplication({
      jobId: fixture.job.id,
      providerId: "hh",
      externalJobId: `${fixture.job.externalId}-existing`,
      status: "applied",
      idempotencyKey: "apply:user-001:hh:existing-rate-limit",
      dedupKey: "hh:existing-rate-limit",
      proofPackId: existingProof.proofPackId,
      policyDecision: "allow",
      policyVersion: "test"
    });
    const target = db.createApplication({
      jobId: fixture.job.id,
      providerId: "hh",
      externalJobId: fixture.job.externalId,
      status: "application_prepared",
      idempotencyKey: "apply:user-001:hh:target-rate-limit",
      dedupKey: "hh:target-rate-limit",
      proofPackId: targetProof.proofPackId,
      policyDecision: "allow",
      policyVersion: "test"
    });

    const result = await runApprovedSubmitWorker({ config, db, registry, applicationId: target.id, ...approveApplication(db, target) });

    expect(result.status).toBe("blocked");
    expect(result.policy).toMatchObject({ decision: "deny" });
    expect(result.guard.checks.find((check) => check.name === "rate_limit_available")).toMatchObject({ passed: false });
    expect([...db.manualReviewItems.values()].at(-1)?.recommendedAction).toContain("company_applications_per_day_exhausted");
  });

  it("requires a fresh canary and matching submit-boundary proof before approved submit", async () => {
    const config = loadConfig({ APP_MODE: "controlled_auto_apply", IRREVERSIBLE_ACTIONS_ENABLED: "true", API_TOKEN: "test-token" });
    const fixture = (await createScoredFixtureJobs()).find((item) => item.job.sourceProvider === "hh")!;
    const registry = createFixtureProviderRegistry();
    const staleCanaryDb = new InMemoryDatabase();
    staleCanaryDb.candidateProfile.userConsent.autoApply = true;
    staleCanaryDb.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "stale canary regression" });
    staleCanaryDb.upsertJob(fixture.job);
    staleCanaryDb.saveScore(fixture.job.id, { ...fixture.score, score: 90, decision: "shortlisted", hardRejections: [] });
    staleCanaryDb.saveDedupDecision(fixture.job, { status: "new", confidence: 1, matchedEntities: [], actions: ["continue"] });
    const staleProof = staleCanaryDb.recordProofPack({
      proofPack: makeProofPack("stale-canary-proof", fixture.job.id),
      entityType: "application",
      entityId: "stale-canary",
      actor: "test"
    });
    const staleApp = staleCanaryDb.createApplication({
      jobId: fixture.job.id,
      providerId: "hh",
      externalJobId: fixture.job.externalId,
      status: "application_prepared",
      idempotencyKey: "apply:user-001:hh:stale-canary",
      dedupKey: "hh:stale-canary",
      proofPackId: staleProof.proofPackId,
      policyDecision: "allow",
      policyVersion: "test"
    });
    const staleCanary = staleCanaryDb.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });
    staleCanary.createdAt = "2000-01-01T00:00:00.000Z";

    const staleResult = await runApprovedSubmitWorker({ config, db: staleCanaryDb, registry, applicationId: staleApp.id, ...approveApplication(staleCanaryDb, staleApp) });

    expect(staleResult.status).toBe("blocked");
    expect(staleResult.guard.checks.find((check) => check.name === "recent_canary_passed")).toMatchObject({ passed: false });

    const badProofDb = new InMemoryDatabase();
    badProofDb.candidateProfile.userConsent.autoApply = true;
    badProofDb.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "bad proof regression" });
    badProofDb.upsertJob(fixture.job);
    badProofDb.saveScore(fixture.job.id, { ...fixture.score, score: 90, decision: "shortlisted", hardRejections: [] });
    badProofDb.saveDedupDecision(fixture.job, { status: "new", confidence: 1, matchedEntities: [], actions: ["continue"] });
    const badProof = badProofDb.recordProofPack({
      proofPack: {
        ...makeProofPack("bad-submit-proof", fixture.job.id),
        provider: "robota",
        entityId: "wrong-job-id",
        finalStatus: "failed",
        errorCode: "captcha_required",
        completedAt: null,
        preActionScreenshotKey: null,
        domSnapshotBeforeKey: null
      },
      entityType: "application",
      entityId: "bad-proof",
      actor: "test"
    });
    const badProofApp = badProofDb.createApplication({
      jobId: fixture.job.id,
      providerId: "hh",
      externalJobId: fixture.job.externalId,
      status: "application_prepared",
      idempotencyKey: "apply:user-001:hh:bad-proof",
      dedupKey: "hh:bad-proof",
      proofPackId: badProof.proofPackId,
      policyDecision: "allow",
      policyVersion: "test"
    });
    badProofDb.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });

    const badProofResult = await runApprovedSubmitWorker({ config, db: badProofDb, registry, applicationId: badProofApp.id, ...approveApplication(badProofDb, badProofApp) });

    expect(badProofResult.status).toBe("blocked");
    expect(badProofResult.guard.checks.find((check) => check.name === "proof_ready")).toMatchObject({ passed: false });
    expect([...badProofDb.manualReviewItems.values()].at(-1)?.recommendedAction).toContain("proof_provider_mismatch");
  });

  it("blocks API approval enqueue when submit rate limits are exhausted", async () => {
    const config = loadConfig({ APP_MODE: "controlled_auto_apply", IRREVERSIBLE_ACTIONS_ENABLED: "true", API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    db.candidateProfile.rateLimits.applicationsPerHour = 1;
    db.candidateProfile.rateLimits.applicationsPerDay = 1;
    db.candidateProfile.rateLimits.maxPerCompanyPerDay = 1;
    db.candidateProfile.rateLimits.maxPerCompanyPerWeek = 1;
    const fixture = (await createScoredFixtureJobs()).find((item) => item.job.sourceProvider === "hh")!;
    db.upsertJob(fixture.job);
    db.createApplication({
      jobId: fixture.job.id,
      providerId: "hh",
      externalJobId: `${fixture.job.externalId}-api-existing`,
      status: "applied",
      idempotencyKey: "apply:user-001:hh:api-existing",
      dedupKey: "hh:api-existing"
    });
    const application = db.createApplication({
      jobId: fixture.job.id,
      providerId: "hh",
      externalJobId: `${fixture.job.externalId}-api-target`,
      status: "application_prepared",
      idempotencyKey: "apply:user-001:hh:api-target",
      dedupKey: "hh:api-target",
      draftVariantKey: "api-rate-limited-draft"
    });
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry(), queue: new InMemoryQueueAdapter() });
    const headers = auth(config.api.token);
    const approval = await server.inject({
      method: "POST",
      url: "/approval-requests",
      headers,
      payload: {
        entityType: "application",
        entityId: application.id,
        requestedAction: "send_application",
        expiresAt: "2026-05-19T00:00:00.000Z",
        draftHash: "api-rate-limited-draft"
      }
    });
    const resolved = await server.inject({
      method: "POST",
      url: `/approval-requests/${approval.json().id}/resolve`,
      headers,
      payload: { resolution: "approved", draftHash: "api-rate-limited-draft", now: "2026-05-18T00:00:00.000Z" }
    });

    expect(resolved.statusCode).toBe(409);
    expect(resolved.json()).toMatchObject({ error: "submit_policy_failed", policy: { decision: "deny" } });
    expect(resolved.json().policy.reasons).toEqual(expect.arrayContaining(["applications_per_hour_exhausted"]));
    expect(db.approvalRequests.get(approval.json().id)?.status).toBe("pending");
    await server.close();
  });

  it("blocks approved interview confirmation execution when irreversible actions are disabled", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    db.candidateProfile.userConsent.interviewScheduling = true;
    const [scored] = await createScoredFixtureJobs();
    db.upsertJob(scored!.job);
    const inbound = db.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "interview-disabled",
      conversationExternalId: "conv-interview-disabled",
      receivedAt: "2026-05-18T00:00:00.000Z",
      senderName: "Recruiter",
      text: "Can we meet?",
      linkedJobExternalId: scored!.job.externalId
    });
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });
    const headers = auth(config.api.token);
    const pending = await server.inject({
      method: "POST",
      url: "/schedule/confirmations",
      headers,
      payload: {
        jobId: scored!.job.id,
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna", durationMinutes: 45 }
      }
    });
    expect(pending.statusCode).toBe(200);

    const resolved = await server.inject({
      method: "POST",
      url: `/schedule/confirmations/${pending.json().event.interviewId}/resolve`,
      headers,
      payload: { resolution: "approved", draftHash: pending.json().approvalRequest.draftHash }
    });

    expect(resolved.statusCode).toBe(409);
    expect(resolved.json()).toMatchObject({
      error: "scheduling_policy_failed",
      policy: { decision: "requires_user_approval", reasons: expect.arrayContaining(["Review-first or disabled irreversible-action mode requires user approval"]) }
    });
    expect(db.interviewEvents.get(pending.json().event.interviewId)?.status).toBe("pending_confirmation");
    await server.close();
  });

  it("exercises Telegram command mutations and validation", async () => {
    const db = new InMemoryDatabase();
    const state = createTelegramCommandState();

    expect(await handleTelegramCommand({ text: "/pause", db, state })).toContain("paused");
    expect(await handleTelegramCommand({ text: "/mode", db, state })).toContain("paused");
    expect(await handleTelegramCommand({ text: "/mode dry_run_apply", db, state })).toContain("dry_run_apply");
    expect(await handleTelegramCommand({ text: "/mode unsafe", db, state })).toContain("Invalid mode");
    expect(await handleTelegramCommand({ text: "/resume_bot", db, state })).toContain("review_first");
    expect(await handleTelegramCommand({ text: "/set_profile", db, state })).toContain("Usage");
    expect(await handleTelegramCommand({ text: "/set_profile missing", db, state })).toContain("Profile not found");
    expect(await handleTelegramCommand({ text: "/set_profile backend-node-main", db, state })).toContain("backend-node-main");
    expect(await handleTelegramCommand({ text: "/blacklist_company", db, state })).toContain("Usage");
    expect(await handleTelegramCommand({ text: "/manual_review", db, state })).toContain("empty");
    expect(await handleTelegramCommand({ text: "/blacklist_company Example GmbH", db, state })).toContain("Queued for manual review");
    expect(await handleTelegramCommand({ text: "/manual_review", db, state })).toContain("blacklist_company");
    expect(await handleTelegramCommand({ text: "/manual_review", db, state })).toContain([...db.manualReviewItems.values()][0]!.id);
    expect(await handleTelegramCommand({ text: "/dlq", db, state })).toContain("not connected");
    const taskRunStore = new InMemoryTaskRunStore();
    const queue = new InMemoryQueueAdapter(taskRunStore);
    const task = await queue.enqueue("auto_apply_queue", { applicationId: "app-1" }, { idempotencyKey: "apply:telegram-dlq", deduplicationKey: "app-1" });
    taskRunStore.markRunning(task.id);
    taskRunStore.moveToDeadLetter(task.id, { code: "captcha_required", message: "captcha" });
    expect(await handleTelegramCommand({ text: "/dlq", db, state, taskRunStore })).toContain("captcha_required");
    expect(await handleTelegramCommand({ text: "/dlq", db, state, taskRunStore: new InMemoryTaskRunStore() })).toContain("empty");
    const reviewId = [...db.manualReviewItems.values()][0]!.id;
    expect(await handleTelegramCommand({ text: "/approve", db, state })).toContain("Usage");
    expect(await handleTelegramCommand({ text: "/approve missing", db, state })).toContain("not found");
    const unsupportedApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "outbound_message",
      entityId: "reply:telegram:unsupported",
      requestedAction: "send_recruiter_reply",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "reply-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${unsupportedApproval.id}`, db, state })).toContain("outbound draft not found");
    expect(db.approvalRequests.get(unsupportedApproval.id)?.status).toBe("pending");
    expect(await handleTelegramCommand({ text: `/defer ${reviewId}`, db, state })).toContain("deferred");
    expect(await handleTelegramCommand({ text: `/reject ${reviewId}`, db, state })).toContain("rejected");
    const [approvalScored] = await createScoredFixtureJobs();
    db.upsertJob(approvalScored!.job);
    const changedDraftApplication = db.createApplication({
      jobId: approvalScored!.job.id,
      providerId: "hh",
      externalJobId: `${approvalScored!.job.externalId}-changed-draft`,
      status: "application_prepared",
      idempotencyKey: "apply:telegram:changed-draft",
      dedupKey: "hh:changed-draft",
      draftVariantKey: "current-draft-hash"
    });
    const changedDraftApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: changedDraftApplication.id,
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "old-draft-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${changedDraftApproval.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "approval_draft_hash_mismatch"
    );
    expect(db.approvalRequests.get(changedDraftApproval.id)?.status).toBe("pending");
    const missingApplicationApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: "missing-telegram-application",
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "missing-draft-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${missingApplicationApproval.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "application not found"
    );
    const noDraftApplication = db.createApplication({
      jobId: approvalScored!.job.id,
      providerId: "hh",
      externalJobId: `${approvalScored!.job.externalId}-no-draft`,
      status: "application_prepared",
      idempotencyKey: "apply:telegram:no-draft",
      dedupKey: "hh:no-draft"
    });
    const noDraftApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: noDraftApplication.id,
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "missing-draft-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${noDraftApproval.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "draft hash missing"
    );
    const approvalApplication = db.createApplication({
      jobId: approvalScored!.job.id,
      providerId: "hh",
      externalJobId: approvalScored!.job.externalId,
      status: "application_prepared",
      idempotencyKey: "apply:telegram:approval",
      dedupKey: "hh:approval-telegram",
      draftVariantKey: "telegram-draft-hash"
    });
    const approvalRequest = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: approvalApplication.id,
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "telegram-draft-hash",
      manualReviewId: null
    });
    const approvalQueue = new InMemoryQueueAdapter();
    expect(
      await handleTelegramCommand({
        text: `/approve ${approvalRequest.id}`,
        db,
        state,
        queue: approvalQueue,
        irreversibleActionsEnabled: true
      })
    ).toContain("Queued submit task");
    expect(await approvalQueue.depth("auto_apply_queue")).toBe(1);
    const rejectedApprovalRequest = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: approvalApplication.id,
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "telegram-draft-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/reject ${rejectedApprovalRequest.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "Approval request rejected"
    );
    const noQueueApprovalRequest = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: approvalApplication.id,
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "telegram-draft-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${noQueueApprovalRequest.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "Approval request approved"
    );
    const disabledApprovalRequest = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: approvalApplication.id,
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "telegram-draft-hash",
      manualReviewId: null
    });
    expect(
      await handleTelegramCommand({
        text: `/approve ${disabledApprovalRequest.id}`,
        db,
        state,
        irreversibleActionsEnabled: false
      })
    ).toContain("Approval request not approved: irreversible_actions_disabled");
    const manualReviewJob = {
      ...approvalScored!.job,
      id: "job-telegram-manual-review",
      externalId: `${approvalScored!.job.externalId}-manual-review`,
      companyName: "Manual Review GmbH"
    };
    db.upsertJob(manualReviewJob);
    const manualReviewApplication = db.createApplication({
      jobId: manualReviewJob.id,
      providerId: "hh",
      externalJobId: manualReviewJob.externalId,
      status: "manual_review_required",
      idempotencyKey: "apply:telegram:manual-review",
      dedupKey: "hh:manual-review",
      draftVariantKey: "telegram-manual-review-draft-hash"
    });
    const applicationReview = db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: manualReviewApplication.id,
      reasonCode: "review_first_requires_approval",
      severity: "medium",
      recommendedAction: "Approve prepared application draft"
    });
    const manualReviewQueue = new InMemoryQueueAdapter();
    expect(
      await handleTelegramCommand({
        text: `/approve ${applicationReview.id}`,
        db,
        state,
        queue: manualReviewQueue,
        irreversibleActionsEnabled: true
      })
    ).toContain("Queued submit task");
    expect(db.applications.get(manualReviewApplication.id)?.status).toBe("apply_queued");
    expect(await manualReviewQueue.depth("auto_apply_queue")).toBe(1);
    db.candidateProfile.rateLimits.applicationsPerHour = 99;
    db.candidateProfile.rateLimits.applicationsPerDay = 99;
    db.candidateProfile.rateLimits.maxPerCompanyPerDay = 99;
    db.candidateProfile.rateLimits.maxPerCompanyPerWeek = 99;
    const failingQueueApplication = db.createApplication({
      jobId: manualReviewJob.id,
      providerId: "hh",
      externalJobId: `${manualReviewJob.externalId}-queue-failure`,
      status: "manual_review_required",
      idempotencyKey: "apply:telegram:manual-review-queue-failure",
      dedupKey: "hh:manual-review-queue-failure",
      draftVariantKey: "queue-failure-draft"
    });
    const failingQueueReview = db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: failingQueueApplication.id,
      reasonCode: "review_first_requires_approval",
      severity: "medium",
      recommendedAction: "Approve failing queue application"
    });
    const failingQueue = {
      enqueue: async () => {
        throw new Error("redis_down");
      },
      depth: async () => 0,
      oldestAgeSeconds: async () => 0
    };
    expect(
      await handleTelegramCommand({
        text: `/approve ${failingQueueReview.id}`,
        db,
        state,
        queue: failingQueue,
        irreversibleActionsEnabled: true
      })
    ).toContain("submit not queued");
    expect(db.applications.get(failingQueueApplication.id)?.status).toBe("manual_review_required");
    const missingApplicationReview = db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: "missing-manual-review-application",
      reasonCode: "review_first_requires_approval",
      severity: "medium",
      recommendedAction: "Approve missing application"
    });
    expect(await handleTelegramCommand({ text: `/approve ${missingApplicationReview.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "application not found"
    );
    const noDraftManualReviewApplication = db.createApplication({
      jobId: manualReviewJob.id,
      providerId: "hh",
      externalJobId: `${manualReviewJob.externalId}-no-draft`,
      status: "manual_review_required",
      idempotencyKey: "apply:telegram:manual-review-no-draft",
      dedupKey: "hh:manual-review-no-draft"
    });
    const noDraftManualReview = db.createManualReview({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: noDraftManualReviewApplication.id,
      reasonCode: "review_first_requires_approval",
      severity: "medium",
      recommendedAction: "Approve no-draft application"
    });
    expect(await handleTelegramCommand({ text: `/approve ${noDraftManualReview.id}`, db, state, irreversibleActionsEnabled: true })).toContain("draft hash missing");
    const queueMissingDb = new InMemoryDatabase();
    queueMissingDb.upsertJob(manualReviewJob);
    const queueMissingManualReviewApplication = queueMissingDb.createApplication({
      jobId: manualReviewJob.id,
      providerId: "hh",
      externalJobId: `${manualReviewJob.externalId}-queue-missing`,
      status: "manual_review_required",
      idempotencyKey: "apply:telegram:manual-review-queue-missing",
      dedupKey: "hh:manual-review-queue-missing",
      draftVariantKey: "queue-missing-draft"
    });
    const queueMissingManualReview = queueMissingDb.createManualReview({
      userId: queueMissingDb.candidateProfile.userId,
      entityType: "application",
      entityId: queueMissingManualReviewApplication.id,
      reasonCode: "review_first_requires_approval",
      severity: "medium",
      recommendedAction: "Approve queue-missing application"
    });
    expect(
      await handleTelegramCommand({ text: `/approve ${queueMissingManualReview.id}`, db: queueMissingDb, state: createTelegramCommandState(), irreversibleActionsEnabled: true })
    ).toContain("queue_missing");
    const replyMessage: OutboundMessage = {
      conversationId: "telegram-conversation",
      inboundMessageId: "telegram-inbound",
      category: "acknowledgment",
      language: db.candidateProfile.languages.communicationDefault,
      text: "Thank you for the update.",
      factsUsed: [],
      idempotencyKey: "reply:telegram-conversation:telegram-inbound:acknowledgment"
    };
    db.candidateProfile.userConsent.autoReply = true;
    const replyResult: OutboundDispatchResult = {
      status: "queued_for_review",
      proof: {
        proofId: "outbound-proof-telegram-review",
        outboundMessageId: `outbound_${stableHash(replyMessage.idempotencyKey)}`,
        providerId: "hh",
        accountId: "fixture-account",
        conversationId: replyMessage.conversationId,
        inboundMessageId: replyMessage.inboundMessageId,
        idempotencyKey: replyMessage.idempotencyKey,
        transport: "fixture",
        status: "queued_for_review",
        textHash: stableHash(replyMessage.text),
        validationHash: stableHash("telegram-review-validation"),
        policyDecision: "requires_user_approval",
        createdAt: "2026-05-18T00:00:00.000Z",
        deliveredAt: null
      },
      deliveryId: null,
      errors: []
    };
    db.recordOutboundDispatch({ providerId: "hh", accountId: "fixture-account", message: replyMessage, result: replyResult, actor: "test" });
    const replyApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "outbound_message",
      entityId: replyMessage.idempotencyKey,
      requestedAction: "send_recruiter_reply",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: stableHash(replyMessage.text),
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${replyApproval.id}`, db, state })).toContain("Recorded outbound dispatch: dry_run_recorded");
    expect([...db.outboundMessages.values()].find((message) => message.message.idempotencyKey === replyMessage.idempotencyKey)?.status).toBe("dry_run_recorded");
    const staleReplyApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "outbound_message",
      entityId: replyMessage.idempotencyKey,
      requestedAction: "send_recruiter_reply",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "stale-reply-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${staleReplyApproval.id}`, db, state })).toContain("approval_draft_hash_mismatch");
    const rejectedReplyApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "outbound_message",
      entityId: replyMessage.idempotencyKey,
      requestedAction: "send_recruiter_reply",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: stableHash(replyMessage.text),
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/reject ${rejectedReplyApproval.id}`, db, state })).toContain("Approval request rejected");
    db.candidateProfile.userConsent.interviewScheduling = true;
    const interview = db.recordInterviewEvent(
      new InterviewCoordinator().createPendingConfirmation({
        jobId: approvalScored!.job.id,
        companyId: "telegram-company",
        conversationId: "telegram-conversation",
        slot: { date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }
      })
    );
    const interviewSlotHash = stableHash(JSON.stringify({ date: "2026-05-20", time: "10:30", timezone: "Europe/Vienna" }));
    const interviewApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: interview.interviewId,
      requestedAction: "confirm_interview_slot",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: interviewSlotHash,
      manualReviewId: null
    });
    expect(
      await handleTelegramCommand({
        text: `/approve ${interviewApproval.id}`,
        db,
        state,
        irreversibleActionsEnabled: true
      })
    ).toContain("Interview scheduled");
    expect(db.interviewEvents.get(interview.interviewId)?.status).toBe("scheduled");
    const rejectedInterview = db.recordInterviewEvent(
      new InterviewCoordinator().createPendingConfirmation({
        jobId: approvalScored!.job.id,
        companyId: "telegram-company",
        conversationId: "telegram-conversation",
        slot: { date: "2026-05-21", time: "10:30", timezone: "Europe/Vienna" }
      })
    );
    const rejectedInterviewApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: rejectedInterview.interviewId,
      requestedAction: "confirm_interview_slot",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: stableHash(JSON.stringify({ date: "2026-05-21", time: "10:30", timezone: "Europe/Vienna" })),
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/reject ${rejectedInterviewApproval.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "Interview cancelled"
    );
    const staleInterviewApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: rejectedInterview.interviewId,
      requestedAction: "confirm_interview_slot",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "stale-interview-hash",
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${staleInterviewApproval.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "approval_draft_hash_mismatch"
    );
    const missingInterviewApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: "missing-interview",
      requestedAction: "confirm_interview_slot",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: stableHash(JSON.stringify({ date: "2026-05-23", time: "10:30", timezone: "Europe/Vienna" })),
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${missingInterviewApproval.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "interview not found"
    );
    const disabledInterview = db.recordInterviewEvent(
      new InterviewCoordinator().createPendingConfirmation({
        jobId: approvalScored!.job.id,
        companyId: "telegram-company",
        conversationId: "telegram-conversation",
        slot: { date: "2026-05-22", time: "10:30", timezone: "Europe/Vienna" }
      })
    );
    const disabledInterviewApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: disabledInterview.interviewId,
      requestedAction: "confirm_interview_slot",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: stableHash(JSON.stringify({ date: "2026-05-22", time: "10:30", timezone: "Europe/Vienna" })),
      manualReviewId: null
    });
    expect(await handleTelegramCommand({ text: `/approve ${disabledInterviewApproval.id}`, db, state, irreversibleActionsEnabled: false })).toContain(
      "Approval request not approved"
    );
    db.candidateProfile.rateLimits.applicationsPerHour = 1;
    db.candidateProfile.rateLimits.applicationsPerDay = 1;
    db.candidateProfile.rateLimits.maxPerCompanyPerDay = 1;
    db.candidateProfile.rateLimits.maxPerCompanyPerWeek = 1;
    db.createApplication({
      jobId: approvalScored!.job.id,
      providerId: "hh",
      externalJobId: `${approvalScored!.job.externalId}-limited-existing`,
      status: "applied",
      idempotencyKey: "apply:telegram:approval-existing",
      dedupKey: "hh:approval-existing"
    });
    const limitedApprovalApplication = db.createApplication({
      jobId: approvalScored!.job.id,
      providerId: "hh",
      externalJobId: `${approvalScored!.job.externalId}-limited-target`,
      status: "application_prepared",
      idempotencyKey: "apply:telegram:approval-limited",
      dedupKey: "hh:approval-limited",
      draftVariantKey: "telegram-limited-draft-hash"
    });
    const limitedApprovalRequest = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "application",
      entityId: limitedApprovalApplication.id,
      requestedAction: "send_application",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "telegram-limited-draft-hash",
      manualReviewId: null
    });
    expect(
      await handleTelegramCommand({
        text: `/approve ${limitedApprovalRequest.id}`,
        db,
        state,
        queue: approvalQueue,
        irreversibleActionsEnabled: true
      })
    ).toContain("applications_per_hour_exhausted");
    expect(await handleTelegramCommand({ text: "/digest_now", db, state })).toContain("Digest");
    expect(await handleTelegramCommand({ text: "/job", db, state })).toContain("Usage");
    expect(await handleTelegramCommand({ text: "/job missing", db, state })).toContain("Job not found");
    expect(await handleTelegramCommand({ text: "/jobs_applied", db, state })).toContain("application_prepared");
    expect(await handleTelegramCommand({ text: "/sources", db, state })).toContain("no health checks");
    db.updateProviderHealth({
      providerId: "empty-capabilities",
      status: "read_only",
      checkedAt: "2026-05-18T12:00:00.000Z",
      latencyMs: 1,
      message: "configured without active capabilities"
    });
    expect(
      await handleTelegramCommand({
        text: "/sources",
        db,
        state,
        sourceCatalog: [
          {
            providerId: "empty-capabilities",
            enabled: false,
            mode: "paused",
            capabilities: {
              jobDiscovery: false,
              jobDetailFetch: false,
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
              deterministicFlowSupported: false
            }
          }
        ]
      })
    ).toContain("capabilities=none");
    db.auditEvents.push(createAuditEvent({ entityType: "job", entityId: "job-1", eventType: "test_event", actor: "test" }));
    expect(await handleTelegramCommand({ text: "/logs job-1", db, state })).toContain("test_event");
    expect(await handleTelegramCommand({ text: "/logs missing", db, state })).toContain("no audit events");
    expect(await handleTelegramCommand({ text: "/retry_provider hh", db, state })).toContain("Queued for manual review");
    expect(await handleTelegramCommand({ text: "/unknown", db, state })).toContain("Supported commands");
    const emptyDb = new InMemoryDatabase();
    const emptyState = createTelegramCommandState();
    expect(await handleTelegramCommand({ text: "/jobs_applied_today", db: emptyDb, state: emptyState })).toContain("none in today");
    expect(await handleTelegramCommand({ text: "/responses", db: emptyDb, state: emptyState })).toContain("no live inbox");
    expect(await handleTelegramCommand({ text: "/interviews", db: emptyDb, state: emptyState })).toContain("no scheduled interviews");
  });

  it("surfaces Telegram approval resolution races without executing stale actions", async () => {
    const db = new InMemoryDatabase();
    const state = createTelegramCommandState();
    db.candidateProfile.userConsent.autoReply = true;
    const replyMessage: OutboundMessage = {
      conversationId: "race-conversation",
      inboundMessageId: "race-inbound",
      category: "acknowledgment",
      language: db.candidateProfile.languages.communicationDefault,
      text: "Thank you for the update.",
      factsUsed: [],
      idempotencyKey: "reply:race-conversation:race-inbound:acknowledgment"
    };
    const replyResult: OutboundDispatchResult = {
      status: "queued_for_review",
      proof: {
        proofId: "outbound-proof-race-review",
        outboundMessageId: `outbound_${stableHash(replyMessage.idempotencyKey)}`,
        providerId: "hh",
        accountId: "fixture-account",
        conversationId: replyMessage.conversationId,
        inboundMessageId: replyMessage.inboundMessageId,
        idempotencyKey: replyMessage.idempotencyKey,
        transport: "fixture",
        status: "queued_for_review",
        textHash: stableHash(replyMessage.text),
        validationHash: stableHash("race-validation"),
        policyDecision: "requires_user_approval",
        createdAt: "2026-05-18T00:00:00.000Z",
        deliveredAt: null
      },
      deliveryId: null,
      errors: []
    };
    db.recordOutboundDispatch({ providerId: "hh", accountId: "fixture-account", message: replyMessage, result: replyResult, actor: "test" });
    const replyApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "outbound_message",
      entityId: replyMessage.idempotencyKey,
      requestedAction: "send_recruiter_reply",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: stableHash(replyMessage.text),
      manualReviewId: null
    });
    const replyResolve = vi.spyOn(db, "resolveApprovalRequest").mockReturnValueOnce(null);
    expect(await handleTelegramCommand({ text: `/approve ${replyApproval.id}`, db, state })).toContain("not found or draft hash mismatch");
    replyResolve.mockRestore();

    const [scored] = await createScoredFixtureJobs();
    expect(scored).toBeDefined();
    db.upsertJob(scored!.job);
    db.candidateProfile.userConsent.interviewScheduling = true;
    const rejectedInterview = db.recordInterviewEvent(
      new InterviewCoordinator().createPendingConfirmation({
        jobId: scored!.job.id,
        companyId: "race-company",
        conversationId: "race-conversation",
        slot: { date: "2026-05-25", time: "10:30", timezone: "Europe/Vienna" }
      })
    );
    const rejectedHash = stableHash(JSON.stringify({ date: "2026-05-25", time: "10:30", timezone: "Europe/Vienna" }));
    const rejectedApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: rejectedInterview.interviewId,
      requestedAction: "confirm_interview_slot",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: rejectedHash,
      manualReviewId: null
    });
    const rejectResolve = vi.spyOn(db, "resolveApprovalRequest").mockReturnValueOnce(null);
    expect(await handleTelegramCommand({ text: `/reject ${rejectedApproval.id}`, db, state })).toContain("not found or draft hash mismatch");
    rejectResolve.mockRestore();

    const approvedInterview = db.recordInterviewEvent(
      new InterviewCoordinator().createPendingConfirmation({
        jobId: scored!.job.id,
        companyId: "race-company",
        conversationId: "race-conversation",
        slot: { date: "2026-05-26", time: "10:30", timezone: "Europe/Vienna" }
      })
    );
    const approvedHash = stableHash(JSON.stringify({ date: "2026-05-26", time: "10:30", timezone: "Europe/Vienna" }));
    const approvedApproval = db.createApprovalRequest({
      userId: db.candidateProfile.userId,
      entityType: "interview",
      entityId: approvedInterview.interviewId,
      requestedAction: "confirm_interview_slot",
      expiresAt: "2026-05-19T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: approvedHash,
      manualReviewId: null
    });
    const approveResolve = vi.spyOn(db, "resolveApprovalRequest").mockReturnValueOnce(null);
    expect(await handleTelegramCommand({ text: `/approve ${approvedApproval.id}`, db, state, irreversibleActionsEnabled: true })).toContain(
      "not found or draft hash mismatch"
    );
    approveResolve.mockRestore();
    expect(db.interviewEvents.get(approvedInterview.interviewId)?.status).toBe("pending_confirmation");
  });

  it("renders Telegram command matrices for seeded jobs, sources, responses and interviews", async () => {
    const db = new InMemoryDatabase();
    const state = createTelegramCommandState();
    const [scored] = await createScoredFixtureJobs();
    expect(scored).toBeDefined();
    db.upsertJob(scored!.job);
    db.saveScore(scored!.job.id, scored!.score);
    db.createApplication({
      jobId: scored!.job.id,
      providerId: scored!.job.sourceProvider,
      externalJobId: scored!.job.externalId,
      status: "applied",
      idempotencyKey: "apply:user-001:hh:hh-1001",
      dedupKey: "hh:hh-1001"
    });
    const oldApplication = db.createApplication({
      jobId: scored!.job.id,
      providerId: scored!.job.sourceProvider,
      externalJobId: "hh-old",
      status: "applied",
      idempotencyKey: "apply:user-001:hh:old",
      dedupKey: "hh:old"
    });
    oldApplication.createdAt = "2026-01-01T00:00:00.000Z";
    db.updateProviderHealth({ providerId: "hh", status: "stable", checkedAt: new Date().toISOString(), latencyMs: 1, message: "ok" });
    db.updateProviderHealth({
      providerId: "robota",
      status: "needs_review",
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      message: "review"
    });
    db.recordSearchRun({
      providerId: "robota",
      searchProfileId: db.searchProfile.searchProfileId,
      query: "node",
      filters: { remote: true },
      rawCount: 2,
      normalizedCount: 1,
      rejectedCount: 1,
      shortlistedCount: 0,
      stopCondition: "completed_with_errors",
      errors: ["selector warning"]
    });
    db.recordCanaryRun({ providerId: "robota", status: "failed", checks: ["fixture"], failures: ["selector warning"] });
    const inbound = db.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "msg-2",
      conversationExternalId: "conv-2",
      receivedAt: new Date().toISOString(),
      senderName: "Recruiter",
      text: "Can we meet on 2026-05-20 14:00?",
      linkedJobExternalId: scored!.job.externalId
    });
    db.saveMessageClassification({
      inboundMessageId: inbound.record.id,
      classification: {
        category: "scheduling_request",
        confidence: 0.91,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [{ date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" }],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["seeded"]
      },
      llmOk: true
    });
    const interview = db.recordInterviewEvent(
      new InterviewCoordinator().createEvent({
        jobId: scored!.job.id,
        companyId: "company-1",
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" }
      })
    );

    expect(await handleTelegramCommand({ text: "/start", db, state })).toContain("Telegram Job Search Automation Core");
    const pipeline = await handleTelegramCommand({ text: "/pipeline", db, state });
    expect(pipeline).toContain("Applied: 2");
    expect(pipeline).toContain("Interviews: 1");
    expect(await handleTelegramCommand({ text: "/profiles", db, state })).toContain(db.candidateProfile.displayName);
    const sources = await handleTelegramCommand({ text: "/sources", db, state });
    expect(sources).toContain("robota: needs_review");
    expect(sources).toContain("lastRun=completed_with_errors raw=2 normalized=1");
    expect(sources).toContain("failureRate=100%");
    const sourceRegistry = createFixtureProviderRegistry();
    const sourcesWithCatalog = await handleTelegramCommand({
      text: "/sources",
      db,
      state,
      sourceCatalog: sourceRegistry.list().map((provider) => ({
        providerId: provider.providerId,
        mode: state.mode,
        enabled: true,
        capabilities: provider.capabilities
      }))
    });
    expect(sourcesWithCatalog).toContain("mode=review_first");
    expect(sourcesWithCatalog).toContain("capabilities=jobDiscovery");
    expect(await handleTelegramCommand({ text: `/job ${scored!.job.id}`, db, state })).toContain(scored!.job.title);
    expect(await handleTelegramCommand({ text: "/jobs_applied", db, state })).toContain("applied: hh/hh-old");
    expect(await handleTelegramCommand({ text: "/jobs_applied_today", db, state })).not.toContain("hh-old");
    expect(await handleTelegramCommand({ text: "/jobs_applied_week", db, state })).toContain("applied: hh/hh-1001");
    const responses = await handleTelegramCommand({ text: "/responses", db, state });
    expect(responses).toContain("urgent");
    expect(responses).toContain("scheduling_request");
    expect(responses).toContain("action=reply");
    expect(await handleTelegramCommand({ text: "/availability", db, state })).toContain("Availability");
    expect(await handleTelegramCommand({ text: "/interviews", db, state })).toContain("scheduled");
    expect(await handleTelegramCommand({ text: `/interviews ${interview.interviewId}`, db, state })).toContain(scored!.job.title);
    expect(await handleTelegramCommand({ text: "/interviews missing", db, state })).toContain("Interview not found");
    expect(await handleTelegramCommand({ text: "/whitelist_company Example GmbH", db, state })).toContain("Queued for manual review");
    const digest = await handleTelegramCommand({ text: "/digest_now", db, state });
    expect(digest).toContain("New responses: 1");
    expect(digest).toContain("Interviews: 1");
    expect(digest).toContain("robota");
  });

  it("runs testable worker functions and exposes failures", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const registry = createFixtureProviderRegistry();

    expect(await runIngestWorker({ config, db, registry })).toEqual({ processed: 4 });
    expect(db.searchRuns).toHaveLength(3);
    expect(db.searchRuns.find((run) => run.providerId === "hh")).toMatchObject({
      query: expect.any(String),
      filters: expect.any(Object),
      stopCondition: "completed"
    });
    const overrideRegistry = createFixtureProviderRegistryWithOverrides([{ providerId: "robota", enabled: false }]);
    const overrideDb = new InMemoryDatabase();
    expect(await runIngestWorker({ config, db: overrideDb, registry: overrideRegistry })).toEqual({ processed: 3 });
    expect(overrideDb.searchRuns.map((run) => run.providerId)).not.toContain("robota");
    const failingRegistry = createFixtureProviderRegistry();
    failingRegistry.get("hh").fetchJob = async () => {
      throw new Error("fixture fetch failed");
    };
    const failingIngestDb = new InMemoryDatabase();
    expect(await runIngestWorker({ config, db: failingIngestDb, registry: failingRegistry })).toEqual({ processed: 2 });
    expect(failingIngestDb.searchRuns.find((run) => run.providerId === "hh")).toMatchObject({
      rawCount: 2,
      normalizedCount: 0,
      stopCondition: "completed_with_errors",
      errors: expect.arrayContaining([expect.stringContaining("fixture fetch failed")])
    });
    const queuedDb = new InMemoryDatabase();
    const taskRunStore = new InMemoryTaskRunStore();
    const queued = await runIngestWorker({ config, db: queuedDb, registry, queue: new InMemoryQueueAdapter(taskRunStore), taskRunStore });
    expect(queued).toMatchObject({ processed: 4, queueRuntime: { status: "succeeded", errorCode: null } });
    expect(taskRunStore.getTaskRun(`source_poll_queue:source_poll:${queuedDb.searchProfile.searchProfileId}`)?.status).toBe("succeeded");
    expect(runApplyWorker()).toMatchObject({ status: "succeeded", reachedSubmitBoundary: true });
    const applyDb = new InMemoryDatabase();
    expect(runApplyWorker({ db: applyDb, guardResults: { no_captcha: false } })).toMatchObject({
      status: "manual_review_required",
      errorCode: "captcha_required"
    });
    expect(applyDb.providerHealth.get("hh")?.status).toBe("needs_review");
    const submitDb = new InMemoryDatabase();
    submitDb.candidateProfile.userConsent.autoApply = true;
    submitDb.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "approved submit worker" });
    await runLocalPipeline({
      config: loadConfig({ APP_MODE: "controlled_auto_apply", IRREVERSIBLE_ACTIONS_ENABLED: "true", API_TOKEN: "test-token" }),
      db: submitDb,
      registry
    });
    submitDb.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });
    const preparedApplication = [...submitDb.applications.values()].find((application) => application.providerId === "hh")!;
    const submitTaskRunStore = new InMemoryTaskRunStore();
    const submitResult = await runApprovedSubmitWorker({
      config: loadConfig({ APP_MODE: "controlled_auto_apply", IRREVERSIBLE_ACTIONS_ENABLED: "true", API_TOKEN: "test-token" }),
      db: submitDb,
      registry,
      applicationId: preparedApplication.id,
      ...approveApplication(submitDb, preparedApplication),
      queue: new InMemoryQueueAdapter(submitTaskRunStore),
      taskRunStore: submitTaskRunStore
    });
    expect(submitResult.guard.passed).toBe(true);
    expect(submitResult.queueRuntime).toMatchObject({ status: "succeeded", errorCode: null });
    expect(submitDb.applications.get(preparedApplication.id)?.status).toBe("apply_blocked_by_provider");

    const inboxDb = new InMemoryDatabase();
    expect(await runInboxWorker({ config, db: inboxDb, registry })).toMatchObject({ classified: 2 });
    expect(await runInboxWorker({ config, db: inboxDb, registry })).toMatchObject({ classified: 0, manualReviewCreated: 0 });
    expect(inboxDb.inboundMessages.size).toBe(2);
    const blockedInboxRegistry = createFixtureProviderRegistry();
    blockedInboxRegistry.get("hh").healthcheck = async () => ({
      providerId: "hh",
      status: "blocked",
      checkedAt: "2026-05-18T00:00:00.000Z",
      latencyMs: 1,
      message: "blocked by provider policy"
    });
    const blockedInboxDb = new InMemoryDatabase();
    expect(await runInboxWorker({ config, db: blockedInboxDb, registry: blockedInboxRegistry })).toMatchObject({ classified: 1, manualReviewCreated: 0 });
    expect([...blockedInboxDb.inboundMessages.values()].map((message) => message.providerId)).not.toContain("hh");
    expect(blockedInboxDb.providerHealth.get("hh")?.status).toBe("blocked");
    const partiallyPersistedInboxDb = new InMemoryDatabase();
    const [persistedWithoutClassification] = await registry.get("hh").syncInbox("fixture-account");
    expect(persistedWithoutClassification).toBeDefined();
    partiallyPersistedInboxDb.upsertInboundMessage(persistedWithoutClassification!);
    expect(await runInboxWorker({ config, db: partiallyPersistedInboxDb, registry })).toMatchObject({ classified: 2 });
    expect(await runInboxWorker({ config, db: partiallyPersistedInboxDb, registry })).toMatchObject({ classified: 0, manualReviewCreated: 0 });
    const queuedInboxDb = new InMemoryDatabase();
    const inboxTaskRunStore = new InMemoryTaskRunStore();
    expect(await runInboxWorker({ config, db: queuedInboxDb, registry, queue: new InMemoryQueueAdapter(inboxTaskRunStore), taskRunStore: inboxTaskRunStore })).toMatchObject({
      classified: 2,
      manualReviewCreated: 0,
      queueRuntime: { status: "succeeded", errorCode: null }
    });
    expect(inboxTaskRunStore.getTaskRun("inbox_sync_queue:inbox_sync:fixture-account")?.status).toBe("succeeded");
    inboxDb.candidateProfile.userConsent.autoReply = true;
    const replyResult = await runReplyWorker({ config, db: inboxDb });
    expect(replyResult.drafted).toBeGreaterThan(0);
    expect(inboxDb.outboundMessages.size).toBe(replyResult.dispatched);
    const queuedReplyDb = new InMemoryDatabase();
    await runInboxWorker({ config, db: queuedReplyDb, registry });
    queuedReplyDb.candidateProfile.userConsent.autoReply = true;
    const replyTaskRunStore = new InMemoryTaskRunStore();
    const queuedReplyResult = await runReplyWorker({ config, db: queuedReplyDb, queue: new InMemoryQueueAdapter(replyTaskRunStore), taskRunStore: replyTaskRunStore });
    expect(queuedReplyResult).toMatchObject({ drafted: expect.any(Number), queueRuntime: { status: "succeeded", errorCode: null } });
    expect(queuedReplyResult.drafted).toBeGreaterThan(0);
    expect(replyTaskRunStore.getTaskRun("reply_generation_queue:reply_generation:all-ready-classifications")?.status).toBe("succeeded");

    const skipReplyDb = new InMemoryDatabase();
    skipReplyDb.saveMessageClassification({
      inboundMessageId: "missing-inbound",
      classification: {
        category: "request_for_details",
        confidence: 0.9,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["seeded missing inbound branch"]
      },
      llmOk: true
    });
    const nonReplyInbound = skipReplyDb.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "skip-msg",
      conversationExternalId: "skip-conv",
      receivedAt: new Date().toISOString(),
      senderName: "Recruiter",
      text: "Thanks",
      linkedJobExternalId: null
    });
    skipReplyDb.saveMessageClassification({
      inboundMessageId: nonReplyInbound.record.id,
      classification: {
        category: "acknowledgment",
        confidence: 0.9,
        requiresReply: false,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["seeded no reply branch"]
      },
      llmOk: true
    });
    expect(await runReplyWorker({ config, db: skipReplyDb })).toEqual({ drafted: 0, dispatched: 0, manualReviewCreated: 0 });

    const invalidReplyDb = new InMemoryDatabase();
    const invalidInbound = invalidReplyDb.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "invalid-msg",
      conversationExternalId: "invalid-conv",
      receivedAt: new Date().toISOString(),
      senderName: "Recruiter",
      text: "Please answer automatically",
      linkedJobExternalId: null
    });
    invalidReplyDb.saveMessageClassification({
      inboundMessageId: invalidInbound.record.id,
      classification: {
        category: "auto_reply",
        confidence: 0.9,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["seeded unsupported reply category branch"]
      },
      llmOk: true
    });
    expect(await runReplyWorker({ config, db: invalidReplyDb })).toMatchObject({ drafted: 0, dispatched: 0, manualReviewCreated: 1 });
    expect([...invalidReplyDb.manualReviewItems.values()].map((item) => item.reasonCode)).toContain("reply_draft_validation_failed");
    const conflictReplyDb = new InMemoryDatabase();
    const conflictInbound = conflictReplyDb.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "conflict-msg",
      conversationExternalId: "conflict-conv",
      receivedAt: new Date().toISOString(),
      senderName: "Recruiter",
      text: "I am not available then. Can we schedule a call?",
      linkedJobExternalId: null
    });
    conflictReplyDb.saveMessageClassification({
      inboundMessageId: conflictInbound.record.id,
      classification: {
        category: "scheduling_request",
        confidence: 0.9,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["seeded contradiction branch"]
      },
      llmOk: true
    });
    expect(await runReplyWorker({ config, db: conflictReplyDb })).toMatchObject({ drafted: 0, dispatched: 0, manualReviewCreated: 1 });
    expect([...conflictReplyDb.manualReviewItems.values()].map((item) => item.reasonCode)).toContain("reply_thread_context_conflict");

    const autoReplyConfig = loadConfig({
      APP_MODE: "controlled_auto_apply",
      IRREVERSIBLE_ACTIONS_ENABLED: "true",
      API_TOKEN: "test-token"
    });
    const autoReplyDb = new InMemoryDatabase();
    autoReplyDb.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "auto reply approval branch" });
    autoReplyDb.candidateProfile.userConsent.autoReply = true;
    const autoReplyInbound = autoReplyDb.upsertInboundMessage({
      providerId: "hh",
      accountId: "fixture-account",
      externalMessageId: "auto-reply-msg",
      conversationExternalId: "auto-reply-conv",
      receivedAt: new Date().toISOString(),
      senderName: "Recruiter",
      text: "Thanks",
      linkedJobExternalId: null
    });
    autoReplyDb.saveMessageClassification({
      inboundMessageId: autoReplyInbound.record.id,
      classification: {
        category: "acknowledgment",
        confidence: 0.9,
        requiresReply: true,
        deadline: null,
        containsInterviewLink: false,
        proposedSlots: [],
        sensitiveDataRequested: false,
        allowedAutoReply: true,
        reasons: ["seeded approved reply branch"]
      },
      llmOk: true
    });
    expect(await runReplyWorker({ config: autoReplyConfig, db: autoReplyDb })).toMatchObject({ drafted: 1, dispatched: 1 });
    expect([...autoReplyDb.outboundMessages.values()][0]?.status).toBe("dry_run_recorded");
    expect(runDigestWorker(db)).toContain("Pipeline");
    const digestTaskRunStore = new InMemoryTaskRunStore();
    expect(
      await runQueuedDigestWorker({
        db,
        queue: new InMemoryQueueAdapter(digestTaskRunStore),
        taskRunStore: digestTaskRunStore
      })
    ).toMatchObject({ digest: expect.stringContaining("Pipeline"), queueRuntime: { status: "succeeded", errorCode: null } });
    const canaryDb = new InMemoryDatabase();
    expect((await runCanaryWorker({ registry, db: canaryDb })).every((result) => result.status === "passed")).toBe(true);
    expect(canaryDb.canaryRuns.size).toBe(3);
    const queuedCanaryStore = new InMemoryTaskRunStore();
    const queuedCanaries = await runCanaryWorker({
      registry,
      db: new InMemoryDatabase(),
      queue: new InMemoryQueueAdapter(queuedCanaryStore),
      taskRunStore: queuedCanaryStore
    });
    expect(queuedCanaries.queueRuntime).toMatchObject({ status: "succeeded", errorCode: null });

    const customCanary = await runCanaryWorker({
      registry: { list: () => [{ providerId: "custom-provider" }] } as never,
      db: canaryDb
    });
    expect(customCanary[0]).toMatchObject({ status: "failed" });
  });

  it("covers approved submit guard, queue failure, and provider result branches", async () => {
    const config = loadConfig({ APP_MODE: "controlled_auto_apply", IRREVERSIBLE_ACTIONS_ENABLED: "true", API_TOKEN: "test-token" });
    const registry = createFixtureProviderRegistry();

    const missingAppStore = new InMemoryTaskRunStore();
    const missingApp = await runApprovedSubmitWorker({
      config,
      db: new InMemoryDatabase(),
      registry,
      applicationId: "missing-application",
      queue: new InMemoryQueueAdapter(missingAppStore),
      taskRunStore: missingAppStore
    });
    expect(missingApp).toMatchObject({ status: "failed", queueRuntime: { status: "dead_lettered", errorCode: "application_missing" } });

    const fixture = (await createScoredFixtureJobs())[0]!;
    const missingJobDb = new InMemoryDatabase();
    const missingJobApp = missingJobDb.createApplication({
      jobId: "missing-job",
      providerId: "hh",
      externalJobId: "missing-job",
      status: "application_prepared",
      idempotencyKey: "submit:missing-job",
      dedupKey: "missing-job"
    });
    const missingJobStore = new InMemoryTaskRunStore();
    expect(
      await runApprovedSubmitWorker({
        config,
        db: missingJobDb,
        registry,
        applicationId: missingJobApp.id,
        queue: new InMemoryQueueAdapter(missingJobStore),
        taskRunStore: missingJobStore
      })
    ).toMatchObject({ status: "failed", queueRuntime: { status: "dead_lettered", errorCode: "job_missing" } });
    expect(missingJobDb.applications.get(missingJobApp.id)?.status).toBe("apply_failed");

    const missingProviderDb = new InMemoryDatabase();
    missingProviderDb.upsertJob(fixture.job);
    const missingProviderApp = missingProviderDb.createApplication({
      jobId: fixture.job.id,
      providerId: "missing-provider",
      externalJobId: fixture.job.externalId,
      status: "application_prepared",
      idempotencyKey: "submit:missing-provider",
      dedupKey: fixture.dedupKey.providerJobKey
    });
    const missingProviderStore = new InMemoryTaskRunStore();
    expect(
      await runApprovedSubmitWorker({
        config,
        db: missingProviderDb,
        registry,
        applicationId: missingProviderApp.id,
        queue: new InMemoryQueueAdapter(missingProviderStore),
        taskRunStore: missingProviderStore
      })
    ).toMatchObject({ status: "failed", queueRuntime: { status: "dead_lettered", errorCode: "provider_missing" } });

    const createSubmitValidationApp = (db: InMemoryDatabase, suffix: string, draftVariantKey?: string) => {
      db.upsertJob(fixture.job);
      return db.createApplication({
        jobId: fixture.job.id,
        providerId: "hh",
        externalJobId: fixture.job.externalId,
        status: "application_prepared",
        idempotencyKey: `submit:validation:${suffix}`,
        dedupKey: `${fixture.dedupKey.providerJobKey}:${suffix}`,
        ...(draftVariantKey ? { draftVariantKey } : {})
      });
    };
    const missingDraftDb = new InMemoryDatabase();
    const missingDraftApp = createSubmitValidationApp(missingDraftDb, "missing-draft");
    expect(await runApprovedSubmitWorker({ config, db: missingDraftDb, registry, applicationId: missingDraftApp.id })).toMatchObject({
      status: "blocked",
      policy: { reasons: ["application_draft_hash_missing"] }
    });
    const missingPayloadDb = new InMemoryDatabase();
    const missingPayloadApp = createSubmitValidationApp(missingPayloadDb, "missing-payload", "draft-missing-payload");
    expect(await runApprovedSubmitWorker({ config, db: missingPayloadDb, registry, applicationId: missingPayloadApp.id })).toMatchObject({
      status: "blocked",
      policy: { reasons: ["approval_payload_missing"] }
    });
    const mismatchedPayloadDb = new InMemoryDatabase();
    const mismatchedPayloadApp = createSubmitValidationApp(mismatchedPayloadDb, "mismatched-payload", "draft-current");
    const mismatchedApproval = approveApplication(mismatchedPayloadDb, mismatchedPayloadApp);
    expect(
      await runApprovedSubmitWorker({
        config,
        db: mismatchedPayloadDb,
        registry,
        applicationId: mismatchedPayloadApp.id,
        approvalRequestId: mismatchedApproval.approvalRequestId,
        approvedDraftHash: "draft-stale"
      })
    ).toMatchObject({ status: "blocked", policy: { reasons: ["approval_payload_draft_hash_mismatch"] } });
    const missingApprovalDb = new InMemoryDatabase();
    const missingApprovalApp = createSubmitValidationApp(missingApprovalDb, "missing-approval", "draft-missing-approval");
    expect(
      await runApprovedSubmitWorker({
        config,
        db: missingApprovalDb,
        registry,
        applicationId: missingApprovalApp.id,
        approvalRequestId: "missing-approval-request",
        approvedDraftHash: "draft-missing-approval"
      })
    ).toMatchObject({ status: "blocked", policy: { reasons: ["approval_request_missing"] } });
    const entityMismatchDb = new InMemoryDatabase();
    const entityMismatchApp = createSubmitValidationApp(entityMismatchDb, "entity-mismatch", "draft-entity-mismatch");
    const otherEntityApp = createSubmitValidationApp(entityMismatchDb, "other-entity", "draft-entity-mismatch");
    const entityMismatchApproval = approveApplication(entityMismatchDb, otherEntityApp);
    expect(
      await runApprovedSubmitWorker({
        config,
        db: entityMismatchDb,
        registry,
        applicationId: entityMismatchApp.id,
        approvalRequestId: entityMismatchApproval.approvalRequestId,
        approvedDraftHash: "draft-entity-mismatch"
      })
    ).toMatchObject({ status: "blocked", policy: { reasons: ["approval_request_entity_mismatch"] } });
    const pendingApprovalDb = new InMemoryDatabase();
    const pendingApprovalApp = createSubmitValidationApp(pendingApprovalDb, "pending-approval", "draft-pending-approval");
    const pendingApproval = pendingApprovalDb.createApprovalRequest({
      userId: pendingApprovalDb.candidateProfile.userId,
      entityType: "application",
      entityId: pendingApprovalApp.id,
      requestedAction: "send_application",
      expiresAt: "2099-01-01T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "draft-pending-approval",
      manualReviewId: null
    });
    expect(
      await runApprovedSubmitWorker({
        config,
        db: pendingApprovalDb,
        registry,
        applicationId: pendingApprovalApp.id,
        approvalRequestId: pendingApproval.id,
        approvedDraftHash: "draft-pending-approval"
      })
    ).toMatchObject({ status: "blocked", policy: { reasons: ["approval_status_pending"] } });
    const expiredApprovalDb = new InMemoryDatabase();
    const expiredApprovalApp = createSubmitValidationApp(expiredApprovalDb, "expired-approval", "draft-expired-approval");
    const expiredApproval = approveApplication(expiredApprovalDb, expiredApprovalApp);
    expiredApprovalDb.approvalRequests.get(expiredApproval.approvalRequestId)!.expiresAt = "2000-01-01T00:00:00.000Z";
    expect(
      await runApprovedSubmitWorker({
        config,
        db: expiredApprovalDb,
        registry,
        applicationId: expiredApprovalApp.id,
        ...expiredApproval
      })
    ).toMatchObject({ status: "blocked", policy: { reasons: ["approval_expired"] } });
    const requestHashMismatchDb = new InMemoryDatabase();
    const requestHashMismatchApp = createSubmitValidationApp(requestHashMismatchDb, "request-hash-mismatch", "draft-current-request");
    const staleHashApproval = requestHashMismatchDb.createApprovalRequest({
      userId: requestHashMismatchDb.candidateProfile.userId,
      entityType: "application",
      entityId: requestHashMismatchApp.id,
      requestedAction: "send_application",
      expiresAt: "2099-01-01T00:00:00.000Z",
      policyDecisionId: null,
      draftHash: "draft-stored-request",
      manualReviewId: null
    });
    requestHashMismatchDb.resolveApprovalRequest({
      id: staleHashApproval.id,
      resolution: "approved",
      actor: "test",
      draftHash: "draft-stored-request",
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(
      await runApprovedSubmitWorker({
        config,
        db: requestHashMismatchDb,
        registry,
        applicationId: requestHashMismatchApp.id,
        approvalRequestId: staleHashApproval.id,
        approvedDraftHash: "draft-current-request"
      })
    ).toMatchObject({ status: "blocked", policy: { reasons: ["approval_request_draft_hash_mismatch"] } });

    const blockedDb = new InMemoryDatabase();
    blockedDb.upsertJob(fixture.job);
    const blockedApp = blockedDb.createApplication({
      jobId: fixture.job.id,
      providerId: "hh",
      externalJobId: fixture.job.externalId,
      status: "application_prepared",
      idempotencyKey: "submit:missing-score",
      dedupKey: fixture.dedupKey.providerJobKey
    });
    const blocked = await runApprovedSubmitWorker({ config, db: blockedDb, registry, applicationId: blockedApp.id, ...approveApplication(blockedDb, blockedApp) });
    expect(blocked).toMatchObject({ status: "blocked", policy: { decision: "deny" }, providerResultStatus: null });
    expect(blockedDb.applications.get(blockedApp.id)?.status).toBe("apply_blocked_by_policy");
    expect([...blockedDb.manualReviewItems.values()].map((item) => item.reasonCode)).toContain("submit_guard_failed");

    const submittedRegistry = createFixtureProviderRegistry();
    const submittedProvider = submittedRegistry.get("hh");
    const originalSubmitted = submittedProvider.submitApplication.bind(submittedProvider);
    submittedProvider.submitApplication = async (draft) => ({
      ...(await originalSubmitted(draft)),
      status: "submitted" as const,
      providerConfirmationId: "provider-confirmation-1",
      errors: []
    });
    const submittedDb = new InMemoryDatabase();
    submittedDb.candidateProfile.userConsent.autoApply = true;
    submittedDb.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "submitted branch" });
    await runLocalPipeline({ config, db: submittedDb, registry: submittedRegistry });
    submittedDb.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });
    const submittedApp = [...submittedDb.applications.values()].find((application) => application.providerId === "hh")!;
    expect(
      await runApprovedSubmitWorker({
        config,
        db: submittedDb,
        registry: submittedRegistry,
        applicationId: submittedApp.id,
        ...approveApplication(submittedDb, submittedApp),
        releaseEvidenceSource: "production provider submit workflow run 1"
      })
    ).toMatchObject({
      status: "submitted",
      providerResultStatus: "submitted"
    });
    expect(submittedDb.applications.get(submittedApp.id)?.status).toBe("applied");
    const providerSubmitEvidence = [...submittedDb.releaseEvidence.values()].find((record) => record.evidenceType === "provider_submit_proof_ready");
    expect(providerSubmitEvidence).toMatchObject({
      evidenceId: "provider-submit-proof-hh",
      providerId: "hh",
      status: "passed",
      source: "production provider submit workflow run 1",
      metadata: {
        applicationId: submittedApp.id,
        action: "send_application",
        transport: "provider",
        idempotencyKeyHash: stableHash(submittedApp.idempotencyKey),
        draftHash: submittedApp.draftVariantKey,
        submitStatus: "submitted"
      }
    });
    expect(JSON.stringify(providerSubmitEvidence)).not.toContain("Approved application draft");
    expect(JSON.stringify(providerSubmitEvidence)).not.toContain(submittedApp.idempotencyKey);

    const changedDraftDb = new InMemoryDatabase();
    changedDraftDb.candidateProfile.userConsent.autoApply = true;
    changedDraftDb.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "changed draft branch" });
    await runLocalPipeline({ config, db: changedDraftDb, registry });
    const changedDraftApp = [...changedDraftDb.applications.values()].find((application) => application.providerId === "hh")!;
    changedDraftDb.candidateProfile.primaryStack = ["Cobol", "Fortran"];
    changedDraftDb.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });
    const changedDraftResult = await runApprovedSubmitWorker({
      config,
      db: changedDraftDb,
      registry,
      applicationId: changedDraftApp.id,
      ...approveApplication(changedDraftDb, changedDraftApp)
    });
    expect(changedDraftResult).toMatchObject({
      status: "blocked",
      guard: { checks: expect.arrayContaining([expect.objectContaining({ name: "approved_draft_payload", reason: "approved_draft_content_hash_mismatch" })]) }
    });
    expect([...changedDraftDb.manualReviewItems.values()].map((item) => item.reasonCode)).toContain("approved_draft_payload_invalid");

    const failedRegistry = createFixtureProviderRegistry();
    const failedProvider = failedRegistry.get("hh");
    const originalFailed = failedProvider.submitApplication.bind(failedProvider);
    failedProvider.submitApplication = async (draft) => ({
      ...(await originalFailed(draft)),
      status: "failed" as const,
      errors: []
    });
    const failedDb = new InMemoryDatabase();
    failedDb.candidateProfile.userConsent.autoApply = true;
    failedDb.setMode({ nextMode: "controlled_auto_apply", actor: "test", reason: "failed branch" });
    await runLocalPipeline({ config, db: failedDb, registry: failedRegistry });
    failedDb.recordCanaryRun({ providerId: "hh", status: "passed", checks: ["fixture"], failures: [] });
    const failedApp = [...failedDb.applications.values()].find((application) => application.providerId === "hh")!;
    expect(await runApprovedSubmitWorker({ config, db: failedDb, registry: failedRegistry, applicationId: failedApp.id, ...approveApplication(failedDb, failedApp) })).toMatchObject({
      status: "failed",
      providerResultStatus: "failed"
    });
    expect(failedDb.applications.get(failedApp.id)?.status).toBe("apply_failed");
  });

  it("runs an accelerated fixture soak without duplicate applications", async () => {
    const report = await runAcceleratedSoak({
      iterations: 2,
      config: loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" }),
      db: new InMemoryDatabase(),
      registry: createFixtureProviderRegistry()
    });

    expect(report.acceptance).toMatchObject({ passed: true, failures: [] });
    expect(report.iterationResults).toHaveLength(2);
    expect(report.duplicateApplicationCount).toBe(0);
    expect(report.proofCoveragePercent).toBe(100);
  });

  it("builds a local-safe acceptance package while preserving live evidence blockers", async () => {
    const acceptancePackage = await buildAcceptancePackage({
      iterations: 1,
      config: loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" }),
      db: new InMemoryDatabase(),
      registry: createFixtureProviderRegistry(),
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    expect(acceptancePackage.schemaVersion).toBe("acceptance-package/v1");
    expect(acceptancePackage.generatedAt).toBe("2026-05-18T00:00:00.000Z");
    expect(acceptancePackage.soak.acceptance.passed).toBe(true);
    expect(acceptancePackage.acceptance).toMatchObject({ passed: false, fixtureSoakPassed: true, releaseGatePassed: false, gaSignoffPassed: false });
    expect(acceptancePackage.gaSignoff).toMatchObject({
      checklistVersion: "ga-signoff/v1",
      explicitSignoffProvided: false,
      postGaMaintenancePlanReady: false,
      blockers: expect.arrayContaining([
        "explicit_ga_signoff_missing",
        "p0_p1_issues_not_closed",
        "residual_risk_not_accepted",
        "signoff_missing_role:product_owner"
      ])
    });
    expect(acceptancePackage.expectedProviderIds).toEqual(["hh", "robota", "telegram"]);
    expect(acceptancePackage.providerReadiness.find((provider) => provider.providerId === "telegram")?.readyForControlledAutoApply).toBe(false);
    expect(acceptancePackage.releaseEvidence.summary.blockers).toContain("missing_live_credentials_evidence");
    expect(acceptancePackage.acceptance.blockers).toEqual(
      expect.arrayContaining([
        "release_evidence:missing_live_credentials_evidence",
        "release_gate:Live provider/Telegram credentials are not configured",
        "ga_signoff:explicit_ga_signoff_missing"
      ])
    );

    expect(
      parseReleaseEvidenceRecords(
        JSON.stringify({
          records: [
            {
              evidenceId: "ev_test",
              evidenceType: "live_credentials_configured",
              providerId: null,
              status: "passed",
              observedAt: "2026-05-18T00:00:00.000Z",
              expiresAt: null,
              source: "test",
              metadata: {}
            }
          ]
        })
      )
    ).toHaveLength(1);
    expect(() => parseReleaseEvidenceRecords(JSON.stringify([{ evidenceId: "ev_bad", evidenceType: "unsafe" }]))).toThrow(
      /invalid evidenceType/
    );
    expect(loadReleaseEvidenceFile("missing-release-evidence.json")).toEqual([]);
    expect(loadGaSignoffFile("missing-ga-signoff.json")).toBeUndefined();
    expect(() => parseGaSignoffFile(JSON.stringify({ checklistVersion: "ga-signoff/v0" }))).toThrow(/invalid checklistVersion/);

    const invalidEvidenceReport = await buildReleaseEvidenceValidationReport({
      evidencePath: "missing-release-evidence.json",
      records: [],
      config: loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" }),
      registry: createFixtureProviderRegistry(),
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(invalidEvidenceReport).toMatchObject({
      schemaVersion: "release-evidence-validation/v1",
      valid: false,
      failures: expect.arrayContaining(["release_evidence:missing_live_credentials_evidence", "release_gate:Live provider/Telegram credentials are not configured"])
    });

    const fixtureCanaryReport = buildCanaryEvidenceReport({
      records: parseCanaryEvidenceResults(
        JSON.stringify({
          results: [{ providerId: "hh", status: "passed", id: "fixture-hh-canary", checkedAt: "2026-05-18T00:00:00.000Z" }]
        })
      ),
      expectedProviderIds: ["hh"],
      source: "fixture canary",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(fixtureCanaryReport).toMatchObject({
      liveEvidenceAllowed: false,
      evidenceRecords: [],
      failures: expect.arrayContaining(["live_canary_evidence_requires_live_source"])
    });
    const liveCanaryReport = buildCanaryEvidenceReport({
      records: ["hh", "robota", "telegram"].map((providerId) => ({
        providerId,
        status: "passed",
        canaryRunId: `canary-${providerId}-1`,
        checkedAt: "2026-05-18T00:00:00.000Z",
        checks: ["auth_canary", "search_results_canary", "job_page_canary"]
      })),
      source: "production provider canary workflow run 123",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(liveCanaryReport).toMatchObject({
      liveEvidenceAllowed: true,
      passedProviderIds: ["hh", "robota", "telegram"],
      missingProviderIds: [],
      evidenceRecords: [
        { evidenceType: "live_canary_passed", providerId: "hh", expiresAt: "2026-05-19T00:00:00.000Z", metadata: { canaryRunId: "canary-hh-1", checkedAt: "2026-05-18T00:00:00.000Z", result: "passed" } },
        { evidenceType: "live_canary_passed", providerId: "robota", expiresAt: "2026-05-19T00:00:00.000Z", metadata: { canaryRunId: "canary-robota-1", checkedAt: "2026-05-18T00:00:00.000Z", result: "passed" } },
        { evidenceType: "live_canary_passed", providerId: "telegram", expiresAt: "2026-05-19T00:00:00.000Z", metadata: { canaryRunId: "canary-telegram-1", checkedAt: "2026-05-18T00:00:00.000Z", result: "passed" } }
      ],
      failures: []
    });
    expect(
      buildCanaryEvidenceReport({
        records: [{ providerId: "hh", status: "passed", canaryRunId: "old-canary", checkedAt: "2026-05-18T00:00:00.000Z" }],
        expectedProviderIds: ["hh"],
        source: "production provider canary workflow run 123",
        liveEvidenceAllowed: true,
        now: new Date("2026-05-20T00:00:00.000Z")
      })
    ).toMatchObject({ evidenceRecords: [], failures: expect.arrayContaining(["canary_evidence_expired:hh"]) });
    const fixtureCalendarReport = buildCalendarEvidenceReport({
      record: parseCalendarEvidenceInput(
        JSON.stringify({
          calendarProvider: "google-calendar",
          checkedAt: "2026-05-18T00:00:00.000Z",
          readCheck: true,
          conflictCheck: true,
          writeCheck: true
        })
      ),
      source: "local calendar smoke",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(fixtureCalendarReport).toMatchObject({
      liveEvidenceAllowed: false,
      evidenceRecord: null,
      failures: expect.arrayContaining(["calendar_evidence_requires_live_source"])
    });
    const liveCalendarReport = buildCalendarEvidenceReport({
      record: {
        calendarProvider: "google-calendar",
        checkedAt: "2026-05-18T00:00:00.000Z",
        readCheck: true,
        conflictCheck: true,
        writeCheck: true
      },
      source: "production calendar smoke workflow run 42",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(liveCalendarReport).toMatchObject({
      liveEvidenceAllowed: true,
      evidenceRecord: {
        evidenceType: "calendar_integration_ready",
        status: "passed",
        expiresAt: "2026-05-19T00:00:00.000Z",
        metadata: {
          calendarProvider: "google-calendar",
          checkedAt: "2026-05-18T00:00:00.000Z",
          readCheck: true,
          conflictCheck: true,
          writeCheck: true
        }
      },
      failures: []
    });
    expect(
      buildCalendarEvidenceReport({
        record: {
          calendarProvider: "google-calendar",
          checkedAt: "2026-05-18T00:00:00.000Z",
          readCheck: true,
          conflictCheck: true,
          writeCheck: true
        },
        source: "production calendar smoke workflow run 42",
        liveEvidenceAllowed: true,
        now: new Date("2026-05-20T00:00:00.000Z")
      })
    ).toMatchObject({ evidenceRecord: null, failures: expect.arrayContaining(["calendar_evidence_expired"]) });
    const fixtureOutboundReport = buildOutboundDispatchEvidenceReport({
      proof: parseOutboundDispatchEvidenceInput(
        JSON.stringify({
          proofId: "fixture-proof",
          transport: "fixture",
          status: "proof_recorded",
          idempotencyKey: "fixture-idempotency",
          textHash: "fixture-text-hash",
          rawMessage: "hello"
        })
      ),
      source: "fixture dispatch proof",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(fixtureOutboundReport).toMatchObject({
      liveEvidenceAllowed: false,
      evidenceRecord: null,
      input: { idempotencyKeyPresent: true },
      failures: expect.arrayContaining([
        "outbound_dispatch_evidence_requires_live_source",
        "live_transport_required",
        "sent_delivery_status_required",
        "delivered_at_required",
        "raw_message_not_allowed"
      ])
    });
    expect(JSON.stringify(fixtureOutboundReport)).not.toContain("fixture-idempotency");
    expect(JSON.stringify(fixtureOutboundReport)).not.toContain("hello");
    const liveOutboundReport = buildOutboundDispatchEvidenceReport({
      proof: {
        proofId: "proof-live-1",
        transport: "telegram",
        status: "sent",
        idempotencyKey: "live-idempotency-key",
        textHash: "hash-text",
        deliveredAt: "2026-05-18T00:00:00.000Z"
      },
      source: "production dispatch workflow run 7",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(liveOutboundReport).toMatchObject({
      liveEvidenceAllowed: true,
      evidenceRecord: {
        evidenceType: "outbound_dispatch_proof_ready",
        status: "passed",
        expiresAt: "2026-05-19T00:00:00.000Z",
        metadata: {
          proofId: "proof-live-1",
          transport: "telegram",
          idempotencyKeyHash: stableHash("live-idempotency-key"),
          textHash: "hash-text",
          deliveryStatus: "sent",
          deliveredAt: "2026-05-18T00:00:00.000Z"
        }
      },
      failures: []
    });
    expect(JSON.stringify(liveOutboundReport)).not.toContain("live-idempotency-key");
    const fixtureProviderSubmitReport = buildProviderSubmitEvidenceReport({
      proof: parseProviderSubmitEvidenceInput(
        JSON.stringify({
          providerId: "hh",
          applicationId: "app-fixture",
          proofId: "fixture-provider-proof",
          draftHash: "hash-draft",
          transport: "fixture",
          status: "queued",
          idempotencyKey: "fixture-provider-idempotency",
          submittedAt: "2026-05-18T00:00:00.000Z",
          rawPayload: { coverLetterText: "raw letter" }
        })
      ),
      expectedProviderIds: ["hh"],
      source: "fixture provider submit proof",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(fixtureProviderSubmitReport).toMatchObject({
      liveEvidenceAllowed: false,
      evidenceRecord: null,
      input: { idempotencyKeyPresent: true, rawApplicationPayloadPresent: true },
      failures: expect.arrayContaining([
        "provider_submit_evidence_requires_live_source",
        "provider_transport_required",
        "submitted_status_required",
        "raw_application_payload_not_allowed"
      ])
    });
    expect(JSON.stringify(fixtureProviderSubmitReport)).not.toContain("fixture-provider-idempotency");
    expect(JSON.stringify(fixtureProviderSubmitReport)).not.toContain("raw letter");
    const liveProviderSubmitReport = buildProviderSubmitEvidenceReport({
      proof: {
        providerId: "hh",
        applicationId: "app-live-1",
        proofId: "provider-proof-live-1",
        draftHash: "hash-draft",
        idempotencyKey: "live-provider-submit-idempotency",
        submitStatus: "submitted",
        submittedAt: "2026-05-18T00:00:00.000Z"
      },
      expectedProviderIds: ["hh"],
      source: "production provider submit workflow run 23",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(liveProviderSubmitReport).toMatchObject({
      liveEvidenceAllowed: true,
      evidenceRecord: {
        evidenceType: "provider_submit_proof_ready",
        providerId: "hh",
        status: "passed",
        expiresAt: "2026-05-19T00:00:00.000Z",
        metadata: {
          applicationId: "app-live-1",
          proofId: "provider-proof-live-1",
          action: "send_application",
          transport: "provider",
          idempotencyKeyHash: stableHash("live-provider-submit-idempotency"),
          draftHash: "hash-draft",
          submitStatus: "submitted",
          submittedAt: "2026-05-18T00:00:00.000Z"
        }
      },
      failures: []
    });
    expect(JSON.stringify(liveProviderSubmitReport)).not.toContain("live-provider-submit-idempotency");
    const localSoakReport = buildSoakEvidenceReport({
      report: parseSoakEvidenceInput(
        JSON.stringify({
          startedAt: "2026-05-18T00:00:00.000Z",
          completedAt: "2026-05-18T01:00:00.000Z",
          duplicateApplicationCount: 0,
          proofCoveragePercent: 100,
          stateLossDetected: false,
          unsupportedFactCount: 0,
          incidentDrillPassed: true,
          rollbackDrillPassed: true,
          acceptance: { passed: true }
        })
      ),
      source: "local accelerated soak",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(localSoakReport).toMatchObject({
      liveEvidenceAllowed: false,
      evidenceRecord: null,
      failures: expect.arrayContaining(["soak_evidence_requires_live_source", "minimum_seven_day_duration_required"])
    });
    const liveSoakReport = buildSoakEvidenceReport({
      report: {
        startedAt: "2026-05-10T00:00:00.000Z",
        completedAt: "2026-05-18T00:00:00.000Z",
        duplicateApplicationCount: 0,
        proofCoveragePercent: 100,
        stateLossDetected: false,
        unsupportedFactCount: 0,
        incidentDrillPassed: true,
        rollbackDrillPassed: true,
        acceptancePassed: true
      },
      source: "production seven day soak run 2026-05-10",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(liveSoakReport).toMatchObject({
      liveEvidenceAllowed: true,
      durationDays: 8,
      evidenceRecord: {
        evidenceType: "seven_day_soak_passed",
        status: "passed",
        expiresAt: "2026-06-17T00:00:00.000Z",
        metadata: {
          duplicateApplicationCount: 0,
          proofCoveragePercent: 100,
          stateLossDetected: false,
          unsupportedFactCount: 0,
          incidentDrillPassed: true,
          rollbackDrillPassed: true
        }
      },
      failures: []
    });
    expect(
      buildSoakEvidenceReport({
        report: {
          completedAt: "2026-05-18T00:00:00.000Z",
          durationDays: 8,
          duplicateApplicationCount: 0,
          proofCoveragePercent: 100,
          stateLossDetected: false,
          unsupportedFactCount: 0,
          incidentDrillPassed: true,
          rollbackDrillPassed: true,
          acceptancePassed: true
        },
        source: "production seven day soak run 2026-05-10",
        liveEvidenceAllowed: true,
        now: new Date("2026-05-18T00:00:00.000Z")
      })
    ).toMatchObject({ evidenceRecord: null, failures: expect.arrayContaining(["started_at_required", "minimum_seven_day_duration_required"]) });

    const completeReleaseEvidence = parseReleaseEvidenceRecords(
      JSON.stringify({
        records: [
          {
            evidenceId: "cred-all",
            evidenceType: "live_credentials_configured",
            providerId: null,
            status: "passed",
            observedAt: "2026-05-18T00:00:00.000Z",
            expiresAt: "2026-05-19T00:00:00.000Z",
            source: "vault credential coverage check run 1",
            metadata: {
              checkedAt: "2026-05-18T00:00:00.000Z",
              secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/robota/session", "vault://job-search/telegram/bot"],
              coveredProviderIds: ["hh", "robota", "telegram"],
              telegramBot: true
            }
          },
          {
            evidenceId: "secrets-vault",
            evidenceType: "external_secrets_backend",
            providerId: null,
            status: "passed",
            observedAt: "2026-05-18T00:00:00.000Z",
            expiresAt: "2026-05-19T00:00:00.000Z",
            source: "vault access probe run 1",
            metadata: { backend: "vault", accessCheck: true, checkedAt: "2026-05-18T00:00:00.000Z" }
          },
	          ...liveCanaryReport.evidenceRecords,
	          {
	            evidenceId: "provider-submit-live",
	            evidenceType: "provider_submit_proof_ready",
	            providerId: "hh",
	            status: "passed",
	            observedAt: "2026-05-18T00:00:00.000Z",
	            expiresAt: "2026-05-19T00:00:00.000Z",
	            source: "production provider submit workflow run 23",
	            metadata: {
	              applicationId: "app-live-1",
	              proofId: "provider-submit-proof-1",
	              action: "send_application",
	              transport: "provider",
	              idempotencyKeyHash: "hash-submit-idempotency",
	              draftHash: "hash-draft",
	              submitStatus: "submitted",
	              submittedAt: "2026-05-18T00:00:00.000Z"
	            }
	          },
	          liveCalendarReport.evidenceRecord!,
          liveOutboundReport.evidenceRecord!,
          liveSoakReport.evidenceRecord!
        ]
      })
    );
    const productionObjectStorageEnv = {
      OBJECT_STORAGE_BACKEND: "s3_compatible",
      OBJECT_STORAGE_S3_ENDPOINT: "https://s3.example.test",
      OBJECT_STORAGE_S3_BUCKET: "job-search-artifacts",
      OBJECT_STORAGE_S3_REGION: "eu-central-1",
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: "access-key",
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "secret-key"
    };
    const productionRuntimeEnv = {
      STATE_BACKEND: "postgres",
      QUEUE_BACKEND: "bullmq",
      TELEGRAM_BOT_TOKEN: "telegram-bot-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret",
      LLM_PROVIDER: "openai-compatible",
      LLM_API_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "llm-api-key"
    };
    const productionProviderEnv = {
      PROVIDER_CONFIG_JSON: JSON.stringify([
        { providerId: "hh", enabled: true, statusOverride: "stable" },
        { providerId: "robota", enabled: true, statusOverride: "stable" }
      ])
    };
    const missingProviderConfigReport = await buildReleaseEvidenceValidationReport({
      evidencePath: "release-evidence.json",
      records: completeReleaseEvidence,
      config: loadConfig({
        NODE_ENV: "production",
        API_TOKEN: "prod-token",
        APP_MODE: "controlled_auto_apply",
        IRREVERSIBLE_ACTIONS_ENABLED: "true",
        SECRETS_BACKEND: "vault",
        ...productionRuntimeEnv,
        ...productionObjectStorageEnv
      }),
      registry: createFixtureProviderRegistry(),
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(missingProviderConfigReport).toMatchObject({
      valid: false,
      failures: expect.arrayContaining(["release_gate:Providers not ready: hh, robota"])
    });
    expect(missingProviderConfigReport.providerReadiness.find((provider) => provider.providerId === "hh")?.blockers).toContain("disable_switch_missing");
    expect(missingProviderConfigReport.providerReadiness.find((provider) => provider.providerId === "hh")?.blockers).toContain("live_submit_implementation_missing");
    const liveCapableRegistry = createLiveCapableProviderRegistry();
    const validEvidenceReport = await buildReleaseEvidenceValidationReport({
      evidencePath: "release-evidence.json",
      records: completeReleaseEvidence,
      config: loadConfig({
        NODE_ENV: "production",
        API_TOKEN: "prod-token",
        APP_MODE: "controlled_auto_apply",
        IRREVERSIBLE_ACTIONS_ENABLED: "true",
        SECRETS_BACKEND: "vault",
        ...productionRuntimeEnv,
        ...productionProviderEnv,
        ...productionObjectStorageEnv
      }),
      registry: liveCapableRegistry,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(validEvidenceReport).toMatchObject({
      valid: true,
      failures: [],
      releaseGate: { readyForLiveAutomation: true }
    });

    const productionConfig = loadConfig({
      NODE_ENV: "production",
      API_TOKEN: "prod-token",
      APP_MODE: "controlled_auto_apply",
      IRREVERSIBLE_ACTIONS_ENABLED: "true",
      SECRETS_BACKEND: "vault",
      ...productionRuntimeEnv,
      ...productionProviderEnv,
      ...productionObjectStorageEnv
    });
    const missingSignoffPackage = await buildAcceptancePackage({
      iterations: 1,
      releaseEvidence: completeReleaseEvidence,
      config: productionConfig,
      registry: liveCapableRegistry,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(missingSignoffPackage.acceptance).toMatchObject({ passed: false, releaseGatePassed: true, gaSignoffPassed: false });
    expect(missingSignoffPackage.acceptance.blockers).toContain("ga_signoff:explicit_ga_signoff_missing");

    const completeGaSignoff = parseGaSignoffFile(
      JSON.stringify({
        checklistVersion: "ga-signoff/v1",
        p0P1Closed: true,
        p2P3HaveOwners: true,
        runbookDrillsReviewed: true,
        residualRiskAccepted: true,
        postGaMaintenancePlanReady: true,
        evidenceRefs: {
          issueRegister: "release/2026-05-18/issues",
          runbookDrillReport: "release/2026-05-18/runbook-drills",
          residualRiskRecord: "release/2026-05-18/residual-risk",
          maintenancePlan: "release/2026-05-18/maintenance-plan"
        },
        signers: [
          { role: "product_owner", name: "Product Owner", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
          { role: "engineering", name: "Engineering Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
          { role: "operations", name: "Operations Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
          { role: "security", name: "Security Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" }
        ]
      })
    );
    expect(buildGaSignoffValidationReport({ signoff: completeGaSignoff, now: new Date("2026-05-18T00:00:00.000Z") })).toMatchObject({
      schemaVersion: "ga-signoff-validation/v1",
      explicitSignoffProvided: true,
      signers: 4,
      valid: true,
      blockers: [],
      parseError: null
    });
    expect(
      buildGaSignoffValidationReport({
        signoff: {
          ...completeGaSignoff,
          signers: completeGaSignoff.signers.map((signer) => ({ ...signer, date: "2026-05-19T00:00:00.000Z" }))
        },
        now: new Date("2026-05-18T00:00:00.000Z")
      }).blockers
    ).toContain("signoff_date_in_future:product_owner");
    const signedAcceptancePackage = await buildAcceptancePackage({
      iterations: 1,
      releaseEvidence: completeReleaseEvidence,
      gaSignoff: completeGaSignoff,
      config: productionConfig,
      registry: liveCapableRegistry,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(signedAcceptancePackage.acceptance).toMatchObject({ passed: true, releaseGatePassed: true, gaSignoffPassed: true });
    expect(signedAcceptancePackage.gaSignoff.blockers).toEqual([]);

    const templateReleaseEvidence = parseReleaseEvidenceRecords(readFileSync("docs/examples/release-evidence.example.json", "utf8"));
    const templateGaSignoff = parseGaSignoffFile(readFileSync("docs/examples/ga-signoff.example.json", "utf8"));
    const templateEvidenceReport = await buildReleaseEvidenceValidationReport({
      evidencePath: "docs/examples/release-evidence.example.json",
      records: templateReleaseEvidence,
      config: loadConfig({
        NODE_ENV: "production",
        API_TOKEN: "prod-token",
        APP_MODE: "controlled_auto_apply",
        IRREVERSIBLE_ACTIONS_ENABLED: "true",
        SECRETS_BACKEND: "vault",
        ...productionProviderEnv,
        ...productionObjectStorageEnv
      }),
      registry: createFixtureProviderRegistry(),
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(templateEvidenceReport).toMatchObject({
      records: 9,
      valid: false,
      failures: expect.arrayContaining([expect.stringContaining("release_evidence:invalid_release_evidence:cred-all:")])
    });
    expect(templateGaSignoff.signers.map((signer) => signer.role).sort()).toEqual(["engineering", "operations", "product_owner", "security"]);
    expect(buildGaSignoffChecklist({ signoff: templateGaSignoff }).blockers).toContain("signoff_example_value:product_owner");
    expect(buildGaSignoffValidationReport({ signoff: templateGaSignoff }).valid).toBe(false);
  });

  it("creates review records for sensitive inbox messages and failed LLM classification", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const registry = {
      list: () => [
        {
          providerId: "hh",
          capabilities: { inboxSync: true },
          healthcheck: async () => ({
            providerId: "hh",
            status: "stable",
            checkedAt: "2026-05-18T00:00:00.000Z",
            latencyMs: 1,
            message: "ok"
          }),
          syncInbox: async () => [
            {
              providerId: "hh",
              accountId: "fixture-account",
              externalMessageId: "sensitive-1",
              conversationExternalId: "conv-sensitive",
              receivedAt: new Date().toISOString(),
              senderName: "Recruiter",
              text: "Please send your passport and citizenship.",
              linkedJobExternalId: null
            },
            {
              providerId: "hh",
              accountId: "fixture-account",
              externalMessageId: "safe-1",
              conversationExternalId: "conv-safe",
              receivedAt: new Date().toISOString(),
              senderName: "Recruiter",
              text: "Thanks, received.",
              linkedJobExternalId: null
            }
          ]
        }
      ]
    } as never;
    const llm = {
      classifyMessage: async (text: string, timezone: string) => ({
        ok: !text.includes("Thanks"),
        value: null,
        validationErrors: text.includes("Thanks") ? ["forced failure"] : [],
        modelVersion: "test",
        inputHash: timezone
      })
    } as never;

    expect(await runInboxWorker({ config, db, registry, llm })).toEqual({ classified: 2, manualReviewCreated: 2 });
    expect([...db.manualReviewItems.values()].map((item) => item.reasonCode)).toEqual(
      expect.arrayContaining(["sensitive_data_requested", "reply_requires_review"])
    );
  });
});

function makeProofPack(proofPackId: string, entityId: string): ProofPack {
  return {
    proofPackId,
    provider: "hh",
    accountId: "fixture-account",
    entityId,
    flowId: "hh_auto_apply_dry_run_v1",
    flowVersion: "test",
    selectorPackVersion: "test",
    startedAt: "2026-05-18T08:00:00.000Z",
    completedAt: "2026-05-18T08:01:00.000Z",
    preActionScreenshotKey: `${proofPackId}/pre.png`,
    postActionScreenshotKey: `${proofPackId}/post.png`,
    domSnapshotBeforeKey: `${proofPackId}/before.html`,
    domSnapshotAfterKey: `${proofPackId}/after.html`,
    confirmationText: "submit boundary reached",
    confirmationUrl: "https://example.test/confirmation",
    finalStatus: "submit_boundary_reached",
    errorCode: null,
    auditEventId: null
  };
}

function approveApplication(db: InMemoryDatabase, application: { id: string; draftVariantKey?: string | null }) {
  const draftHash = application.draftVariantKey ?? `draft-${application.id}`;
  application.draftVariantKey = draftHash;
  const approval = db.createApprovalRequest({
    userId: db.candidateProfile.userId,
    entityType: "application",
    entityId: application.id,
    requestedAction: "send_application",
    expiresAt: "2026-05-19T00:00:00.000Z",
    policyDecisionId: null,
    draftHash,
    manualReviewId: null
  });
  db.resolveApprovalRequest({
    id: approval.id,
    resolution: "approved",
    actor: "test",
    draftHash,
    now: new Date("2026-05-18T00:00:00.000Z")
  });
  return { approvalRequestId: approval.id, approvedDraftHash: draftHash };
}

function createLiveCapableProviderRegistry() {
  const registry = createFixtureProviderRegistry();
  for (const provider of registry.list()) {
    Object.assign(provider, { runtimeKind: "live" as const });
  }
  return registry;
}
