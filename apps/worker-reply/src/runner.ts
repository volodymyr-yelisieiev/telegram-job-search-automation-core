import type { RuntimeConfig } from "@job-search/config";
import { evaluateReplyRateLimits, executeQueueTask, queuePolicies, type InMemoryDatabase, type QueueAdapter, type TaskRunStore } from "@job-search/db";
import { OutboundDispatchService, PolicyEngine, ReplyTemplateEngine, stableHash, ThreadContradictionChecker } from "@job-search/domain";

export async function runReplyWorker(input: {
  config: RuntimeConfig;
  db: InMemoryDatabase;
  queue?: QueueAdapter;
  taskRunStore?: TaskRunStore;
}): Promise<{ drafted: number; dispatched: number; manualReviewCreated: number; queueRuntime?: { taskRunId: string; status: string; errorCode: string | null } }> {
  if (input.queue && input.taskRunStore) {
    const task = await input.queue.enqueue(
      "reply_generation_queue",
      { conversationId: "all-ready-classifications" },
      { idempotencyKey: "reply_generation:all-ready-classifications", deduplicationKey: "all-ready-classifications" }
    );
    const execution = await executeQueueTask({
      taskRunStore: input.taskRunStore,
      task,
      noRetryErrorCodes: queuePolicies.reply_generation_queue.noRetryErrorCodes,
      handler: async () => processReplies(input)
    });
    return {
      ...(execution.result ?? { drafted: 0, dispatched: 0, manualReviewCreated: 0 }),
      queueRuntime: {
        taskRunId: task.id,
        status: execution.status,
        errorCode: execution.errorCode
      }
    };
  }
  return processReplies(input);
}

async function processReplies(input: {
  config: RuntimeConfig;
  db: InMemoryDatabase;
}): Promise<{ drafted: number; dispatched: number; manualReviewCreated: number }> {
  let drafted = 0;
  let dispatched = 0;
  let manualReviewCreated = 0;
  const templates = new ReplyTemplateEngine();
  const policyEngine = new PolicyEngine();
  const dispatcher = new OutboundDispatchService();
  const contradictionChecker = new ThreadContradictionChecker();

  for (const [inboundMessageId, record] of input.db.messageClassifications.entries()) {
    const inbound = [...input.db.inboundMessages.values()].find((message) => message.id === inboundMessageId);
    if (!inbound || !record.classification.requiresReply) {
      continue;
    }
    const draft = templates.draft({
      conversationId: inbound.conversationId,
      inboundMessageId,
      classification: record.classification,
      profile: input.db.candidateProfile
    });
    if (!draft.outboundMessage || !draft.validation.valid) {
      input.db.createManualReview({
        userId: input.db.candidateProfile.userId,
        entityType: "inbound_message",
        entityId: inboundMessageId,
        reasonCode: "reply_draft_validation_failed",
        severity: "medium",
        recommendedAction: "Review recruiter reply draft before dispatch"
      });
      manualReviewCreated += 1;
      continue;
    }
    const contradiction = contradictionChecker.check({
      draft: draft.outboundMessage,
      previousMessages: [...input.db.inboundMessages.values()]
        .filter((message) => message.conversationId === inbound.conversationId)
        .map((message) => ({ text: message.text }))
    });
    if (!contradiction.valid) {
      input.db.createManualReview({
        userId: input.db.candidateProfile.userId,
        entityType: "inbound_message",
        entityId: inboundMessageId,
        reasonCode: "reply_thread_context_conflict",
        severity: "high",
        recommendedAction: `Review contradiction flags before dispatch: ${contradiction.riskFlags.join(", ")}`
      });
      manualReviewCreated += 1;
      continue;
    }
    drafted += 1;
    const rateLimit = evaluateReplyRateLimits({
      profile: input.db.candidateProfile,
      conversations: input.db.conversations.values(),
      outboundMessages: input.db.outboundMessages.values(),
      conversationId: draft.outboundMessage.conversationId,
      excludeOutboundMessageId: `outbound_${stableHash(draft.outboundMessage.idempotencyKey)}`
    });
    const policy = policyEngine.check({
      action: "send_recruiter_reply",
      mode: input.db.systemMode,
      providerStatus: "stable",
      candidateProfile: input.db.candidateProfile,
      messageClassification: record.classification,
      outboundMessage: draft.outboundMessage,
      idempotencyKey: draft.outboundMessage.idempotencyKey,
      proofReady: true,
      validationPassed: draft.validation.valid,
      irreversibleActionsEnabled: input.config.app.irreversibleActionsEnabled,
      rateLimitAvailable: rateLimit.allowed
    });
    const result = dispatcher.dispatch({
      message: draft.outboundMessage,
      profile: input.db.candidateProfile,
      providerId: inbound.providerId,
      accountId: inbound.accountId,
	      policy,
	      approval: policy.requiresUserApproval ? "pending" : "approved",
	      liveSendEnabled: false,
	      irreversibleActionsEnabled: input.config.app.irreversibleActionsEnabled
	    });
    input.db.recordPolicyCheck({ entityType: "outbound_message", entityId: result.proof.outboundMessageId, result: policy });
    input.db.recordOutboundDispatch({ providerId: inbound.providerId, accountId: inbound.accountId, message: draft.outboundMessage, result, actor: "worker-reply" });
    dispatched += 1;
  }

  return { drafted, dispatched, manualReviewCreated };
}
