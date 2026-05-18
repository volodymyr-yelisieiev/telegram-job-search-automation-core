import { describe, expect, it } from "vitest";
import { createPool, InMemoryDatabase, PostgresRuntimeDatabase, runMigrations } from "@job-search/db";
import type { OutboundDispatchResult, OutboundMessage, ProofPack } from "@job-search/domain";
import { createScoredFixtureJobs } from "@job-search/testing";

async function exerciseRepositoryContract(db: InMemoryDatabase) {
  const suffix = `${Date.now()}-${Math.random()}`;
  const [fixture] = await createScoredFixtureJobs();
  const job = { ...fixture!.job, id: `job-contract-${suffix}`, externalId: `hh-contract-${suffix}` };
  db.upsertJob(job);
  db.saveScore(job.id, fixture!.score);
  const application = db.createApplication({
    jobId: job.id,
    providerId: "hh",
    externalJobId: job.externalId,
    status: "application_prepared",
    idempotencyKey: `apply:contract:hh:${suffix}`,
    dedupKey: `hh:contract:${suffix}`
  });
  expect(
    db.createApplication({
      jobId: job.id,
      providerId: "hh",
      externalJobId: job.externalId,
      status: "application_prepared",
      idempotencyKey: `apply:contract:hh:${suffix}`,
      dedupKey: `hh:contract:${suffix}`
    }).id
  ).toBe(application.id);
  const review = db.createManualReview({
    userId: "user-contract",
    entityType: "application",
    entityId: application.id,
    reasonCode: "contract_review",
    severity: "medium",
    recommendedAction: "Review contract fixture"
  });
  expect(db.resolveManualReview({ id: review.id, resolution: "approved", actor: "contract" })).toMatchObject({ status: "approved" });
  const approval = db.createApprovalRequest({
    userId: "user-contract",
    entityType: "application",
    entityId: application.id,
    requestedAction: "send_application",
    expiresAt: "2026-05-19T00:00:00.000Z",
    policyDecisionId: null,
    draftHash: "contract-draft",
    manualReviewId: review.id
  });
  expect(
    db.resolveApprovalRequest({
      id: approval.id,
      resolution: "approved",
      actor: "contract",
      draftHash: "contract-draft",
      now: new Date("2026-05-18T00:00:00.000Z")
    })
  ).toMatchObject({ status: "approved" });
  db.recordReleaseEvidence({
    evidenceType: "live_credentials_configured",
    providerId: null,
    status: "passed",
    observedAt: "2026-05-18T00:00:00.000Z",
    expiresAt: "2026-05-19T00:00:00.000Z",
    source: "contract",
    metadata: {
      checkedAt: "2026-05-18T00:00:00.000Z",
      secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/robota/session", "vault://job-search/telegram/bot"],
      coveredProviderIds: ["hh", "robota", "telegram"],
      telegramBot: true
    }
  });
  if (db instanceof PostgresRuntimeDatabase) {
    await db.flushPersistence();
  }
  expect(db.status().applications).toBeGreaterThanOrEqual(1);
  expect(db.status().manualReviewItems).toBeGreaterThanOrEqual(1);
  expect(db.status().approvalRequests).toBeGreaterThanOrEqual(1);
  expect(db.status().releaseEvidence).toBeGreaterThanOrEqual(1);
}

describe("Postgres migration verification", () => {
  it("runs repository contract against in-memory implementation", async () => {
    await exerciseRepositoryContract(new InMemoryDatabase());
  });

  it("runs migrations and exposes required indexes when Docker Postgres is available", async () => {
    const pool = createPool(process.env.DATABASE_URL ?? "postgres://job_search:job_search@127.0.0.1:5432/job_search");
    try {
      await pool.query("SELECT 1");
    } catch {
      await pool.end();
      console.warn("Skipping Postgres migration verification because DATABASE_URL is unavailable");
      return;
    }

    try {
      await runMigrations(pool);
      const tables = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
      );
      const indexes = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining(["normalized_jobs", "dedup_jobs", "applications", "audit_logs", "manual_review_items"])
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining(["dedup_jobs_provider_job_key_uidx", "dedup_jobs_canonical_url_key_uidx", "applications_idempotency_key_uidx"])
      );
    } finally {
      await pool.end();
    }
  });

  it("persists application lifecycle metadata in Postgres-shaped writes", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const db = new PostgresRuntimeDatabase({
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
    } as never);

    const application = db.createApplication({
      jobId: "job-lifecycle",
      providerId: "hh",
      externalJobId: "hh-lifecycle",
      status: "application_prepared",
      idempotencyKey: "apply:lifecycle",
      dedupKey: "hh:lifecycle",
      draftVariantKey: "draft-hash-lifecycle",
      proofPackId: "dry-run-proof",
      policyDecision: "allow",
      policyVersion: "policy-v1"
    });
    db.recordProofPack({
      proofPack: makeProofPack("submit-proof", application.jobId),
      entityType: "application",
      entityId: application.id,
      actor: "test"
    });

    await db.flushPersistence();

    const applicationInsert = queries.find((query) => query.sql.includes("INSERT INTO applications"));
    expect(applicationInsert?.sql).toContain("draft_variant_key");
    expect(applicationInsert?.values).toEqual(expect.arrayContaining(["draft-hash-lifecycle", "dry-run-proof", "allow", "policy-v1"]));
    expect(application.proofPackId).toBe("submit-proof");
    expect(queries.find((query) => query.sql.includes("INSERT INTO application_artifacts"))?.values).toEqual(
      expect.arrayContaining([application.id, "submit-proof"])
    );
    expect(queries.some((query) => query.sql.includes("UPDATE applications") && query.sql.includes("proof_pack_id"))).toBe(true);
  });

  it("persists outbound delivery ids in Postgres-shaped writes", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const db = new PostgresRuntimeDatabase({
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
    } as never);
    const message: OutboundMessage = {
      conversationId: "conv-1",
      inboundMessageId: "inbound-1",
      category: "scheduling_request",
      language: "en",
      text: "Thanks, the proposed slot works.",
      factsUsed: [],
      idempotencyKey: "reply:conv-1:inbound-1:slot"
    };
    const result: OutboundDispatchResult = {
      status: "sent",
      deliveryId: "delivery-live-hash",
      errors: [],
      proof: {
        proofId: "proof-outbound",
        outboundMessageId: "outbound-1",
        providerId: "telegram",
        accountId: "bot",
        conversationId: message.conversationId,
        inboundMessageId: message.inboundMessageId,
        idempotencyKey: message.idempotencyKey,
        transport: "telegram",
        status: "sent",
        textHash: "text-hash",
        validationHash: "validation-hash",
        policyDecision: "allow",
        createdAt: "2026-05-18T00:00:00.000Z",
        deliveredAt: "2026-05-18T00:00:01.000Z"
      }
    };

    db.recordOutboundDispatch({ providerId: "telegram", accountId: "bot", message, result, actor: "test" });
    await db.flushPersistence();

    const outboundInsert = queries.find((query) => query.sql.includes("INSERT INTO outbound_dispatch_proofs"));
    expect(outboundInsert?.sql).toContain("delivery_id");
    expect(outboundInsert?.values).toEqual(expect.arrayContaining(["delivery-live-hash", message]));
  });

  it("persists canary details and replay reports in Postgres-shaped writes", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const db = new PostgresRuntimeDatabase({
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
    } as never);

    db.recordCanaryRun({ providerId: "hh", status: "failed", checks: ["selector"], failures: ["selector_missing"] });
    db.recordReplayReport({ flowRunId: "flow-1", status: "replayed", summary: "ok", reproducedError: null, recommendedAction: "none" });
    await db.flushPersistence();

    const canaryInsert = queries.find((query) => query.sql.includes("INSERT INTO provider_canary_runs"));
    expect(canaryInsert?.sql).toContain("checks");
    expect(canaryInsert?.sql).toContain("failures");
    expect(canaryInsert?.values).toEqual(expect.arrayContaining([JSON.stringify(["selector"]), JSON.stringify(["selector_missing"])]));
    expect(queries.find((query) => query.sql.includes("INSERT INTO automation_replay_reports"))?.values).toEqual(
      expect.arrayContaining(["flow-1", expect.objectContaining({ status: "replayed" })])
    );
  });

  it("upserts full interview event state in Postgres-shaped writes", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const db = new PostgresRuntimeDatabase({
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
    } as never);

    db.recordInterviewEvent({
      interviewId: "interview-1",
      jobId: "job-1",
      companyId: "company-1",
      conversationId: "conv-1",
      dateTime: "2026-05-20T14:00:00.000Z",
      timezone: "Europe/Vienna",
      format: "video_call",
      link: "https://meet.example/1",
      recruiterName: "Recruiter",
      status: "pending_confirmation",
      summaryPackId: "summary-1"
    });
    await db.flushPersistence();

    const interviewUpsert = queries.find((query) => query.sql.includes("INSERT INTO interview_events"));
    expect(interviewUpsert?.sql).toContain("date_time = EXCLUDED.date_time");
    expect(interviewUpsert?.sql).toContain("summary_pack_id = EXCLUDED.summary_pack_id");
  });

  it("runs repository contract against Postgres implementation when available", async () => {
    const pool = createPool(process.env.DATABASE_URL ?? "postgres://job_search:job_search@127.0.0.1:5432/job_search");
    try {
      await pool.query("SELECT 1");
    } catch {
      await pool.end();
      console.warn("Skipping Postgres repository contract because DATABASE_URL is unavailable");
      return;
    }

    await pool.end();
    const db = await PostgresRuntimeDatabase.connect(process.env.DATABASE_URL ?? "postgres://job_search:job_search@127.0.0.1:5432/job_search");
    try {
      await exerciseRepositoryContract(db);
    } finally {
      await db.close();
    }
  });
});

function makeProofPack(proofPackId: string, entityId: string): ProofPack {
  return {
    proofPackId,
    provider: "hh",
    accountId: "account-1",
    entityId,
    flowId: "submit",
    flowVersion: "v1",
    selectorPackVersion: "v1",
    startedAt: "2026-05-18T00:00:00.000Z",
    completedAt: "2026-05-18T00:00:10.000Z",
    preActionScreenshotKey: `${proofPackId}/pre.png`,
    postActionScreenshotKey: `${proofPackId}/post.png`,
    domSnapshotBeforeKey: `${proofPackId}/before.html`,
    domSnapshotAfterKey: `${proofPackId}/after.html`,
    confirmationText: null,
    confirmationUrl: null,
    finalStatus: "submit_boundary_reached",
    errorCode: null,
    auditEventId: null
  };
}
