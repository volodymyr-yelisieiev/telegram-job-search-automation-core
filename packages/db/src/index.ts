import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  buildDedupKey,
  createAuditEvent,
  createDefaultCandidateProfile,
  createDefaultSearchProfile,
  type AuditEvent,
  type CandidateProfile,
  type DedupDecision,
  type DryRunResult,
  type InboundMessageDraft,
  type InterviewEvent,
  type MessageClassification,
  type NormalizedJob,
  type PolicyOutput,
  type ProofPack,
  type ProviderHealth,
  type ReplayReport,
  type ScoreResult,
  type SearchProfile
} from "@job-search/domain";
import { createLogger } from "@job-search/observability";
import { migrations } from "./migrations";
export * from "./queue";

const { Pool } = pg;

export { migrations };
export * from "./object-storage";

export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString });
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const logger = createLogger("db-migrations");
  for (const migration of migrations) {
    const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [migration.id]).catch(() => ({
      rowCount: 0
    }));
    if (existing.rowCount && existing.rowCount > 0) {
      continue;
    }
    await pool.query("BEGIN");
    try {
      await pool.query(migration.sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [migration.id]);
      await pool.query("COMMIT");
      logger.info("migration_applied", { migrationId: migration.id });
    } catch (error) {
      await pool.query("ROLLBACK");
      logger.error("migration_failed", { migrationId: migration.id, error: String(error) });
      throw error;
    }
  }
}

export interface ManualReviewItem {
  id: string;
  userId: string;
  entityType: string;
  entityId: string;
  reasonCode: string;
  severity: "low" | "medium" | "high" | "critical";
  recommendedAction: string;
  status: "open" | "resolved" | "ignored";
  createdAt: string;
}

export interface ApplicationRecord {
  id: string;
  userId?: string;
  jobId: string;
  providerId: string;
  externalJobId: string;
  candidateProfileId?: string;
  resumeId?: string;
  coverLetterId?: string;
  status: string;
  idempotencyKey: string;
  dedupKey: string;
  draftVariantKey?: string;
  proofPackId?: string | null;
  policyDecision?: string;
  policyVersion?: string | null;
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  providerId: string;
  externalConversationId: string;
  status: string;
  companyName: string | null;
  jobId: string | null;
  createdAt: string;
}

export interface InboundMessageRecord {
  id: string;
  providerId: string;
  accountId: string;
  externalMessageId: string;
  conversationId: string;
  conversationExternalId: string;
  receivedAt: string;
  senderName: string | null;
  text: string;
  linkedJobExternalId: string | null;
}

export interface MessageClassificationRecord {
  inboundMessageId: string;
  classification: MessageClassification;
  llmOk: boolean;
  createdAt: string;
}

export interface PolicyCheckRecord {
  id: string;
  entityType: string;
  entityId: string;
  policyVersion: string;
  result: PolicyOutput;
  createdAt: string;
}

export interface SearchRunRecord {
  id: string;
  providerId: string;
  rawCount: number;
  normalizedCount: number;
  rejectedCount: number;
  shortlistedCount: number;
  stopCondition: string;
  errors: string[];
  createdAt: string;
}

export interface ObjectArtifactRecord {
  objectKey: string;
  artifactType: string;
  entityId: string;
  bytes: number;
  createdAt: string;
}

export interface CanaryRunRecord {
  id: string;
  providerId: string;
  status: string;
  checks: string[];
  failures: string[];
  createdAt: string;
}

export class InMemoryDatabase {
  readonly candidateProfile: CandidateProfile = createDefaultCandidateProfile();
  readonly searchProfile: SearchProfile = createDefaultSearchProfile();
  readonly jobs = new Map<string, NormalizedJob>();
  readonly jobScores = new Map<string, ScoreResult>();
  readonly dedupDecisions = new Map<string, DedupDecision>();
  readonly applications = new Map<string, ApplicationRecord>();
  readonly conversations = new Map<string, ConversationRecord>();
  readonly inboundMessages = new Map<string, InboundMessageRecord>();
  readonly messageClassifications = new Map<string, MessageClassificationRecord>();
  readonly interviewEvents = new Map<string, InterviewEvent>();
  readonly policyChecks = new Map<string, PolicyCheckRecord>();
  readonly proofPacks = new Map<string, ProofPack>();
  readonly searchRuns: SearchRunRecord[] = [];
  readonly objectArtifacts = new Map<string, ObjectArtifactRecord>();
  readonly canaryRuns = new Map<string, CanaryRunRecord>();
  readonly replayReports = new Map<string, ReplayReport>();
  readonly providerHealth = new Map<string, ProviderHealth>();
  readonly manualReviewItems = new Map<string, ManualReviewItem>();
  readonly auditEvents: AuditEvent[] = [];

  upsertJob(job: NormalizedJob): void {
    this.jobs.set(job.id, job);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "normalized_job",
        entityId: job.id,
        eventType: "job_normalized",
        actor: "worker-ingest",
        payload: {
          provider: job.sourceProvider,
          externalId: job.externalId
        }
      })
    );
  }

  saveScore(jobId: string, score: ScoreResult): void {
    this.jobScores.set(jobId, score);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "job_score",
        entityId: jobId,
        eventType: "job_scored",
        actor: "scoring-engine",
        payload: { score }
      })
    );
  }

  saveDedupDecision(job: NormalizedJob, decision: DedupDecision): void {
    this.dedupDecisions.set(job.id, decision);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "dedup_job",
        entityId: job.id,
        eventType: decision.status === "new" ? "dedup_new" : "duplicate_prevented",
        actor: "dedup-engine",
        payload: {
          decision,
          key: buildDedupKey(job)
        }
      })
    );
  }

  createApplication(input: Omit<ApplicationRecord, "id" | "createdAt">): ApplicationRecord {
    const existing = [...this.applications.values()].find((application) => application.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const record: ApplicationRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };
    this.applications.set(record.id, record);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "application",
        entityId: record.id,
        eventType: "application_record_created",
        actor: "application-orchestrator",
        payload: { record }
      })
    );
    return record;
  }

  createManualReview(input: Omit<ManualReviewItem, "id" | "createdAt" | "status">): ManualReviewItem {
    const existing = [...this.manualReviewItems.values()].find(
      (item) =>
        item.userId === input.userId &&
        item.entityType === input.entityType &&
        item.entityId === input.entityId &&
        item.reasonCode === input.reasonCode &&
        item.status === "open"
    );
    if (existing) {
      return existing;
    }
    const item: ManualReviewItem = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "open",
      ...input
    };
    this.manualReviewItems.set(item.id, item);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "manual_review_item",
        entityId: item.id,
        eventType: "manual_review_created",
        actor: "policy-engine",
        payload: { item }
      })
    );
    return item;
  }

  updateProviderHealth(health: ProviderHealth): void {
    this.providerHealth.set(health.providerId, health);
  }

  recordProofPack(input: { proofPack: ProofPack; entityType: string; entityId: string; actor?: string }): ProofPack {
    const event = createAuditEvent({
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: "proof_pack_recorded",
      actor: input.actor ?? "automation",
      payload: {
        proofPackId: input.proofPack.proofPackId,
        finalStatus: input.proofPack.finalStatus,
        errorCode: input.proofPack.errorCode
      }
    });
    const linkedProofPack = { ...input.proofPack, auditEventId: event.eventId };
    this.proofPacks.set(linkedProofPack.proofPackId, linkedProofPack);
    this.objectArtifacts.set(linkedProofPack.preActionScreenshotKey ?? linkedProofPack.proofPackId, {
      objectKey: linkedProofPack.preActionScreenshotKey ?? `proof/${linkedProofPack.proofPackId}/metadata.json`,
      artifactType: "proof_pack",
      entityId: input.entityId,
      bytes: 0,
      createdAt: new Date().toISOString()
    });
    this.auditEvents.push(event);
    return linkedProofPack;
  }

  recordPolicyCheck(input: { entityType: string; entityId: string; result: PolicyOutput }): PolicyCheckRecord {
    const record: PolicyCheckRecord = {
      id: randomUUID(),
      entityType: input.entityType,
      entityId: input.entityId,
      policyVersion: input.result.policyVersion,
      result: input.result,
      createdAt: new Date().toISOString()
    };
    this.policyChecks.set(record.id, record);
    this.auditEvents.push(
      createAuditEvent({
        entityType: input.entityType,
        entityId: input.entityId,
        eventType: "policy_check_recorded",
        actor: "policy-engine",
        policyVersion: input.result.policyVersion,
        payload: { decision: input.result.decision, reasons: input.result.reasons, checks: input.result.checks }
      })
    );
    return record;
  }

  recordSearchRun(input: Omit<SearchRunRecord, "id" | "createdAt">): SearchRunRecord {
    const record: SearchRunRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };
    this.searchRuns.push(record);
    return record;
  }

  upsertInboundMessage(message: InboundMessageDraft): { record: InboundMessageRecord; created: boolean } {
    const messageKey = `${message.providerId}:${message.accountId}:${message.externalMessageId}`;
    const existing = this.inboundMessages.get(messageKey);
    if (existing) {
      return { record: existing, created: false };
    }

    const conversationKey = `${message.providerId}:${message.conversationExternalId}`;
    let conversation = this.conversations.get(conversationKey);
    if (!conversation) {
      conversation = {
        id: randomUUID(),
        providerId: message.providerId,
        externalConversationId: message.conversationExternalId,
        status: "open",
        companyName: message.senderName,
        jobId: message.linkedJobExternalId,
        createdAt: new Date().toISOString()
      };
      this.conversations.set(conversationKey, conversation);
    }

    const record: InboundMessageRecord = {
      id: randomUUID(),
      providerId: message.providerId,
      accountId: message.accountId,
      externalMessageId: message.externalMessageId,
      conversationId: conversation.id,
      conversationExternalId: message.conversationExternalId,
      receivedAt: message.receivedAt,
      senderName: message.senderName,
      text: message.text,
      linkedJobExternalId: message.linkedJobExternalId
    };
    this.inboundMessages.set(messageKey, record);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "inbound_message",
        entityId: record.id,
        eventType: "inbound_message_recorded",
        actor: "worker-inbox",
        payload: {
          providerId: record.providerId,
          externalMessageId: record.externalMessageId,
          conversationExternalId: record.conversationExternalId
        }
      })
    );
    return { record, created: true };
  }

  saveMessageClassification(input: {
    inboundMessageId: string;
    classification: MessageClassification;
    llmOk: boolean;
  }): MessageClassificationRecord {
    const record: MessageClassificationRecord = {
      inboundMessageId: input.inboundMessageId,
      classification: input.classification,
      llmOk: input.llmOk,
      createdAt: new Date().toISOString()
    };
    this.messageClassifications.set(input.inboundMessageId, record);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "inbound_message",
        entityId: input.inboundMessageId,
        eventType: "message_classified",
        actor: "worker-inbox",
        payload: { category: input.classification.category, confidence: input.classification.confidence, llmOk: input.llmOk }
      })
    );
    return record;
  }

  recordInterviewEvent(event: InterviewEvent): InterviewEvent {
    this.interviewEvents.set(event.interviewId, event);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "interview_event",
        entityId: event.interviewId,
        eventType: "interview_event_created",
        actor: "interview-coordinator",
        payload: { status: event.status, dateTime: event.dateTime, timezone: event.timezone }
      })
    );
    return event;
  }

  recordCanaryRun(input: Omit<CanaryRunRecord, "id" | "createdAt">): CanaryRunRecord {
    const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.canaryRuns.set(record.id, record);
    return record;
  }

  recordReplayReport(report: ReplayReport): ReplayReport {
    this.replayReports.set(report.flowRunId, report);
    return report;
  }

  markProviderNeedsReview(input: { providerId: string; errorCode: string; entityId: string; message?: string }): void {
    const health: ProviderHealth = {
      providerId: input.providerId,
      status: "needs_review",
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      message: input.message ?? `Provider moved to safe mode after ${input.errorCode}`
    };
    this.updateProviderHealth(health);
    this.createManualReview({
      userId: this.candidateProfile.userId,
      entityType: "provider",
      entityId: input.providerId,
      reasonCode: input.errorCode,
      severity: "high",
      recommendedAction: `Review provider ${input.providerId} before enabling automation again`
    });
    this.auditEvents.push(
      createAuditEvent({
        entityType: "provider",
        entityId: input.providerId,
        eventType: "provider_safe_mode_enabled",
        actor: "automation",
        payload: { errorCode: input.errorCode, sourceEntityId: input.entityId }
      })
    );
  }

  recordDryRunProof(input: { result: DryRunResult; entityType: string; entityId: string; actor?: string }): ProofPack {
    return this.recordProofPack({
      proofPack: input.result.proofPack,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.actor ? { actor: input.actor } : {})
    });
  }

  status(mode = "review_first") {
    return {
      mode,
      jobs: this.jobs.size,
      applications: this.applications.size,
      manualReviewItems: this.manualReviewItems.size,
      inboundMessages: this.inboundMessages.size,
      conversations: this.conversations.size,
      proofPacks: this.proofPacks.size,
      policyChecks: this.policyChecks.size,
      providerHealth: [...this.providerHealth.values()],
      latestAuditEvents: this.auditEvents.slice(-10)
    };
  }
}

export const localDb = new InMemoryDatabase();
