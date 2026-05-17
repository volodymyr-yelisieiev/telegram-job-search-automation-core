import { describe, expect, it } from "vitest";
import { loadConfig } from "@job-search/config";
import { InMemoryDatabase } from "@job-search/db";
import { createAuditEvent, InterviewCoordinator } from "@job-search/domain";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { createScoredFixtureJobs } from "@job-search/testing";
import { runLocalPipeline } from "../../apps/api/src/runtime";
import { buildServer } from "../../apps/api/src/server";
import { createTelegramCommandState, handleTelegramCommand } from "../../apps/telegram-bot/src/commands";
import { runApplyWorker } from "../../apps/worker-apply/src/runner";
import { runCanaryWorker } from "../../apps/worker-canary/src/runner";
import { runDigestWorker } from "../../apps/worker-digest/src/runner";
import { runInboxWorker } from "../../apps/worker-inbox/src/runner";
import { runIngestWorker } from "../../apps/worker-ingest/src/runner";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("API, Telegram and worker hardening", () => {
  it("requires auth, keeps mode consistent, and renders digest text", async () => {
    const config = loadConfig({ APP_MODE: "paused", API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });

    expect((await server.inject({ method: "GET", url: "/status" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ mode: "paused" });

    const status = await server.inject({ method: "GET", url: "/status", headers: auth(config.api.token) });
    const telegramStatus = await server.inject({ method: "GET", url: "/status/telegram", headers: auth(config.api.token) });
    expect(status.json().mode).toBe("paused");
    expect(telegramStatus.body).toContain("Mode: paused");

    const digest = await server.inject({ method: "GET", url: "/digest", headers: auth(config.api.token) });
    expect(digest.body).toContain("Pipeline\nDiscovered:");
    expect(digest.body).not.toContain('"stats"');

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
  });

  it("branches pipeline applications by approval, allow, and CAPTCHA safe-mode results", async () => {
    const reviewConfig = loadConfig({ APP_MODE: "review_first", API_TOKEN: "test-token" });
    const reviewDb = new InMemoryDatabase();
    reviewDb.candidateProfile.userConsent.autoApply = true;
    const reviewResult = await runLocalPipeline({ config: reviewConfig, db: reviewDb, registry: createFixtureProviderRegistry() });
    expect(reviewResult.manualReview).toBe(2);
    expect([...reviewDb.applications.values()].every((application) => application.status === "manual_review_required")).toBe(true);

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

    await server.close();

    const defaultServer = await buildServer({ config });
    expect((await defaultServer.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await defaultServer.close();
  });

  it("sweeps authenticated API endpoints with x-api-token and persisted local state", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
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
      dedupKey: "hh:hh-1001",
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
    db.updateProviderHealth({
      providerId: "hh",
      status: "degraded",
      checkedAt: new Date().toISOString(),
      latencyMs: 5,
      message: "seeded degraded provider"
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

    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });
    const headers = { "x-api-token": config.api.token };

    for (const route of ["/pipeline", "/profiles", "/jobs", "/applications", "/manual-review", "/audit", "/metrics", "/responses", "/interviews", "/digest"]) {
      const response = await server.inject({ method: "GET", url: route, headers });
      expect(response.statusCode).toBe(200);
    }

    expect((await server.inject({ method: "GET", url: "/pipeline", headers })).json().stats.applied).toBe(1);
    expect((await server.inject({ method: "GET", url: "/responses", headers })).json().responses).toHaveLength(1);
    expect((await server.inject({ method: "GET", url: "/interviews", headers })).json().interviews).toHaveLength(1);

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
    expect(await handleTelegramCommand({ text: "/set_profile missing", db, state })).toContain("Profile not found");
    expect(await handleTelegramCommand({ text: "/set_profile backend-node-main", db, state })).toContain("backend-node-main");
    expect(await handleTelegramCommand({ text: "/blacklist_company", db, state })).toContain("Usage");
    expect(await handleTelegramCommand({ text: "/manual_review", db, state })).toContain("empty");
    expect(await handleTelegramCommand({ text: "/blacklist_company Example GmbH", db, state })).toContain("Queued for manual review");
    expect(await handleTelegramCommand({ text: "/manual_review", db, state })).toContain("blacklist_company");
    expect(await handleTelegramCommand({ text: "/digest_now", db, state })).toContain("Digest");
    expect(await handleTelegramCommand({ text: "/job", db, state })).toContain("Usage");
    expect(await handleTelegramCommand({ text: "/job missing", db, state })).toContain("Job not found");
    expect(await handleTelegramCommand({ text: "/jobs_applied", db, state })).toContain("none prepared");
    expect(await handleTelegramCommand({ text: "/sources", db, state })).toContain("no health checks");
    db.auditEvents.push(createAuditEvent({ entityType: "job", entityId: "job-1", eventType: "test_event", actor: "test" }));
    expect(await handleTelegramCommand({ text: "/logs job-1", db, state })).toContain("test_event");
    expect(await handleTelegramCommand({ text: "/logs missing", db, state })).toContain("no audit events");
    expect(await handleTelegramCommand({ text: "/retry_provider hh", db, state })).toContain("Queued for manual review");
    expect(await handleTelegramCommand({ text: "/unknown", db, state })).toContain("Supported commands");
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
    db.updateProviderHealth({ providerId: "hh", status: "stable", checkedAt: new Date().toISOString(), latencyMs: 1, message: "ok" });
    db.updateProviderHealth({
      providerId: "robota",
      status: "needs_review",
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      message: "review"
    });
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
    db.recordInterviewEvent(
      new InterviewCoordinator().createEvent({
        jobId: scored!.job.id,
        companyId: "company-1",
        conversationId: inbound.record.conversationId,
        slot: { date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" }
      })
    );

    expect(await handleTelegramCommand({ text: "/start", db, state })).toContain("Telegram Job Search Automation Core");
    expect(await handleTelegramCommand({ text: "/pipeline", db, state })).toContain("Applied: 1");
    expect(await handleTelegramCommand({ text: "/profiles", db, state })).toContain(db.candidateProfile.displayName);
    expect(await handleTelegramCommand({ text: "/sources", db, state })).toContain("robota: needs_review");
    expect(await handleTelegramCommand({ text: `/job ${scored!.job.id}`, db, state })).toContain(scored!.job.title);
    expect(await handleTelegramCommand({ text: "/jobs_applied_week", db, state })).toContain("applied: hh/hh-1001");
    expect(await handleTelegramCommand({ text: "/responses", db, state })).toContain("scheduling_request");
    expect(await handleTelegramCommand({ text: "/interviews", db, state })).toContain("scheduled");
    expect(await handleTelegramCommand({ text: "/whitelist_company Example GmbH", db, state })).toContain("Queued for manual review");
    expect(await handleTelegramCommand({ text: "/digest_now", db, state })).toContain("robota");
  });

  it("runs testable worker functions and exposes failures", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const registry = createFixtureProviderRegistry();

    expect(await runIngestWorker({ config, db, registry })).toEqual({ processed: 4 });
    expect(runApplyWorker()).toMatchObject({ status: "succeeded", reachedSubmitBoundary: true });
    const applyDb = new InMemoryDatabase();
    expect(runApplyWorker({ db: applyDb, guardResults: { no_captcha: false } })).toMatchObject({
      status: "manual_review_required",
      errorCode: "captcha_required"
    });
    expect(applyDb.providerHealth.get("hh")?.status).toBe("needs_review");

    const inboxDb = new InMemoryDatabase();
    expect(await runInboxWorker({ config, db: inboxDb, registry })).toMatchObject({ classified: 2 });
    expect(await runInboxWorker({ config, db: inboxDb, registry })).toMatchObject({ classified: 0, manualReviewCreated: 0 });
    expect(inboxDb.inboundMessages.size).toBe(2);
    expect(runDigestWorker(db)).toContain("Pipeline");
    const canaryDb = new InMemoryDatabase();
    expect((await runCanaryWorker({ registry, db: canaryDb })).every((result) => result.status === "passed")).toBe(true);
    expect(canaryDb.canaryRuns.size).toBe(3);

    const customCanary = await runCanaryWorker({
      registry: { list: () => [{ providerId: "custom-provider" }] } as never,
      db: canaryDb
    });
    expect(customCanary[0]).toMatchObject({ status: "failed" });
  });

  it("creates review records for sensitive inbox messages and failed LLM classification", async () => {
    const config = loadConfig({ API_TOKEN: "test-token" });
    const db = new InMemoryDatabase();
    const registry = {
      list: () => [
        {
          providerId: "hh",
          capabilities: { inboxSync: true },
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
