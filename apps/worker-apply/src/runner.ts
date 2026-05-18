import {
  DeterministicFlowRunner,
  hhDryRunFlow,
  SelectorRegistry,
  type BrowserPageSnapshot,
  type FlowFingerprint,
  type FlowRunResult
} from "@job-search/automation";
import type { RuntimeConfig } from "@job-search/config";
import {
  evaluateApplicationRateLimits,
  executeQueueTask,
  queuePolicies,
  QueueWorkerError,
  type ApplicationRecord,
  type InMemoryDatabase,
  type QueueAdapter,
  type TaskRunStore
} from "@job-search/db";
import {
  CoverLetterEngine,
  PolicyEngine,
  ResumeRouter,
  SubmitGuardSequence,
  makeApplicationDraftContentHash,
  stableHash,
  type ApplicationDraft,
  type PolicyOutput,
  type ProofPack
} from "@job-search/domain";
import { pageFingerprints, selectorPacks, type ProviderRegistry } from "@job-search/providers";

export function runApplyWorker(input: { db?: InMemoryDatabase; guardResults?: Record<string, boolean> } = {}): FlowRunResult {
  const selectorPack = selectorPacks.hh;

  if (!selectorPack) {
    throw new Error("hh selector pack missing");
  }

  const fingerprints = Object.fromEntries(
    (pageFingerprints.hh ?? []).map((fingerprint) => [
      fingerprint.id,
      {
        id: fingerprint.id,
        urlPattern: fingerprint.urlPattern,
        titlePattern: fingerprint.titlePattern,
        requiredDomAnchors: fingerprint.requiredDomAnchors,
        requiredTextAnchors: fingerprint.requiredTextAnchors,
        captchaIndicators: fingerprint.captchaIndicators
      } satisfies FlowFingerprint
    ])
  );

  const snapshots: Record<string, BrowserPageSnapshot> = {
    search_results: {
      url: "https://hh.example/search/vacancy?text=node",
      title: "Backend vacancy search",
      text: "Найден backend вакансии",
      domAnchors: ["[data-qa='vacancy-serp__vacancy-title']"]
    },
    job_details: {
      url: "https://hh.example/vacancy/1001",
      title: "Senior Node.js Backend Developer",
      text: "Откликнуться Senior Node.js Backend Developer",
      domAnchors: ["[data-qa='vacancy-response-link-top']"]
    },
    application_form: {
      url: "https://hh.example/vacancy/1001",
      title: "Отклик на вакансию",
      text: "Откликнуться cover letter",
      domAnchors: ["[data-qa='vacancy-response-popup']", "textarea[name='letter']", "[data-qa='vacancy-response-link-top']"]
    }
  };

  const result = new DeterministicFlowRunner().run({
    flow: hhDryRunFlow,
    fingerprints,
    selectorRegistry: new SelectorRegistry(selectorPack.selectors),
    snapshots,
    availableSelectorsByState: {
      search_results: ["[data-qa='vacancy-serp__vacancy-title']"],
      job_details: ["[data-qa='vacancy-response-link-top']"],
      application_form: ["textarea[name='letter']", "[data-qa='vacancy-response-link-top']"]
    },
    guardResults: {
      not_already_applied: true,
      vacancy_is_active: true,
      apply_button_exists: true,
      resume_available: true,
      cover_letter_valid: true,
      no_captcha: true,
      ...input.guardResults
    },
    stopBeforeActions: ["submit_application"]
  });
  if (result.errorCode && ["captcha_required", "provider_rate_limited", "provider_terms_block", "anti_automation_detected"].includes(result.errorCode)) {
    input.db?.markProviderNeedsReview({ providerId: "hh", errorCode: result.errorCode, entityId: result.flowRunId });
  }
  input.db?.recordProofPack({
    proofPack: result.proofPack,
    entityType: "provider_flow_run",
    entityId: result.flowRunId,
    actor: "worker-apply"
  });
  return result;
}

export interface ApprovedSubmitWorkerResult {
  applicationId: string;
  status: "submitted" | "blocked" | "failed";
  queueRuntime?: { taskRunId: string; status: string; errorCode: string | null };
  guard: ReturnType<SubmitGuardSequence["evaluate"]>;
  policy: PolicyOutput;
  providerResultStatus: "submitted" | "blocked" | "failed" | null;
}

export async function runApprovedSubmitWorker(input: {
  config: RuntimeConfig;
  db: InMemoryDatabase;
  registry: ProviderRegistry;
	  applicationId: string;
	  approvalRequestId?: string;
	  approvedDraftHash?: string | null;
	  releaseEvidenceSource?: string;
	  releaseEvidenceTtlHours?: number;
	  queue?: QueueAdapter;
	  taskRunStore?: TaskRunStore;
	}): Promise<ApprovedSubmitWorkerResult> {
	  if (input.queue && input.taskRunStore) {
	    const task = await input.queue.enqueue(
	      "auto_apply_queue",
	      { applicationId: input.applicationId, approvalRequestId: input.approvalRequestId, approvedDraftHash: input.approvedDraftHash ?? null },
	      { idempotencyKey: `approved_submit:${input.applicationId}:${input.approvalRequestId ?? "missing"}`, deduplicationKey: input.applicationId }
	    );
    const execution = await executeQueueTask({
      taskRunStore: input.taskRunStore,
      task,
      noRetryErrorCodes: [...queuePolicies.auto_apply_queue.noRetryErrorCodes, "application_missing", "job_missing", "provider_missing"],
      handler: async () => processApprovedSubmit(input)
    });
    if (execution.result) {
      return {
        ...execution.result,
        queueRuntime: {
          taskRunId: task.id,
          status: execution.status,
          errorCode: execution.errorCode
        }
      };
    }
    return {
      applicationId: input.applicationId,
      status: "failed",
      queueRuntime: {
        taskRunId: task.id,
        status: execution.status,
        errorCode: execution.errorCode
      },
      guard: {
        passed: false,
        checks: [{ name: "queue_execution", passed: false, reason: execution.errorCode ?? "queue execution failed" }]
      },
      policy: denyPolicy("send_application", execution.errorCode ?? "queue execution failed"),
      providerResultStatus: null
    };
  }
  return processApprovedSubmit(input);
}

async function processApprovedSubmit(input: {
  config: RuntimeConfig;
  db: InMemoryDatabase;
	  registry: ProviderRegistry;
	  applicationId: string;
	  approvalRequestId?: string;
	  approvedDraftHash?: string | null;
	  releaseEvidenceSource?: string;
	  releaseEvidenceTtlHours?: number;
	}): Promise<ApprovedSubmitWorkerResult> {
  const application = input.db.applications.get(input.applicationId);
  if (!application) {
    throw new QueueWorkerError("application_missing", `Application not found: ${input.applicationId}`);
  }
	  const job = input.db.jobs.get(application.jobId);
	  if (!job) {
	    input.db.setApplicationStatus({ id: application.id, status: "apply_failed" });
	    throw new QueueWorkerError("job_missing", `Job not found: ${application.jobId}`);
	  }
  let provider;
  try {
    provider = input.registry.get(application.providerId);
	  } catch (error) {
	    input.db.setApplicationStatus({ id: application.id, status: "apply_failed" });
	    throw new QueueWorkerError("provider_missing", error instanceof Error ? error.message : String(error));
	  }
  const approvalValidation = validateApprovedSubmitPayload({
    db: input.db,
    application,
    approvalRequestId: input.approvalRequestId,
    approvedDraftHash: input.approvedDraftHash ?? null
  });
  if (!approvalValidation.valid) {
    const policy = denyPolicy("send_application", approvalValidation.reason);
    const guard = {
      passed: false,
      checks: [{ name: "approval_request_valid", passed: false, reason: approvalValidation.reason }]
    };
    input.db.recordPolicyCheck({ entityType: "application", entityId: application.id, result: policy });
    input.db.setApplicationStatus({ id: application.id, status: "manual_review_required" });
    input.db.createManualReview({
      userId: input.db.candidateProfile.userId,
      entityType: "application",
      entityId: application.id,
      reasonCode: "approved_submit_payload_invalid",
      severity: "high",
      recommendedAction: approvalValidation.reason
    });
    return { applicationId: application.id, status: "blocked", guard, policy, providerResultStatus: null };
  }
	  const health = await provider.healthcheck({ now: new Date(), environment: input.config.app.environment });
  input.db.updateProviderHealth(health);
  const score = input.db.jobScores.get(job.id);
  const dedupDecision = input.db.dedupDecisions.get(job.id);
  const rateLimit = evaluateApplicationRateLimits({
    profile: input.db.candidateProfile,
    applications: input.db.applications.values(),
    jobs: input.db.jobs.values(),
    job,
    providerId: provider.providerId,
    excludeApplicationId: application.id
  });
  const submitProof = evaluateSubmitProof({ application, proofPack: application.proofPackId ? input.db.proofPacks.get(application.proofPackId) : undefined });
  const policy = score && dedupDecision
    ? new PolicyEngine().check({
        action: "send_application",
        mode: input.db.systemMode,
        providerStatus: health.status,
        candidateProfile: input.db.candidateProfile,
        score,
        dedupDecision,
        idempotencyKey: application.idempotencyKey,
        proofReady: submitProof.ready,
        validationPassed: application.status === "application_prepared" || application.status === "apply_queued",
        irreversibleActionsEnabled: input.config.app.irreversibleActionsEnabled,
        rateLimitAvailable: rateLimit.allowed
      })
    : denyPolicy("send_application", "Missing score or dedup decision");
  const latestCanaryPassed = hasFreshPassedCanary(input.db, provider.providerId);
  const guard = new SubmitGuardSequence().evaluate({
    policy,
    dryRunPassed: submitProof.ready,
    dryRunState: submitProof.dryRunState,
    proofReady: submitProof.ready,
    idempotencyKey: application.idempotencyKey,
    recentCanaryPassed: latestCanaryPassed,
    providerStatus: health.status,
    rateLimitAvailable: rateLimit.allowed
  });
	  input.db.recordPolicyCheck({ entityType: "application", entityId: application.id, result: policy });
	  if (!guard.passed) {
	    input.db.setApplicationStatus({ id: application.id, status: policy.decision === "deny" ? "apply_blocked_by_policy" : "manual_review_required" });
    input.db.createManualReview({
      userId: input.db.candidateProfile.userId,
      entityType: "application",
      entityId: application.id,
      reasonCode: "submit_guard_failed",
      severity: "high",
      recommendedAction: [
        ...guard.checks.filter((check) => !check.passed).map((check) => check.reason ?? check.name),
        ...rateLimit.reasons,
        ...submitProof.reasons
      ].join("; ")
    });
    return { applicationId: application.id, status: "blocked", guard, policy, providerResultStatus: null };
  }

  const approvedDraft = buildApprovedApplicationDraft({
    application,
    job,
    db: input.db
  });
  if (!approvedDraft.valid) {
    const draftGuard = {
      passed: false,
      checks: [...guard.checks, { name: "approved_draft_payload", passed: false, reason: approvedDraft.reason }]
    };
    input.db.setApplicationStatus({ id: application.id, status: "manual_review_required" });
    input.db.createManualReview({
      userId: input.db.candidateProfile.userId,
      entityType: "application",
      entityId: application.id,
      reasonCode: "approved_draft_payload_invalid",
      severity: "high",
      recommendedAction: approvedDraft.reason
    });
    return { applicationId: application.id, status: "blocked", guard: draftGuard, policy, providerResultStatus: null };
  }

	  const submittedAt = application.submittedAt ?? new Date().toISOString();
	  input.db.setApplicationStatus({ id: application.id, status: "applying", submittedAt });
	  const result = await provider.submitApplication(approvedDraft.draft);
  const proofPack = input.db.recordProofPack({
    proofPack: result.proofPack,
    entityType: "application",
    entityId: application.id,
    actor: "worker-apply-submit"
  });
	  application.proofPackId = proofPack.proofPackId;
	  if (result.status === "submitted") {
	    input.db.setApplicationStatus({ id: application.id, status: "applied", submittedAt });
    recordProviderSubmitReleaseEvidence({
      db: input.db,
      application,
      proofId: proofPack.proofPackId,
      submittedAt,
      source: input.releaseEvidenceSource,
      ttlHours: input.releaseEvidenceTtlHours
    });
	  } else {
	    input.db.setApplicationStatus({ id: application.id, status: result.status === "blocked" ? "apply_blocked_by_provider" : "apply_failed" });
	  }
  for (const errorCode of result.errors) {
    if (["captcha_required", "provider_rate_limited", "provider_terms_block", "anti_automation_detected"].includes(errorCode)) {
      input.db.markProviderNeedsReview({ providerId: provider.providerId, errorCode, entityId: application.id });
    }
  }
  return { applicationId: application.id, status: result.status, guard, policy, providerResultStatus: result.status };
}

function recordProviderSubmitReleaseEvidence(input: {
  db: InMemoryDatabase;
  application: ApplicationRecord;
  proofId: string;
  submittedAt: string;
  source?: string | undefined;
  ttlHours?: number | undefined;
}): void {
  const source = input.source?.trim();
  if (!source) {
    return;
  }
  const ttlHours = input.ttlHours ?? 24;
  const submittedAtMs = Date.parse(input.submittedAt);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || Number.isNaN(submittedAtMs)) {
    return;
  }
  input.db.recordReleaseEvidence({
    evidenceId: `provider-submit-proof-${input.application.providerId}`,
    evidenceType: "provider_submit_proof_ready",
    providerId: input.application.providerId,
    status: "passed",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(submittedAtMs + ttlHours * 60 * 60 * 1000).toISOString(),
    source,
    metadata: {
      applicationId: input.application.id,
      proofId: input.proofId,
      action: "send_application",
      transport: "provider",
      idempotencyKeyHash: stableHash(input.application.idempotencyKey),
      draftHash: input.application.draftVariantKey,
      submitStatus: "submitted",
      submittedAt: input.submittedAt
    }
  });
}

function validateApprovedSubmitPayload(input: {
  db: InMemoryDatabase;
  application: ApplicationRecord;
  approvalRequestId?: string | undefined;
  approvedDraftHash: string | null;
}): { valid: true } | { valid: false; reason: string } {
  const currentDraftHash = input.application.draftVariantKey;
  if (!currentDraftHash) {
    return { valid: false, reason: "application_draft_hash_missing" };
  }
  if (!input.approvalRequestId || !input.approvedDraftHash) {
    return { valid: false, reason: "approval_payload_missing" };
  }
  if (input.approvedDraftHash !== currentDraftHash) {
    return { valid: false, reason: "approval_payload_draft_hash_mismatch" };
  }
  const approvalRequest = input.db.approvalRequests.get(input.approvalRequestId);
  if (!approvalRequest) {
    return { valid: false, reason: "approval_request_missing" };
  }
  if (approvalRequest.entityType !== "application" || approvalRequest.entityId !== input.application.id || approvalRequest.requestedAction !== "send_application") {
    return { valid: false, reason: "approval_request_entity_mismatch" };
  }
  if (approvalRequest.status !== "approved") {
    return { valid: false, reason: `approval_status_${approvalRequest.status}` };
  }
  if (new Date(approvalRequest.expiresAt).getTime() <= Date.now()) {
    return { valid: false, reason: "approval_expired" };
  }
  if (approvalRequest.draftHash !== currentDraftHash) {
    return { valid: false, reason: "approval_request_draft_hash_mismatch" };
  }
  return { valid: true };
}

function buildApprovedApplicationDraft(input: {
  application: ApplicationRecord;
  job: Parameters<CoverLetterEngine["generate"]>[0];
  db: InMemoryDatabase;
}): { valid: true; draft: ApplicationDraft } | { valid: false; reason: string } {
  const selectedRoute = new ResumeRouter().select(input.job, input.db.candidateProfile);
  const resumeId = input.application.resumeId ?? selectedRoute.resumeId;
  if (!resumeId) {
    return { valid: false, reason: "approved_draft_resume_missing" };
  }
  const route = {
    resumeId,
    confidence: selectedRoute.resumeId === resumeId ? selectedRoute.confidence : 1,
    rationale: selectedRoute.resumeId === resumeId ? selectedRoute.rationale : ["Resume id restored from approved application"]
  };
  const coverLetter = new CoverLetterEngine().generate(input.job, input.db.candidateProfile, route);
  if (coverLetter.validationStatus !== "passed") {
    return { valid: false, reason: `approved_draft_cover_letter_${coverLetter.validationStatus}` };
  }
  const coverLetterId = input.application.coverLetterId ?? `cover_${coverLetter.jobId}_${coverLetter.resumeId}`;
  const draftHash = makeApplicationDraftContentHash({
    jobId: input.application.jobId,
    providerId: input.application.providerId,
    externalJobId: input.application.externalJobId,
    candidateProfileId: input.application.candidateProfileId ?? input.db.candidateProfile.id,
    resumeId,
    coverLetterId,
    coverLetterText: coverLetter.text,
    idempotencyKey: input.application.idempotencyKey
  });
  if (input.application.draftVariantKey && draftHash !== input.application.draftVariantKey) {
    return { valid: false, reason: "approved_draft_content_hash_mismatch" };
  }
  return {
    valid: true,
    draft: {
      draftId: input.application.draftVariantKey ?? draftHash,
      jobId: input.application.jobId,
      providerId: input.application.providerId,
      externalJobId: input.application.externalJobId,
      candidateProfileId: input.application.candidateProfileId ?? input.db.candidateProfile.id,
      resumeId,
      coverLetterId,
      coverLetterText: coverLetter.text,
      status: "apply_queued",
      idempotencyKey: input.application.idempotencyKey,
      createdAt: input.application.createdAt
    }
  };
}

function hasFreshPassedCanary(db: InMemoryDatabase, providerId: string, now = new Date()): boolean {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  return [...db.canaryRuns.values()].some((run) => {
    const createdAt = Date.parse(run.createdAt);
    return run.providerId === providerId && run.status === "passed" && Number.isFinite(createdAt) && now.getTime() - createdAt <= maxAgeMs;
  });
}

function evaluateSubmitProof(input: {
  application: ApplicationRecord;
  proofPack?: ProofPack | undefined;
}): { ready: boolean; dryRunState: "not_run" | "failed" | "submit_boundary_reached"; reasons: string[] } {
  const proofPack = input.proofPack;
  if (!proofPack) {
    return { ready: false, dryRunState: "not_run", reasons: ["proof_pack_missing"] };
  }
  const reasons: string[] = [];
  const successfulDryRunStatuses = new Set(["dry_run_passed", "submit_boundary_reached", "succeeded"]);
  if (proofPack.provider !== input.application.providerId) {
    reasons.push("proof_provider_mismatch");
  }
  if (proofPack.entityId !== input.application.jobId) {
    reasons.push("proof_entity_mismatch");
  }
  if (!successfulDryRunStatuses.has(proofPack.finalStatus)) {
    reasons.push("proof_final_status_not_submit_boundary");
  }
  if (proofPack.errorCode) {
    reasons.push(`proof_error:${proofPack.errorCode}`);
  }
  if (!proofPack.completedAt) {
    reasons.push("proof_completion_missing");
  }
  if (!proofPack.preActionScreenshotKey || !proofPack.domSnapshotBeforeKey) {
    reasons.push("proof_artifact_missing");
  }
  return {
    ready: reasons.length === 0,
    dryRunState: reasons.length === 0 ? "submit_boundary_reached" : "failed",
    reasons
  };
}

function denyPolicy(action: PolicyOutput["action"], reason: string): PolicyOutput {
  return {
    decision: "deny",
    action,
    policyVersion: "submit-worker-v1",
    checks: [{ name: "submit_worker_precondition", result: "failed", severity: "hard_deny", reason }],
    requiresUserApproval: false,
    reasons: [reason]
  };
}
