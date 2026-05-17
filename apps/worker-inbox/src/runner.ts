import type { RuntimeConfig } from "@job-search/config";
import type { InMemoryDatabase } from "@job-search/db";
import { ConversationEngine } from "@job-search/domain";
import { LlmGateway } from "@job-search/llm";
import type { ProviderRegistry } from "@job-search/providers";

export async function runInboxWorker(input: {
  config: RuntimeConfig;
  db: InMemoryDatabase;
  registry: ProviderRegistry;
  llm?: LlmGateway;
}): Promise<{ classified: number; manualReviewCreated: number }> {
  const llm = input.llm ?? new LlmGateway();
  const conversation = new ConversationEngine();
  let classified = 0;
  let manualReviewCreated = 0;

  for (const provider of input.registry.list()) {
    if (!provider.capabilities.inboxSync) {
      continue;
    }
    const messages = await provider.syncInbox("fixture-account");
    for (const message of messages) {
      const persisted = input.db.upsertInboundMessage(message);
      if (!persisted.created) {
        continue;
      }
      const classification = conversation.classify(message.text, input.config.app.timezone);
      const llmResult = await llm.classifyMessage(message.text, input.config.app.timezone);
      input.db.saveMessageClassification({
        inboundMessageId: persisted.record.id,
        classification,
        llmOk: llmResult.ok
      });
      if (classification.sensitiveDataRequested || !classification.allowedAutoReply || !llmResult.ok) {
        input.db.createManualReview({
          userId: input.db.candidateProfile.userId,
          entityType: "inbound_message",
          entityId: persisted.record.id,
          reasonCode: classification.sensitiveDataRequested ? "sensitive_data_requested" : "reply_requires_review",
          severity: classification.sensitiveDataRequested ? "high" : "medium",
          recommendedAction: "Review recruiter message before replying"
        });
        manualReviewCreated += 1;
      }
      classified += 1;
    }
  }

  return { classified, manualReviewCreated };
}
