import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  buildDedupKey,
  createAuditEvent,
  createDefaultCandidateProfile,
  createDefaultSearchProfile,
  type AuditEvent,
  type AppMode,
  type CandidateProfile,
  ConversationLinker,
  type DedupDecision,
  type DryRunResult,
  type InboundMessageDraft,
  type InterviewEvent,
  type MessageClassification,
  type NormalizedJob,
  type OutboundDispatchResult,
  type OutboundMessage,
  type PolicyOutput,
  type ProofPack,
  type ProviderHealth,
  type ReleaseEvidenceRecord,
  type ReplayReport,
  type ScoreResult,
  type SearchProfile
} from "@job-search/domain";
import { createLogger } from "@job-search/observability";
import { migrations } from "./migrations";
import { PostgresIdempotencyService, PostgresTaskRunStore } from "./queue";
export * from "./queue";
export * from "./rate-limits";

const { Pool } = pg;
const irreversibleApprovalActions = new Set(["send_application", "send_recruiter_reply", "confirm_interview_slot"]);

export { migrations };
export * from "./object-storage";
export * from "./secret-store";

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
  status: "open" | "approved" | "rejected" | "resolved" | "ignored" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApprovalRequest {
  id: string;
  userId: string;
  entityType: string;
  entityId: string;
  requestedAction: "send_application" | "send_recruiter_reply" | "confirm_interview_slot" | "provider_incident" | string;
  status: "pending" | "approved" | "rejected" | "expired" | "superseded";
  requestedAt: string;
  resolvedAt: string | null;
  expiresAt: string;
  policyDecisionId: string | null;
  draftHash: string | null;
  manualReviewId: string | null;
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
  submittedAt?: string | null;
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
  normalizedText: string;
  linkedJobExternalId: string | null;
  linkedApplicationId: string | null;
  linkConfidence: number;
  linkReason: string;
  ambiguousCandidateExternalIds: string[];
  classificationState: "pending" | "classified" | "manual_review" | "ignored";
  attachments: Array<{ type: string; name: string | null }>;
}

export interface MessageClassificationRecord {
  inboundMessageId: string;
  classification: MessageClassification;
  llmOk: boolean;
  modelVersion: string;
  promptVersion: string;
  ruleVersion: string;
  createdAt: string;
}

export interface OutboundMessageRecord {
  id: string;
  providerId: string;
  accountId: string;
  message: OutboundMessage;
  status: OutboundDispatchResult["status"];
  proof: OutboundDispatchResult["proof"];
  deliveryId: string | null;
  errors: string[];
  createdAt: string;
}

function shouldUpdateOutboundDispatch(current: OutboundDispatchResult["status"], next: OutboundDispatchResult["status"]): boolean {
  const rank: Record<OutboundDispatchResult["status"], number> = {
    blocked: 0,
    queued_for_review: 1,
    dry_run_recorded: 2,
    sent: 3
  };
  return rank[next] > rank[current] || (current === "queued_for_review" && next === "blocked");
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
  searchProfileId: string;
  query: string;
  filters: Record<string, unknown>;
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

export type ReleaseEvidenceInput = Omit<ReleaseEvidenceRecord, "evidenceId" | "observedAt"> & {
  evidenceId?: string;
  observedAt?: string;
};

export class InMemoryDatabase {
  systemMode: AppMode = "review_first";
  readonly candidateProfile: CandidateProfile = createDefaultCandidateProfile();
  readonly searchProfile: SearchProfile = createDefaultSearchProfile();
  readonly jobs = new Map<string, NormalizedJob>();
  readonly jobScores = new Map<string, ScoreResult>();
  readonly dedupDecisions = new Map<string, DedupDecision>();
  readonly applications = new Map<string, ApplicationRecord>();
  readonly conversations = new Map<string, ConversationRecord>();
  readonly inboundMessages = new Map<string, InboundMessageRecord>();
  readonly messageClassifications = new Map<string, MessageClassificationRecord>();
  readonly outboundMessages = new Map<string, OutboundMessageRecord>();
  readonly interviewEvents = new Map<string, InterviewEvent>();
  readonly policyChecks = new Map<string, PolicyCheckRecord>();
  readonly proofPacks = new Map<string, ProofPack>();
  readonly searchRuns: SearchRunRecord[] = [];
  readonly objectArtifacts = new Map<string, ObjectArtifactRecord>();
  readonly canaryRuns = new Map<string, CanaryRunRecord>();
  readonly replayReports = new Map<string, ReplayReport>();
  readonly releaseEvidence = new Map<string, ReleaseEvidenceRecord>();
  readonly providerHealth = new Map<string, ProviderHealth>();
  readonly manualReviewItems = new Map<string, ManualReviewItem>();
  readonly approvalRequests = new Map<string, ApprovalRequest>();
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
      this.auditEvents.push(
        createAuditEvent({
          entityType: "application",
          entityId: existing.id,
          eventType: "application_duplicate_suppressed",
          actor: "application-orchestrator",
          payload: {
            providerId: input.providerId,
            jobId: input.jobId,
            dedupKey: input.dedupKey,
            existingStatus: existing.status
          }
        })
      );
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

  setApplicationStatus(input: { id: string; status: string; submittedAt?: string | null }): ApplicationRecord | null {
    const application = this.applications.get(input.id);
    if (!application) {
      return null;
    }
    application.status = input.status;
    if (input.submittedAt !== undefined) {
      application.submittedAt = input.submittedAt;
    }
    this.auditEvents.push(
      createAuditEvent({
        entityType: "application",
        entityId: application.id,
        eventType: "application_status_updated",
        actor: "application-runtime",
        payload: { status: input.status, submittedAt: input.submittedAt ?? null }
      })
    );
    return application;
  }

  createManualReview(input: Omit<ManualReviewItem, "id" | "createdAt" | "status" | "resolvedAt">): ManualReviewItem {
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
      resolvedAt: null,
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

  resolveManualReview(input: {
    id: string;
    resolution: "approved" | "rejected" | "deferred";
    actor: string;
    reason?: string | null;
  }): ManualReviewItem | null {
    const item = this.manualReviewItems.get(input.id);
    if (!item) {
      return null;
    }
    if (input.resolution === "approved") {
      item.status = "approved";
      item.resolvedAt = new Date().toISOString();
    } else if (input.resolution === "rejected") {
      item.status = "rejected";
      item.resolvedAt = new Date().toISOString();
    }
    this.auditEvents.push(
      createAuditEvent({
        entityType: "manual_review_item",
        entityId: item.id,
        eventType: `manual_review_${input.resolution}`,
        actor: input.actor,
        payload: {
          resolution: input.resolution,
          reason: input.reason ?? null,
          status: item.status
        }
      })
    );
    return item;
  }

  createApprovalRequest(input: Omit<ApprovalRequest, "id" | "requestedAt" | "resolvedAt" | "status">): ApprovalRequest {
    const existing = [...this.approvalRequests.values()].find(
      (request) =>
        request.userId === input.userId &&
        request.entityType === input.entityType &&
        request.entityId === input.entityId &&
        request.requestedAction === input.requestedAction &&
        request.draftHash === input.draftHash &&
        request.status === "pending"
    );
    if (existing) {
      return existing;
    }
    const request: ApprovalRequest = {
      id: randomUUID(),
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      status: "pending",
      ...input
    };
    this.approvalRequests.set(request.id, request);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "approval_request",
        entityId: request.id,
        eventType: "approval_request_created",
        actor: "manual-review",
        payload: { request }
      })
    );
    return request;
  }

  resolveApprovalRequest(input: {
    id: string;
    resolution: "approved" | "rejected";
    actor: string;
    draftHash?: string | null;
    now?: Date;
    reason?: string | null;
  }): ApprovalRequest | null {
    const request = this.approvalRequests.get(input.id);
    if (!request) {
      return null;
    }
	    const now = input.now ?? new Date();
    const draftHashRequired = input.resolution === "approved" && irreversibleApprovalActions.has(request.requestedAction);
    if (draftHashRequired && !request.draftHash) {
      this.auditEvents.push(
        createAuditEvent({
          entityType: "approval_request",
          entityId: request.id,
          eventType: "approval_request_draft_hash_missing",
          actor: input.actor,
          payload: { requestedAction: request.requestedAction }
        })
      );
      return null;
    }
    if (request.draftHash && request.draftHash !== input.draftHash) {
      this.auditEvents.push(
        createAuditEvent({
          entityType: "approval_request",
          entityId: request.id,
          eventType: "approval_request_draft_hash_mismatch",
          actor: input.actor,
          payload: { expectedHash: request.draftHash, receivedHash: input.draftHash ?? null }
        })
      );
      return null;
    }
    if (request.status === "approved" && new Date(request.expiresAt).getTime() <= now.getTime()) {
      request.status = "expired";
      request.resolvedAt = now.toISOString();
      this.auditEvents.push(
        createAuditEvent({
          entityType: "approval_request",
          entityId: request.id,
          eventType: "approval_request_expired",
          actor: input.actor,
          payload: { expiresAt: request.expiresAt, reason: input.reason ?? null, previousStatus: "approved" }
        })
      );
      return request;
    }
    if (request.status !== "pending") {
      return request;
    }
	    if (new Date(request.expiresAt).getTime() <= now.getTime()) {
      request.status = "expired";
      request.resolvedAt = now.toISOString();
      this.auditEvents.push(
        createAuditEvent({
          entityType: "approval_request",
          entityId: request.id,
          eventType: "approval_request_expired",
          actor: input.actor,
          payload: { expiresAt: request.expiresAt, reason: input.reason ?? null }
        })
      );
      return request;
    }
	    request.status = input.resolution;
    request.resolvedAt = now.toISOString();
    this.auditEvents.push(
      createAuditEvent({
        entityType: "approval_request",
        entityId: request.id,
        eventType: `approval_request_${input.resolution}`,
        actor: input.actor,
        payload: { requestedAction: request.requestedAction, reason: input.reason ?? null }
      })
    );
    return request;
  }

  expireApprovalRequests(now = new Date()): ApprovalRequest[] {
    const expired: ApprovalRequest[] = [];
    for (const request of this.approvalRequests.values()) {
      if (request.status === "pending" && new Date(request.expiresAt).getTime() <= now.getTime()) {
        request.status = "expired";
        request.resolvedAt = now.toISOString();
        expired.push(request);
        this.auditEvents.push(
          createAuditEvent({
            entityType: "approval_request",
            entityId: request.id,
            eventType: "approval_request_expired",
            actor: "system",
            payload: { expiresAt: request.expiresAt }
          })
        );
      }
    }
    return expired;
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
    if (input.entityType === "application") {
      const application = this.applications.get(input.entityId);
      if (application) {
        application.proofPackId = linkedProofPack.proofPackId;
      }
    }
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

    const link = new ConversationLinker().link({
      messageText: message.text,
      senderName: message.senderName,
      linkedJobExternalId: message.linkedJobExternalId,
      jobs: [...this.jobs.values()]
    });
    const linkedApplication = link.linkedJobExternalId
      ? [...this.applications.values()].find((application) => application.externalJobId === link.linkedJobExternalId || application.jobId === link.linkedJobExternalId)
      : null;
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
      normalizedText: message.text.toLowerCase().replace(/\s+/g, " ").trim(),
      linkedJobExternalId: link.linkedJobExternalId,
      linkedApplicationId: linkedApplication?.id ?? null,
      linkConfidence: link.confidence,
      linkReason: link.reason,
      ambiguousCandidateExternalIds: link.ambiguousCandidates,
      classificationState: link.reason.startsWith("ambiguous") ? "manual_review" : "pending",
      attachments: []
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
    modelVersion?: string;
    promptVersion?: string;
    ruleVersion?: string;
  }): MessageClassificationRecord {
    const record: MessageClassificationRecord = {
      inboundMessageId: input.inboundMessageId,
      classification: input.classification,
      llmOk: input.llmOk,
      modelVersion: input.modelVersion ?? "rule+mock-v1",
      promptVersion: input.promptVersion ?? "2026-05-18-v1",
      ruleVersion: input.ruleVersion ?? "rules-2026-05-18-v1",
      createdAt: new Date().toISOString()
    };
    this.messageClassifications.set(input.inboundMessageId, record);
    const message = [...this.inboundMessages.values()].find((item) => item.id === input.inboundMessageId);
    if (message) {
      message.classificationState =
        input.classification.confidence <= 0.5 || input.classification.category === "unknown" || input.classification.sensitiveDataRequested
          ? "manual_review"
          : "classified";
    }
    this.auditEvents.push(
      createAuditEvent({
        entityType: "inbound_message",
        entityId: input.inboundMessageId,
        eventType: "message_classified",
        actor: "worker-inbox",
        payload: {
          category: input.classification.category,
          confidence: input.classification.confidence,
          llmOk: input.llmOk,
          modelVersion: record.modelVersion,
          promptVersion: record.promptVersion,
          ruleVersion: record.ruleVersion
        }
      })
    );
    return record;
  }

  manualLinkInboundMessage(input: { inboundMessageId: string; linkedJobExternalId: string; actor: string; reason?: string | null }): InboundMessageRecord | null {
    const message = [...this.inboundMessages.values()].find((item) => item.id === input.inboundMessageId);
    if (!message) {
      return null;
    }
    message.linkedJobExternalId = input.linkedJobExternalId;
    message.linkedApplicationId =
      [...this.applications.values()].find((application) => application.externalJobId === input.linkedJobExternalId || application.jobId === input.linkedJobExternalId)?.id ?? null;
    message.linkConfidence = 1;
    message.linkReason = input.reason ?? "manual_link";
    message.ambiguousCandidateExternalIds = [];
    this.auditEvents.push(
      createAuditEvent({
        entityType: "inbound_message",
        entityId: message.id,
        eventType: "inbound_message_manually_linked",
        actor: input.actor,
        payload: { linkedJobExternalId: input.linkedJobExternalId, reason: input.reason ?? null }
      })
    );
    return message;
  }

  manualUnlinkInboundMessage(input: { inboundMessageId: string; actor: string; reason?: string | null }): InboundMessageRecord | null {
    const message = [...this.inboundMessages.values()].find((item) => item.id === input.inboundMessageId);
    if (!message) {
      return null;
    }
    message.linkedJobExternalId = null;
    message.linkedApplicationId = null;
    message.linkConfidence = 0;
    message.linkReason = input.reason ?? "manual_unlink";
    message.ambiguousCandidateExternalIds = [];
    this.auditEvents.push(
      createAuditEvent({
        entityType: "inbound_message",
        entityId: message.id,
        eventType: "inbound_message_manually_unlinked",
        actor: input.actor,
        payload: { reason: input.reason ?? null }
      })
    );
    return message;
  }

  recordOutboundDispatch(input: {
    providerId: string;
    accountId: string;
    message: OutboundMessage;
    result: OutboundDispatchResult;
    actor?: string;
  }): OutboundMessageRecord {
    const existing = [...this.outboundMessages.values()].find(
      (record) => record.message.idempotencyKey === input.message.idempotencyKey
    );
    if (existing) {
      if (existing.proof.textHash !== input.result.proof.textHash) {
        this.auditEvents.push(
          createAuditEvent({
            entityType: "outbound_message",
            entityId: existing.id,
            eventType: "outbound_dispatch_idempotency_text_hash_mismatch",
            actor: input.actor ?? "reply-dispatcher",
            policyVersion: null,
            payload: {
              expectedTextHash: existing.proof.textHash,
              receivedTextHash: input.result.proof.textHash
            }
          })
        );
        return existing;
      }
      if (shouldUpdateOutboundDispatch(existing.status, input.result.status)) {
        const previousStatus = existing.status;
        existing.status = input.result.status;
        existing.proof = input.result.proof;
        existing.deliveryId = input.result.deliveryId;
        existing.errors = input.result.errors;
        this.auditEvents.push(
          createAuditEvent({
            entityType: "outbound_message",
            entityId: existing.id,
            eventType: "outbound_dispatch_updated",
            actor: input.actor ?? "reply-dispatcher",
            policyVersion: null,
            payload: {
              providerId: existing.providerId,
              previousStatus,
              status: input.result.status,
              proofId: input.result.proof.proofId,
              errors: input.result.errors
            }
          })
        );
      }
      return existing;
    }
    const record: OutboundMessageRecord = {
      id: input.result.proof.outboundMessageId,
      providerId: input.providerId,
      accountId: input.accountId,
      message: input.message,
      status: input.result.status,
      proof: input.result.proof,
      deliveryId: input.result.deliveryId,
      errors: input.result.errors,
      createdAt: new Date().toISOString()
    };
    this.outboundMessages.set(record.id, record);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "outbound_message",
        entityId: record.id,
        eventType: "outbound_dispatch_recorded",
        actor: input.actor ?? "reply-dispatcher",
        policyVersion: null,
        payload: {
          providerId: record.providerId,
          status: record.status,
          proofId: record.proof.proofId,
          textHash: record.proof.textHash,
          errors: record.errors
        }
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

  recordReleaseEvidence(input: ReleaseEvidenceInput): ReleaseEvidenceRecord {
    const record: ReleaseEvidenceRecord = {
      evidenceId: input.evidenceId ?? randomUUID(),
      evidenceType: input.evidenceType,
      providerId: input.providerId,
      status: input.status,
      observedAt: input.observedAt ?? new Date().toISOString(),
      expiresAt: input.expiresAt,
      source: input.source,
      metadata: input.metadata
    };
    this.releaseEvidence.set(record.evidenceId, record);
    this.auditEvents.push(
      createAuditEvent({
        entityType: "release_evidence",
        entityId: record.evidenceId,
        eventType: "release_evidence_recorded",
        actor: "api",
        payload: {
          evidenceType: record.evidenceType,
          providerId: record.providerId,
          status: record.status,
          source: record.source
        }
      })
    );
    return record;
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

  recordAuditEvent(event: AuditEvent): AuditEvent {
    this.auditEvents.push(event);
    return event;
  }

  setMode(input: { nextMode: AppMode; actor: string; reason?: string | null }): AppMode {
    const previousMode = this.systemMode;
    this.systemMode = input.nextMode;
    this.auditEvents.push(
      createAuditEvent({
        entityType: "system_mode",
        entityId: "global",
        eventType: "system_mode_changed",
        actor: input.actor,
        payload: {
          previousMode,
          nextMode: input.nextMode,
          reason: input.reason ?? null
        }
      })
    );
    return this.systemMode;
  }

  status(mode = this.systemMode) {
    return {
      mode,
      jobs: this.jobs.size,
      applications: this.applications.size,
      manualReviewItems: this.manualReviewItems.size,
      approvalRequests: this.approvalRequests.size,
      inboundMessages: this.inboundMessages.size,
      conversations: this.conversations.size,
      outboundMessages: this.outboundMessages.size,
      proofPacks: this.proofPacks.size,
      policyChecks: this.policyChecks.size,
      providerHealth: [...this.providerHealth.values()],
      releaseEvidence: this.releaseEvidence.size,
      latestAuditEvents: this.auditEvents.slice(-10)
    };
  }
}

export const localDb = new InMemoryDatabase();

/* v8 ignore start -- durable Postgres wiring is exercised by Docker-backed smoke/integration environments. */
export class PostgresRuntimeDatabase extends InMemoryDatabase {
  private readonly pendingWrites: Array<Promise<void>> = [];
  private readonly persistenceErrors: Error[] = [];
  private readonly persistedAuditEventIds = new Set<string>();
  private readonly inboundMessageWrites = new Map<string, Promise<unknown>>();
  readonly taskRunStore: PostgresTaskRunStore;
  readonly idempotencyService: PostgresIdempotencyService;

  constructor(private readonly pool: pg.Pool) {
    super();
    this.taskRunStore = new PostgresTaskRunStore(pool);
    this.idempotencyService = new PostgresIdempotencyService(pool);
  }

  static async connect(connectionString: string): Promise<PostgresRuntimeDatabase> {
    const pool = createPool(connectionString);
    await runMigrations(pool);
    const db = new PostgresRuntimeDatabase(pool);
    await db.seedDefaultState();
    await db.hydrate();
    return db;
  }

  async close(): Promise<void> {
    try {
      await this.flushPersistence();
    } finally {
      await this.pool.end();
    }
  }

  async flushPersistence(): Promise<void> {
    const pending = this.pendingWrites.splice(0);
    if (pending.length > 0) {
      await Promise.all(pending);
    }
    await this.taskRunStore.flushPersistence();
    await this.idempotencyService.flushPersistence();
    if (this.persistenceErrors.length > 0) {
      const [first] = this.persistenceErrors.splice(0);
      throw first ?? new Error("Postgres persistence failed");
    }
  }

  override upsertJob(job: NormalizedJob): void {
    const auditStart = this.auditEvents.length;
    super.upsertJob(job);
    this.persist(
      this.pool.query(
        `
INSERT INTO normalized_jobs (
  id, source_provider, external_id, canonical_url, title, company_name, company_external_id,
  location, work_format, compensation_min, compensation_max, compensation_currency,
  compensation_period, seniority, employment_type, description, requirements,
  responsibilities, nice_to_have, language, contact_method, publication_date,
  availability_status, already_applied, quality_signals,
  raw_payload_id, extraction_confidence, created_at, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17,
  $18, $19, $20, $21, $22,
  $23, $24, $25,
  $26, $27, $28, $29
)
ON CONFLICT (source_provider, external_id) DO UPDATE SET
  canonical_url = EXCLUDED.canonical_url,
  title = EXCLUDED.title,
  company_name = EXCLUDED.company_name,
  company_external_id = EXCLUDED.company_external_id,
  location = EXCLUDED.location,
  work_format = EXCLUDED.work_format,
  compensation_min = EXCLUDED.compensation_min,
  compensation_max = EXCLUDED.compensation_max,
  compensation_currency = EXCLUDED.compensation_currency,
  compensation_period = EXCLUDED.compensation_period,
  seniority = EXCLUDED.seniority,
  employment_type = EXCLUDED.employment_type,
  description = EXCLUDED.description,
  requirements = EXCLUDED.requirements,
  responsibilities = EXCLUDED.responsibilities,
  nice_to_have = EXCLUDED.nice_to_have,
  language = EXCLUDED.language,
  contact_method = EXCLUDED.contact_method,
  publication_date = EXCLUDED.publication_date,
  availability_status = EXCLUDED.availability_status,
  already_applied = EXCLUDED.already_applied,
  quality_signals = EXCLUDED.quality_signals,
  raw_payload_id = EXCLUDED.raw_payload_id,
  extraction_confidence = EXCLUDED.extraction_confidence,
  updated_at = EXCLUDED.updated_at
`,
        [
          job.id,
          job.sourceProvider,
          job.externalId,
          job.canonicalUrl,
          job.title,
          job.companyName,
          job.companyExternalId,
          job.location,
          job.workFormat,
          job.compensationMin,
          job.compensationMax,
          job.compensationCurrency,
          job.compensationPeriod,
          job.seniority,
          job.employmentType,
          job.description,
          JSON.stringify(job.requirements),
          JSON.stringify(job.responsibilities),
          JSON.stringify(job.niceToHave),
          job.language,
          job.contactMethod,
          job.publicationDate,
          job.availabilityStatus ?? "open",
          job.alreadyApplied ?? false,
          JSON.stringify(job.qualitySignals ?? []),
          job.rawPayloadId,
          job.extractionConfidence,
          job.createdAt,
          job.updatedAt
        ]
      )
    );
    this.persistNewAuditEvents(auditStart);
  }

  override saveScore(jobId: string, score: ScoreResult): void {
    const auditStart = this.auditEvents.length;
    super.saveScore(jobId, score);
    this.persist(
      this.pool.query(
        `
INSERT INTO job_scores (
  job_id, relevance_score, interview_likelihood_score, decision, score_strategy, score_profile_version, factor_weights, reasons, risks, hard_rejections
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (job_id) DO UPDATE SET
  relevance_score = EXCLUDED.relevance_score,
  interview_likelihood_score = EXCLUDED.interview_likelihood_score,
  decision = EXCLUDED.decision,
  score_strategy = EXCLUDED.score_strategy,
  score_profile_version = EXCLUDED.score_profile_version,
  factor_weights = EXCLUDED.factor_weights,
  reasons = EXCLUDED.reasons,
  risks = EXCLUDED.risks,
  hard_rejections = EXCLUDED.hard_rejections,
  created_at = now()
`,
        [
          jobId,
          score.score,
          score.interviewLikelihoodScore,
          score.decision,
          score.strategy ?? "balanced",
          score.scoreProfileVersion ?? "unknown",
          JSON.stringify(score.factorWeights ?? {}),
          JSON.stringify(score.reasons),
          JSON.stringify(score.risks),
          JSON.stringify(score.hardRejections)
        ]
      )
    );
    this.persistNewAuditEvents(auditStart);
  }

  override saveDedupDecision(job: NormalizedJob, decision: DedupDecision): void {
    const auditStart = this.auditEvents.length;
    super.saveDedupDecision(job, decision);
    const key = buildDedupKey(job);
    this.persist(
      this.pool.query(
        `
INSERT INTO dedup_jobs (
  id, job_id, provider_job_key, canonical_url_key, content_hash_key, company_role_key, decision
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (provider_job_key) DO UPDATE SET
  canonical_url_key = EXCLUDED.canonical_url_key,
  content_hash_key = EXCLUDED.content_hash_key,
  company_role_key = EXCLUDED.company_role_key,
  decision = EXCLUDED.decision,
  created_at = now()
`,
        [randomUUID(), job.id, key.providerJobKey, key.canonicalUrlKey, key.contentHashKey, key.companyRoleKey, decision]
      )
    );
    this.persistNewAuditEvents(auditStart);
  }

  override createApplication(input: Omit<ApplicationRecord, "id" | "createdAt">): ApplicationRecord {
    const existing = [...this.applications.values()].find((application) => application.idempotencyKey === input.idempotencyKey);
    const auditStart = this.auditEvents.length;
    const record = super.createApplication(input);
    if (existing) {
      this.persistNewAuditEvents(auditStart);
      return record;
    }
    this.persist(
      this.pool.query(
        `
	INSERT INTO applications (
	  id, user_id, job_id, provider_id, external_job_id, candidate_profile_id, resume_id,
	  cover_letter_id, status, idempotency_key, dedup_key, draft_variant_key, proof_pack_id,
	  policy_decision, policy_version, submitted_at, created_at, updated_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
	ON CONFLICT (idempotency_key) DO UPDATE SET
	  status = EXCLUDED.status,
	  draft_variant_key = COALESCE(EXCLUDED.draft_variant_key, applications.draft_variant_key),
	  proof_pack_id = COALESCE(EXCLUDED.proof_pack_id, applications.proof_pack_id),
	  policy_decision = COALESCE(EXCLUDED.policy_decision, applications.policy_decision),
	  policy_version = COALESCE(EXCLUDED.policy_version, applications.policy_version),
	  submitted_at = COALESCE(EXCLUDED.submitted_at, applications.submitted_at),
	  updated_at = now()
	`,
        [
          record.id,
          record.userId ?? this.candidateProfile.userId,
          record.jobId,
          record.providerId,
          record.externalJobId,
          record.candidateProfileId ?? this.candidateProfile.id,
          record.resumeId ?? this.candidateProfile.resumes[0]?.resumeId ?? "missing-resume",
          record.coverLetterId ?? "missing-cover-letter",
	          record.status,
	          record.idempotencyKey,
	          record.dedupKey,
	          record.draftVariantKey ?? null,
	          record.proofPackId ?? null,
	          record.policyDecision ?? null,
	          record.policyVersion ?? null,
	          record.submittedAt ?? null,
	          record.createdAt
	        ]
	      )
	    );
	    this.persistNewAuditEvents(auditStart);
	    return record;
	  }

  override setApplicationStatus(input: { id: string; status: string; submittedAt?: string | null }): ApplicationRecord | null {
    const auditStart = this.auditEvents.length;
    const application = super.setApplicationStatus(input);
    if (!application) {
      return null;
    }
    this.persist(
      this.pool.query(
        `
UPDATE applications
SET status = $2,
    submitted_at = COALESCE($3, submitted_at),
    updated_at = now()
WHERE id = $1
`,
        [input.id, input.status, input.submittedAt ?? null]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return application;
  }

  override createManualReview(input: Omit<ManualReviewItem, "id" | "createdAt" | "status" | "resolvedAt">): ManualReviewItem {
    const auditStart = this.auditEvents.length;
    const item = super.createManualReview(input);
    this.persist(
      this.pool.query(
        `
INSERT INTO manual_review_items (
  id, user_id, entity_type, entity_id, reason_code, severity, recommended_action, status, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (id) DO NOTHING
`,
        [
          item.id,
          item.userId,
          item.entityType,
          item.entityId,
          item.reasonCode,
          item.severity,
          item.recommendedAction,
          item.status,
          item.createdAt
        ]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return item;
  }

  override resolveManualReview(input: {
    id: string;
    resolution: "approved" | "rejected" | "deferred";
    actor: string;
    reason?: string | null;
  }): ManualReviewItem | null {
    const auditStart = this.auditEvents.length;
    const item = super.resolveManualReview(input);
    if (!item) {
      return null;
    }
    this.persist(
      this.pool.query(
        `
UPDATE manual_review_items
SET status = $2, resolved_at = $3
WHERE id = $1
`,
        [item.id, item.status, item.resolvedAt]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return item;
  }

  override createApprovalRequest(input: Omit<ApprovalRequest, "id" | "requestedAt" | "resolvedAt" | "status">): ApprovalRequest {
    const auditStart = this.auditEvents.length;
    const request = super.createApprovalRequest(input);
    this.persist(
      this.pool.query(
        `
INSERT INTO approval_requests (
  id, user_id, entity_type, entity_id, requested_action, status, requested_at, resolved_at,
  expires_at, policy_decision_id, draft_hash, manual_review_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (id) DO NOTHING
`,
        [
          request.id,
          request.userId,
          request.entityType,
          request.entityId,
          request.requestedAction,
          request.status,
          request.requestedAt,
          request.resolvedAt,
          request.expiresAt,
          request.policyDecisionId,
          request.draftHash,
          request.manualReviewId
        ]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return request;
  }

  override resolveApprovalRequest(input: {
    id: string;
    resolution: "approved" | "rejected";
    actor: string;
    draftHash?: string | null;
    now?: Date;
    reason?: string | null;
  }): ApprovalRequest | null {
    const auditStart = this.auditEvents.length;
    const request = super.resolveApprovalRequest(input);
    if (!request) {
      this.persistNewAuditEvents(auditStart);
      return null;
    }
    this.persist(
      this.pool.query("UPDATE approval_requests SET status = $2, resolved_at = $3 WHERE id = $1", [
        request.id,
        request.status,
        request.resolvedAt
      ])
    );
    this.persistNewAuditEvents(auditStart);
    return request;
  }

  override expireApprovalRequests(now = new Date()): ApprovalRequest[] {
    const auditStart = this.auditEvents.length;
    const expired = super.expireApprovalRequests(now);
    for (const request of expired) {
      this.persist(
        this.pool.query("UPDATE approval_requests SET status = $2, resolved_at = $3 WHERE id = $1", [
          request.id,
          request.status,
          request.resolvedAt
        ])
      );
    }
    this.persistNewAuditEvents(auditStart);
    return expired;
  }

  override updateProviderHealth(health: ProviderHealth): void {
    super.updateProviderHealth(health);
    this.persist(
      this.pool.query(
        `
INSERT INTO provider_health_checks (id, provider_id, status, checked_at, latency_ms, message)
VALUES ($1, $2, $3, $4, $5, $6)
`,
        [randomUUID(), health.providerId, health.status, health.checkedAt, health.latencyMs, health.message]
      )
    );
    this.persist(
      this.pool.query(
        `
INSERT INTO source_providers (provider_id, status, capabilities)
VALUES ($1, $2, '{}'::jsonb)
ON CONFLICT (provider_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
`,
        [health.providerId, health.status]
      )
    );
  }

  override recordProofPack(input: { proofPack: ProofPack; entityType: string; entityId: string; actor?: string }): ProofPack {
    const auditStart = this.auditEvents.length;
    const proofPack = super.recordProofPack(input);
    const applicationId = input.entityType === "application" && this.applications.has(input.entityId) ? input.entityId : null;
    this.persist(
      this.pool.query(
        `
INSERT INTO application_artifacts (id, application_id, proof_pack_id, proof_pack)
VALUES ($1, $2, $3, $4)
`,
        [randomUUID(), applicationId, proofPack.proofPackId, proofPack]
      )
    );
    if (applicationId) {
      this.persist(
        this.pool.query(
          `
UPDATE applications
SET proof_pack_id = $2,
    updated_at = now()
WHERE id = $1
`,
          [applicationId, proofPack.proofPackId]
        )
      );
    }
    this.persistNewAuditEvents(auditStart);
    return proofPack;
  }

  override recordPolicyCheck(input: { entityType: string; entityId: string; result: PolicyOutput }): PolicyCheckRecord {
    const auditStart = this.auditEvents.length;
    const record = super.recordPolicyCheck(input);
    this.persist(
      this.pool.query(
        `
INSERT INTO policy_checks (id, entity_type, entity_id, policy_version, result, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO NOTHING
`,
        [record.id, record.entityType, record.entityId, record.policyVersion, record.result, record.createdAt]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return record;
  }

  override recordSearchRun(input: Omit<SearchRunRecord, "id" | "createdAt">): SearchRunRecord {
    const record = super.recordSearchRun(input);
    this.persist(
      this.pool.query(
        `
INSERT INTO search_runs (
  id, provider_id, search_profile_id, query, filters, raw_count, normalized_count, rejected_count, shortlisted_count, stop_condition, errors, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
`,
        [
          record.id,
          record.providerId,
          record.searchProfileId,
          record.query,
          record.filters,
          record.rawCount,
          record.normalizedCount,
          record.rejectedCount,
          record.shortlistedCount,
          record.stopCondition,
          JSON.stringify(record.errors),
          record.createdAt
        ]
      )
    );
    return record;
  }

  override upsertInboundMessage(message: InboundMessageDraft): { record: InboundMessageRecord; created: boolean } {
    const auditStart = this.auditEvents.length;
    const result = super.upsertInboundMessage(message);
    if (result.created) {
      const conversation = this.conversations.get(`${message.providerId}:${message.conversationExternalId}`);
      const conversationWrite = conversation
        ? this.pool.query(
            `
INSERT INTO conversations (id, provider_id, external_conversation_id, job_id, company_name, status, created_at)
VALUES ($1, $2, $3, NULL, $4, $5, $6)
ON CONFLICT (provider_id, external_conversation_id) DO NOTHING
`,
            [
              conversation.id,
              conversation.providerId,
              conversation.externalConversationId,
              conversation.companyName,
              conversation.status,
              conversation.createdAt
            ]
          )
        : Promise.resolve();
      const inboundWrite = conversationWrite.then(() =>
          this.pool.query(
            `
INSERT INTO inbound_messages (
  id, conversation_id, provider_id, account_id, external_message_id, sender_name, text, received_at, raw
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (provider_id, account_id, external_message_id) DO NOTHING
`,
            [
              result.record.id,
              result.record.conversationId,
              result.record.providerId,
              result.record.accountId,
              result.record.externalMessageId,
              result.record.senderName,
              result.record.text,
              result.record.receivedAt,
              message
            ]
          )
        );
      this.inboundMessageWrites.set(result.record.id, inboundWrite);
      this.persist(inboundWrite);
    }
    this.persistNewAuditEvents(auditStart);
    return result;
  }

  override saveMessageClassification(input: {
    inboundMessageId: string;
    classification: MessageClassification;
    llmOk: boolean;
    modelVersion?: string;
    promptVersion?: string;
    ruleVersion?: string;
  }): MessageClassificationRecord {
    const auditStart = this.auditEvents.length;
    const record = super.saveMessageClassification(input);
    const inboundWrite = this.inboundMessageWrites.get(input.inboundMessageId) ?? Promise.resolve();
    this.persist(
      inboundWrite.then(() =>
        this.pool.query(
        `
INSERT INTO message_classifications (inbound_message_id, classification, created_at)
VALUES ($1, $2, $3)
ON CONFLICT (inbound_message_id) DO UPDATE SET
  classification = EXCLUDED.classification,
  created_at = EXCLUDED.created_at
`,
        [
          record.inboundMessageId,
          {
            ...record.classification,
            llmOk: record.llmOk,
            modelVersion: record.modelVersion,
            promptVersion: record.promptVersion,
            ruleVersion: record.ruleVersion
          },
          record.createdAt
        ]
        )
      )
    );
    this.persistNewAuditEvents(auditStart);
    return record;
  }

  override recordOutboundDispatch(input: {
    providerId: string;
    accountId: string;
    message: OutboundMessage;
    result: OutboundDispatchResult;
    actor?: string;
  }): OutboundMessageRecord {
    const auditStart = this.auditEvents.length;
    const record = super.recordOutboundDispatch(input);
    if (record.proof.proofId !== input.result.proof.proofId || record.status !== input.result.status) {
      this.persistNewAuditEvents(auditStart);
      return record;
    }
    this.persist(
      this.pool.query(
        `
INSERT INTO outbound_dispatch_proofs (
  proof_id, outbound_message_id, provider_id, account_id, idempotency_key, transport,
  status, text_hash, validation_hash, policy_decision, created_at, delivered_at, delivery_id, message, errors
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
ON CONFLICT (idempotency_key) DO UPDATE SET
  status = EXCLUDED.status,
  delivered_at = EXCLUDED.delivered_at,
  delivery_id = EXCLUDED.delivery_id,
  message = EXCLUDED.message,
  errors = EXCLUDED.errors
`,
        [
          input.result.proof.proofId,
          input.result.proof.outboundMessageId,
          input.result.proof.providerId,
          input.result.proof.accountId,
          input.result.proof.idempotencyKey,
          input.result.proof.transport,
          input.result.status,
          input.result.proof.textHash,
          input.result.proof.validationHash,
          input.result.proof.policyDecision,
          input.result.proof.createdAt,
          input.result.proof.deliveredAt,
          input.result.deliveryId,
          input.message,
          JSON.stringify(input.result.errors)
        ]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return record;
  }

  override recordInterviewEvent(event: InterviewEvent): InterviewEvent {
    const auditStart = this.auditEvents.length;
    const record = super.recordInterviewEvent(event);
    this.persist(
      this.pool.query(
        `
INSERT INTO interview_events (
  id, job_id, company_id, conversation_id, date_time, timezone, format, link, recruiter_name, status, summary_pack_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (id) DO UPDATE SET
  job_id = EXCLUDED.job_id,
  company_id = EXCLUDED.company_id,
  conversation_id = EXCLUDED.conversation_id,
  date_time = EXCLUDED.date_time,
  timezone = EXCLUDED.timezone,
  format = EXCLUDED.format,
  link = EXCLUDED.link,
  recruiter_name = EXCLUDED.recruiter_name,
  status = EXCLUDED.status,
  summary_pack_id = EXCLUDED.summary_pack_id
`,
        [
          record.interviewId,
          record.jobId,
          record.companyId,
          record.conversationId,
          record.dateTime,
          record.timezone,
          record.format,
          record.link,
          record.recruiterName,
          record.status,
          record.summaryPackId
        ]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return record;
  }

  override recordCanaryRun(input: Omit<CanaryRunRecord, "id" | "createdAt">): CanaryRunRecord {
    const record = super.recordCanaryRun(input);
    this.persist(
      this.pool.query(
        `
INSERT INTO provider_canary_runs (id, provider_id, canary_type, status, started_at, completed_at, checks, failures)
VALUES ($1, $2, 'metadata', $3, $4, $4, $5, $6)
`,
        [record.id, record.providerId, record.status, record.createdAt, JSON.stringify(record.checks), JSON.stringify(record.failures)]
      )
    );
    return record;
  }

  override recordReplayReport(report: ReplayReport): ReplayReport {
    const record = super.recordReplayReport(report);
    this.persist(
      this.pool.query(
        `
INSERT INTO automation_replay_reports (flow_run_id, report)
VALUES ($1, $2)
ON CONFLICT (flow_run_id) DO UPDATE SET report = EXCLUDED.report, created_at = now()
`,
        [record.flowRunId, record]
      )
    );
    return record;
  }

  override recordReleaseEvidence(input: ReleaseEvidenceInput): ReleaseEvidenceRecord {
    const auditStart = this.auditEvents.length;
    const record = super.recordReleaseEvidence(input);
    this.persist(
      this.pool.query(
        `
INSERT INTO release_evidence (
  evidence_id, evidence_type, provider_id, status, observed_at, expires_at, source, metadata
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (evidence_id) DO UPDATE SET
  evidence_type = EXCLUDED.evidence_type,
  provider_id = EXCLUDED.provider_id,
  status = EXCLUDED.status,
  observed_at = EXCLUDED.observed_at,
  expires_at = EXCLUDED.expires_at,
  source = EXCLUDED.source,
  metadata = EXCLUDED.metadata
`,
        [
          record.evidenceId,
          record.evidenceType,
          record.providerId,
          record.status,
          record.observedAt,
          record.expiresAt,
          record.source,
          record.metadata
        ]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return record;
  }

  override recordAuditEvent(event: AuditEvent): AuditEvent {
    const auditStart = this.auditEvents.length;
    const record = super.recordAuditEvent(event);
    this.persistNewAuditEvents(auditStart);
    return record;
  }

  override setMode(input: { nextMode: AppMode; actor: string; reason?: string | null }): AppMode {
    const auditStart = this.auditEvents.length;
    const mode = super.setMode(input);
    this.persist(
      this.pool.query(
        `
INSERT INTO system_config (key, value)
VALUES ('system_mode', $1)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
`,
        [{ mode, updatedBy: input.actor, reason: input.reason ?? null }]
      )
    );
    this.persistNewAuditEvents(auditStart);
    return mode;
  }

  private async seedDefaultState(): Promise<void> {
    await this.pool.query(
      `
INSERT INTO candidate_profiles (id, user_id, display_name, active, data)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  display_name = EXCLUDED.display_name,
  active = EXCLUDED.active,
  data = EXCLUDED.data,
  updated_at = now()
`,
      [
        this.candidateProfile.id,
        this.candidateProfile.userId,
        this.candidateProfile.displayName,
        this.candidateProfile.active,
        JSON.stringify(this.candidateProfile)
      ]
    );
    await this.pool.query(
      `
INSERT INTO search_profiles (id, candidate_profile_id, strategy, data)
VALUES ($1, $2, $3, $4)
ON CONFLICT (id) DO NOTHING
`,
      [this.searchProfile.searchProfileId, this.searchProfile.candidateProfileId, this.searchProfile.strategy, JSON.stringify(this.searchProfile)]
    );
    for (const resume of this.candidateProfile.resumes) {
      await this.pool.query(
        `
INSERT INTO resumes (
  id, candidate_profile_id, filename, language, object_storage_key, checksum, active, data
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO UPDATE SET
  filename = EXCLUDED.filename,
  language = EXCLUDED.language,
  object_storage_key = EXCLUDED.object_storage_key,
  checksum = EXCLUDED.checksum,
  active = EXCLUDED.active,
  data = EXCLUDED.data
`,
        [
          resume.resumeId,
          this.candidateProfile.id,
          resume.filename,
          resume.language,
          resume.objectStorageKey,
          resume.checksum,
          resume.active,
          JSON.stringify(resume)
        ]
      );
    }
    for (const [factKey, fact] of Object.entries(this.candidateProfile.facts)) {
      await this.pool.query(
        `
INSERT INTO fact_registry (candidate_profile_id, fact_key, disclosure, categories, value)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (candidate_profile_id, fact_key) DO UPDATE SET
  disclosure = EXCLUDED.disclosure,
  categories = EXCLUDED.categories,
  value = EXCLUDED.value
`,
        [this.candidateProfile.id, factKey, fact.disclosure, fact.categories, JSON.stringify(fact.value)]
      );
    }
  }

  private async hydrate(): Promise<void> {
    await this.taskRunStore.hydrate();
    await this.idempotencyService.hydrate();

    const profile = await this.pool.query<{ data: CandidateProfile }>(
      "SELECT data FROM candidate_profiles WHERE active = true ORDER BY updated_at DESC LIMIT 1"
    );
    if (profile.rows[0]?.data) {
      Object.assign(this.candidateProfile, profile.rows[0].data);
    }

    const searchProfile = await this.pool.query<{ data: SearchProfile }>(
      "SELECT data FROM search_profiles WHERE candidate_profile_id = $1 ORDER BY created_at DESC LIMIT 1",
      [this.candidateProfile.id]
    );
    if (searchProfile.rows[0]?.data) {
      Object.assign(this.searchProfile, searchProfile.rows[0].data);
    }

    const mode = await this.pool.query<{ value: { mode?: AppMode } }>("SELECT value FROM system_config WHERE key = 'system_mode'");
    if (mode.rows[0]?.value.mode) {
      this.systemMode = mode.rows[0].value.mode;
    }

    const jobs = await this.pool.query<{
      id: string;
      source_provider: string;
      external_id: string;
      canonical_url: string | null;
      title: string;
      company_name: string | null;
      company_external_id: string | null;
      location: string | null;
      work_format: NormalizedJob["workFormat"];
      compensation_min: number | null;
      compensation_max: number | null;
      compensation_currency: string | null;
      compensation_period: NormalizedJob["compensationPeriod"];
      seniority: string | null;
      employment_type: string | null;
      description: string;
      requirements: string[];
      responsibilities: string[];
      nice_to_have: string[];
      language: string;
      contact_method: string | null;
      publication_date: string | null;
      availability_status: "open" | "closed" | "unknown" | null;
      already_applied: boolean | null;
      quality_signals: string[] | null;
      raw_payload_id: string;
      extraction_confidence: number;
      created_at: Date;
      updated_at: Date;
    }>("SELECT * FROM normalized_jobs ORDER BY created_at");
    this.jobs.clear();
    for (const row of jobs.rows) {
      this.jobs.set(row.id, {
        id: row.id,
        sourceProvider: row.source_provider,
        externalId: row.external_id,
        canonicalUrl: row.canonical_url,
        title: row.title,
        companyName: row.company_name,
        companyExternalId: row.company_external_id,
        location: row.location,
        workFormat: row.work_format,
        compensationMin: row.compensation_min,
        compensationMax: row.compensation_max,
        compensationCurrency: row.compensation_currency,
        compensationPeriod: row.compensation_period,
        seniority: row.seniority,
        employmentType: row.employment_type,
        description: row.description,
        requirements: row.requirements,
        responsibilities: row.responsibilities,
        niceToHave: row.nice_to_have,
        language: row.language,
        contactMethod: row.contact_method,
        publicationDate: row.publication_date,
        availabilityStatus: row.availability_status ?? "open",
        alreadyApplied: row.already_applied ?? false,
        qualitySignals: row.quality_signals ?? [],
        rawPayloadId: row.raw_payload_id,
        extractionConfidence: row.extraction_confidence,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      });
    }

    const scores = await this.pool.query<{
      job_id: string;
      relevance_score: number;
      interview_likelihood_score: number;
      decision: ScoreResult["decision"];
      score_strategy: ScoreResult["strategy"] | null;
      score_profile_version: string | null;
      factor_weights: Record<string, number> | null;
      reasons: string[];
      risks: string[];
      hard_rejections: string[];
    }>("SELECT * FROM job_scores");
    this.jobScores.clear();
    for (const row of scores.rows) {
      this.jobScores.set(row.job_id, {
        score: row.relevance_score,
        interviewLikelihoodScore: row.interview_likelihood_score,
        decision: row.decision,
        ...(row.score_strategy ? { strategy: row.score_strategy } : {}),
        ...(row.score_profile_version ? { scoreProfileVersion: row.score_profile_version } : {}),
        ...(row.factor_weights ? { factorWeights: row.factor_weights } : {}),
        reasons: row.reasons,
        risks: row.risks,
        hardRejections: row.hard_rejections
      });
    }

    const dedupRows = await this.pool.query<{
      job_id: string;
      decision: DedupDecision;
    }>("SELECT job_id, decision FROM dedup_jobs ORDER BY created_at");
    this.dedupDecisions.clear();
    for (const row of dedupRows.rows) {
      this.dedupDecisions.set(row.job_id, row.decision);
    }

    const searchRuns = await this.pool.query<{
      id: string;
      provider_id: string;
      search_profile_id: string;
      query: string;
      filters: Record<string, unknown>;
      raw_count: number;
      normalized_count: number;
      rejected_count: number;
      shortlisted_count: number;
      stop_condition: string;
      errors: string[];
      created_at: Date;
    }>("SELECT * FROM search_runs ORDER BY created_at");
    this.searchRuns.splice(
      0,
      this.searchRuns.length,
      ...searchRuns.rows.map((row) => ({
        id: row.id,
        providerId: row.provider_id,
        searchProfileId: row.search_profile_id,
        query: row.query,
        filters: row.filters,
        rawCount: row.raw_count,
        normalizedCount: row.normalized_count,
        rejectedCount: row.rejected_count,
        shortlistedCount: row.shortlisted_count,
        stopCondition: row.stop_condition,
        errors: row.errors,
        createdAt: row.created_at.toISOString()
      }))
    );

    const policyChecks = await this.pool.query<{
      id: string;
      entity_type: string;
      entity_id: string;
      policy_version: string;
      result: PolicyOutput;
      created_at: Date;
    }>("SELECT * FROM policy_checks ORDER BY created_at");
    this.policyChecks.clear();
    for (const row of policyChecks.rows) {
      this.policyChecks.set(row.id, {
        id: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        policyVersion: row.policy_version,
        result: row.result,
        createdAt: row.created_at.toISOString()
      });
    }

    const providerHealth = await this.pool.query<{
      provider_id: string;
      status: ProviderHealth["status"];
      checked_at: Date;
      latency_ms: number;
      message: string;
    }>("SELECT DISTINCT ON (provider_id) * FROM provider_health_checks ORDER BY provider_id, checked_at DESC");
    this.providerHealth.clear();
    for (const row of providerHealth.rows) {
      this.providerHealth.set(row.provider_id, {
        providerId: row.provider_id,
        status: row.status,
        checkedAt: row.checked_at.toISOString(),
        latencyMs: row.latency_ms,
        message: row.message
      });
    }

    const canaryRuns = await this.pool.query<{
      id: string;
      provider_id: string;
      status: string;
      checks: string[] | null;
      failures: string[] | null;
      started_at: Date;
      completed_at: Date | null;
    }>("SELECT id, provider_id, status, checks, failures, started_at, completed_at FROM provider_canary_runs ORDER BY started_at");
    this.canaryRuns.clear();
    for (const row of canaryRuns.rows) {
      this.canaryRuns.set(row.id, {
        id: row.id,
        providerId: row.provider_id,
        status: row.status,
        checks: row.checks ?? [],
        failures: row.failures ?? [],
        createdAt: (row.completed_at ?? row.started_at).toISOString()
      });
    }

    const replayReports = await this.pool.query<{
      flow_run_id: string;
      report: ReplayReport;
    }>("SELECT flow_run_id, report FROM automation_replay_reports ORDER BY created_at");
    this.replayReports.clear();
    for (const row of replayReports.rows) {
      this.replayReports.set(row.flow_run_id, row.report);
    }

    const proofPacks = await this.pool.query<{
      proof_pack_id: string;
      application_id: string | null;
      proof_pack: ProofPack;
      created_at: Date;
    }>("SELECT proof_pack_id, application_id, proof_pack, created_at FROM application_artifacts WHERE proof_pack_id IS NOT NULL AND proof_pack IS NOT NULL ORDER BY created_at");
    this.proofPacks.clear();
    const proofPackIdsByApplicationId = new Map<string, string>();
    for (const row of proofPacks.rows) {
      this.proofPacks.set(row.proof_pack_id, row.proof_pack);
      if (row.application_id) {
        proofPackIdsByApplicationId.set(row.application_id, row.proof_pack_id);
      }
      this.objectArtifacts.set(row.proof_pack.preActionScreenshotKey ?? row.proof_pack_id, {
        objectKey: row.proof_pack.preActionScreenshotKey ?? `proof/${row.proof_pack_id}/metadata.json`,
        artifactType: "proof_pack",
        entityId: row.proof_pack.entityId,
        bytes: 0,
        createdAt: row.created_at.toISOString()
      });
    }

    const applications = await this.pool.query<{
      id: string;
      user_id: string;
      job_id: string;
      provider_id: string;
      external_job_id: string;
      candidate_profile_id: string;
      resume_id: string;
      cover_letter_id: string;
      status: string;
      draft_variant_key: string | null;
      proof_pack_id: string | null;
      policy_decision: string | null;
      policy_version: string | null;
	      idempotency_key: string;
	      dedup_key: string;
	      submitted_at: Date | null;
	      created_at: Date;
	    }>("SELECT * FROM applications ORDER BY created_at");
    this.applications.clear();
    for (const row of applications.rows) {
      this.applications.set(row.id, {
        id: row.id,
        userId: row.user_id,
        jobId: row.job_id,
        providerId: row.provider_id,
        externalJobId: row.external_job_id,
        candidateProfileId: row.candidate_profile_id,
        resumeId: row.resume_id,
        coverLetterId: row.cover_letter_id,
        status: row.status,
        ...(row.draft_variant_key ? { draftVariantKey: row.draft_variant_key } : {}),
        idempotencyKey: row.idempotency_key,
	        dedupKey: row.dedup_key,
	        proofPackId: row.proof_pack_id ?? proofPackIdsByApplicationId.get(row.id) ?? null,
	        ...(row.policy_decision ? { policyDecision: row.policy_decision } : {}),
	        policyVersion: row.policy_version,
	        submittedAt: row.submitted_at?.toISOString() ?? null,
	        createdAt: row.created_at.toISOString()
	      });
    }

    const conversations = await this.pool.query<{
      id: string;
      provider_id: string;
      external_conversation_id: string;
      job_id: string | null;
      company_name: string | null;
      status: string;
      created_at: Date;
    }>("SELECT * FROM conversations ORDER BY created_at");
    this.conversations.clear();
    const conversationsById = new Map<string, ConversationRecord>();
    for (const row of conversations.rows) {
      const conversation: ConversationRecord = {
        id: row.id,
        providerId: row.provider_id,
        externalConversationId: row.external_conversation_id,
        jobId: row.job_id,
        companyName: row.company_name,
        status: row.status,
        createdAt: row.created_at.toISOString()
      };
      this.conversations.set(`${conversation.providerId}:${conversation.externalConversationId}`, conversation);
      conversationsById.set(conversation.id, conversation);
    }

    const inboundMessages = await this.pool.query<{
      id: string;
      conversation_id: string;
      provider_id: string;
      account_id: string;
      external_message_id: string;
      sender_name: string | null;
      text: string;
      received_at: Date;
      raw: InboundMessageDraft | null;
    }>("SELECT * FROM inbound_messages ORDER BY received_at");
    this.inboundMessages.clear();
    for (const row of inboundMessages.rows) {
      const conversation = conversationsById.get(row.conversation_id);
      const externalConversationId = conversation?.externalConversationId ?? row.raw?.conversationExternalId ?? row.conversation_id;
      const link = new ConversationLinker().link({
        messageText: row.text,
        senderName: row.sender_name,
        linkedJobExternalId: row.raw?.linkedJobExternalId ?? conversation?.jobId ?? null,
        jobs: [...this.jobs.values()]
      });
      const linkedApplication = link.linkedJobExternalId
        ? [...this.applications.values()].find((application) => application.externalJobId === link.linkedJobExternalId || application.jobId === link.linkedJobExternalId)
        : null;
      const record: InboundMessageRecord = {
        id: row.id,
        providerId: row.provider_id,
        accountId: row.account_id,
        externalMessageId: row.external_message_id,
        conversationId: row.conversation_id,
        conversationExternalId: externalConversationId,
        receivedAt: row.received_at.toISOString(),
        senderName: row.sender_name,
        text: row.text,
        normalizedText: row.text.toLowerCase().replace(/\s+/g, " ").trim(),
        linkedJobExternalId: link.linkedJobExternalId,
        linkedApplicationId: linkedApplication?.id ?? null,
        linkConfidence: link.confidence,
        linkReason: link.reason,
        ambiguousCandidateExternalIds: link.ambiguousCandidates,
        classificationState: link.reason.startsWith("ambiguous") ? "manual_review" : "pending",
        attachments: []
      };
      this.inboundMessages.set(`${record.providerId}:${record.accountId}:${record.externalMessageId}`, record);
    }

    const classifications = await this.pool.query<{
      inbound_message_id: string;
      classification: MessageClassification & {
        llmOk?: boolean;
        modelVersion?: string;
        promptVersion?: string;
        ruleVersion?: string;
      };
      created_at: Date;
    }>("SELECT * FROM message_classifications ORDER BY created_at");
    this.messageClassifications.clear();
    for (const row of classifications.rows) {
      const record: MessageClassificationRecord = {
        inboundMessageId: row.inbound_message_id,
        classification: row.classification,
        llmOk: row.classification.llmOk ?? true,
        modelVersion: row.classification.modelVersion ?? "hydrated",
        promptVersion: row.classification.promptVersion ?? "hydrated",
        ruleVersion: row.classification.ruleVersion ?? "hydrated",
        createdAt: row.created_at.toISOString()
      };
      this.messageClassifications.set(record.inboundMessageId, record);
      for (const message of this.inboundMessages.values()) {
        if (message.id === record.inboundMessageId) {
          message.classificationState =
            record.classification.confidence <= 0.5 || record.classification.category === "unknown" || record.classification.sensitiveDataRequested
              ? "manual_review"
              : "classified";
          break;
        }
      }
    }

    const manualReviews = await this.pool.query<{
      id: string;
      user_id: string;
      entity_type: string;
      entity_id: string;
      reason_code: string;
      severity: ManualReviewItem["severity"];
      recommended_action: string;
      status: ManualReviewItem["status"];
      created_at: Date;
      resolved_at: Date | null;
    }>("SELECT * FROM manual_review_items ORDER BY created_at");
    this.manualReviewItems.clear();
    for (const row of manualReviews.rows) {
      this.manualReviewItems.set(row.id, {
        id: row.id,
        userId: row.user_id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        reasonCode: row.reason_code,
        severity: row.severity,
        recommendedAction: row.recommended_action,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null
      });
    }

    const approvalRequests = await this.pool.query<{
      id: string;
      user_id: string;
      entity_type: string;
      entity_id: string;
      requested_action: string;
      status: ApprovalRequest["status"];
      requested_at: Date;
      resolved_at: Date | null;
      expires_at: Date;
      policy_decision_id: string | null;
      draft_hash: string | null;
      manual_review_id: string | null;
    }>("SELECT * FROM approval_requests ORDER BY requested_at");
    this.approvalRequests.clear();
    for (const row of approvalRequests.rows) {
      this.approvalRequests.set(row.id, {
        id: row.id,
        userId: row.user_id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        requestedAction: row.requested_action,
        status: row.status,
        requestedAt: row.requested_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        expiresAt: row.expires_at.toISOString(),
        policyDecisionId: row.policy_decision_id,
        draftHash: row.draft_hash,
        manualReviewId: row.manual_review_id
      });
    }

    const audits = await this.pool.query<{
      event_id: string;
      entity_type: string;
      entity_id: string;
      event_type: string;
      actor: string;
      policy_version: string | null;
      timestamp: Date;
      payload: Record<string, unknown>;
    }>("SELECT * FROM audit_logs ORDER BY timestamp");
    const auditEvents = audits.rows.map((row) => ({
      eventId: row.event_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      eventType: row.event_type,
      actor: row.actor,
      policyVersion: row.policy_version,
      timestamp: row.timestamp.toISOString(),
      payload: row.payload
    }));
    this.auditEvents.splice(0, this.auditEvents.length, ...auditEvents);
    for (const event of auditEvents) {
      this.persistedAuditEventIds.add(event.eventId);
    }

    const releaseEvidence = await this.pool.query<{
      evidence_id: string;
      evidence_type: ReleaseEvidenceRecord["evidenceType"];
      provider_id: string | null;
      status: ReleaseEvidenceRecord["status"];
      observed_at: Date;
      expires_at: Date | null;
      source: string;
      metadata: Record<string, unknown>;
    }>("SELECT * FROM release_evidence ORDER BY observed_at");
    this.releaseEvidence.clear();
    for (const row of releaseEvidence.rows) {
      this.releaseEvidence.set(row.evidence_id, {
        evidenceId: row.evidence_id,
        evidenceType: row.evidence_type,
        providerId: row.provider_id,
        status: row.status,
        observedAt: row.observed_at.toISOString(),
        expiresAt: row.expires_at?.toISOString() ?? null,
        source: row.source,
        metadata: row.metadata
      });
    }

    const interviewEvents = await this.pool.query<{
      id: string;
      job_id: string | null;
      company_id: string | null;
      conversation_id: string | null;
      date_time: Date;
      timezone: string;
      format: InterviewEvent["format"];
      link: string | null;
      recruiter_name: string | null;
      status: InterviewEvent["status"];
      summary_pack_id: string;
    }>("SELECT * FROM interview_events ORDER BY date_time");
    this.interviewEvents.clear();
    for (const row of interviewEvents.rows) {
      this.interviewEvents.set(row.id, {
        interviewId: row.id,
        jobId: row.job_id ?? "unknown",
        companyId: row.company_id ?? "unknown",
        conversationId: row.conversation_id ?? "unknown",
        dateTime: row.date_time.toISOString(),
        timezone: row.timezone,
        format: row.format,
        link: row.link,
        recruiterName: row.recruiter_name,
        status: row.status,
        summaryPackId: row.summary_pack_id
      });
    }

    const outbound = await this.pool.query<{
      outbound_message_id: string;
      provider_id: string;
      account_id: string;
      status: OutboundMessageRecord["status"];
      message: OutboundMessage | null;
      proof_id: string;
      idempotency_key: string;
      transport: OutboundDispatchResult["proof"]["transport"];
      text_hash: string;
      validation_hash: string;
      policy_decision: OutboundDispatchResult["proof"]["policyDecision"];
      created_at: Date;
      delivered_at: Date | null;
      delivery_id: string | null;
      errors: string[] | null;
    }>("SELECT * FROM outbound_dispatch_proofs ORDER BY created_at");
    this.outboundMessages.clear();
    for (const row of outbound.rows) {
      const message =
        row.message ??
        ({
          conversationId: "unknown",
          inboundMessageId: "unknown",
          category: "unknown",
          language: this.candidateProfile.languages.communicationDefault,
          text: "",
          factsUsed: [],
          idempotencyKey: row.idempotency_key
        } satisfies OutboundMessage);
      this.outboundMessages.set(row.outbound_message_id, {
        id: row.outbound_message_id,
        providerId: row.provider_id,
        accountId: row.account_id,
        message,
        status: row.status,
        proof: {
          proofId: row.proof_id,
          outboundMessageId: row.outbound_message_id,
          providerId: row.provider_id,
          accountId: row.account_id,
          conversationId: message.conversationId,
          inboundMessageId: message.inboundMessageId,
          idempotencyKey: row.idempotency_key,
          transport: row.transport,
          status: row.status === "dry_run_recorded" ? "proof_recorded" : row.status,
          textHash: row.text_hash,
          validationHash: row.validation_hash,
          policyDecision: row.policy_decision,
          createdAt: row.created_at.toISOString(),
          deliveredAt: row.delivered_at?.toISOString() ?? null
        },
        deliveryId: row.delivery_id,
        errors: row.errors ?? [],
        createdAt: row.created_at.toISOString()
      });
    }
  }

  private persist(result: Promise<unknown>): void {
    const tracked = result
      .then(() => undefined)
      .catch((error: unknown) => {
        this.persistenceErrors.push(error instanceof Error ? error : new Error(String(error)));
      });
    this.pendingWrites.push(tracked);
  }

  private persistNewAuditEvents(startIndex: number): void {
    for (const event of this.auditEvents.slice(startIndex)) {
      if (this.persistedAuditEventIds.has(event.eventId)) {
        continue;
      }
      this.persistedAuditEventIds.add(event.eventId);
      this.persist(
        this.pool.query(
          `
INSERT INTO audit_logs (
  event_id, entity_type, entity_id, event_type, actor, policy_version, timestamp, payload
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (event_id) DO NOTHING
`,
          [
            event.eventId,
            event.entityType,
            event.entityId,
            event.eventType,
            event.actor,
            event.policyVersion,
            event.timestamp,
            event.payload
          ]
        )
      );
    }
  }
}

export async function createRuntimeDatabase(input: {
  stateBackend: "memory" | "postgres";
  postgresUrl: string;
  memoryDb?: InMemoryDatabase;
}): Promise<InMemoryDatabase> {
  if (input.stateBackend === "postgres") {
    return PostgresRuntimeDatabase.connect(input.postgresUrl);
  }
  return input.memoryDb ?? localDb;
}
/* v8 ignore stop */
