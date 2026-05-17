import { Queue } from "bullmq";

export const queueNames = [
  "source_poll_queue",
  "telegram_channel_ingest_queue",
  "parsing_queue",
  "dedup_queue",
  "scoring_queue",
  "resume_selection_queue",
  "application_generation_queue",
  "auto_apply_queue",
  "inbox_sync_queue",
  "message_classification_queue",
  "reply_generation_queue",
  "reply_dispatch_queue",
  "interview_coordination_queue",
  "digest_queue",
  "canary_queue",
  "retry_queue",
  "dead_letter_queue"
] as const;

export type QueueName = (typeof queueNames)[number];

export interface QueueTask<T = unknown> {
  id: string;
  queueName: QueueName;
  payload: T;
  idempotencyKey: string;
  deduplicationKey: string;
  attempts: number;
  createdAt: string;
}

export interface QueueAdapter {
  enqueue<T>(queueName: QueueName, payload: T, metadata: { idempotencyKey: string; deduplicationKey: string }): Promise<QueueTask<T>>;
  depth(queueName: QueueName): Promise<number>;
}

export class InMemoryQueueAdapter implements QueueAdapter {
  private readonly tasks = new Map<QueueName, QueueTask[]>();

  async enqueue<T>(
    queueName: QueueName,
    payload: T,
    metadata: { idempotencyKey: string; deduplicationKey: string }
  ): Promise<QueueTask<T>> {
    const sanitizedPayload = sanitizeQueuePayload(payload);
    const tasks = this.tasks.get(queueName) ?? [];
    const existing = tasks.find((task) => task.idempotencyKey === metadata.idempotencyKey) as QueueTask<T> | undefined;
    if (existing) {
      return existing;
    }
    const task: QueueTask<T> = {
      id: `${queueName}:${metadata.idempotencyKey}`,
      queueName,
      payload: sanitizedPayload as T,
      idempotencyKey: metadata.idempotencyKey,
      deduplicationKey: metadata.deduplicationKey,
      attempts: 0,
      createdAt: new Date().toISOString()
    };
    tasks.push(task);
    this.tasks.set(queueName, tasks);
    return task;
  }

  async depth(queueName: QueueName): Promise<number> {
    return this.tasks.get(queueName)?.length ?? 0;
  }
}

/* v8 ignore start -- real Redis adapter is covered by smoke/integration runs, not unit coverage */
export class BullMqQueueAdapter implements QueueAdapter {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redisUrl: string) {}

  async enqueue<T>(
    queueName: QueueName,
    payload: T,
    metadata: { idempotencyKey: string; deduplicationKey: string }
  ): Promise<QueueTask<T>> {
    const queue = this.getQueue(queueName);
    const sanitizedPayload = sanitizeQueuePayload(payload);
    await queue.add(queueName, sanitizedPayload as object, {
      jobId: metadata.idempotencyKey,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 30_000
      },
      removeOnComplete: 1000,
      removeOnFail: false
    });
    return {
      id: `${queueName}:${metadata.idempotencyKey}`,
      queueName,
      payload: sanitizedPayload as T,
      idempotencyKey: metadata.idempotencyKey,
      deduplicationKey: metadata.deduplicationKey,
      attempts: 0,
      createdAt: new Date().toISOString()
    };
  }

  async depth(queueName: QueueName): Promise<number> {
    return this.getQueue(queueName).count();
  }

  private getQueue(queueName: QueueName): Queue {
    const existing = this.queues.get(queueName);
    if (existing) {
      return existing;
    }
    const queue = new Queue(queueName, {
      connection: {
        url: this.redisUrl
      }
    });
    this.queues.set(queueName, queue);
    return queue;
  }
}
/* v8 ignore stop */

export function sanitizeQueuePayload<T>(payload: T): T {
  if (payload === null || typeof payload !== "object") {
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeQueuePayload(item)) as T;
  }
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
      if (/token|secret|password|cookie|credential|authorization|session|auth|idempotency/i.test(key) || containsSecretValue(value)) {
        return [key, "[redacted]"];
      }
      return [key, sanitizeQueuePayload(value)];
    })
  ) as T;
}

function containsSecretValue(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    /bearer\s+[a-z0-9._~+/=-]+/i.test(value) ||
    /(?:api[_-]?key|token|secret|password|session)=([^&\s]+)/i.test(value) ||
    /(?:sk|ghp|glpat|xox[baprs])[-_a-z0-9]{16,}/i.test(value)
  );
}
