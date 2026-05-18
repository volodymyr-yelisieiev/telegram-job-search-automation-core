import { Queue, Worker, type Job } from "bullmq";
import type pg from "pg";
import { z } from "zod";

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

const queueId = z.string().min(1);

function queuePayloadSchema<Shape extends z.ZodRawShape>(shape: Shape, requiredAnyOf: Array<keyof Shape | string>): z.ZodType<unknown> {
  return z
    .object(shape)
    .passthrough()
    .superRefine((payload, ctx) => {
      const hasRequiredIdentifier = requiredAnyOf.some((key) => {
        const value = (payload as Record<string, unknown>)[String(key)];
        return typeof value === "string" && value.trim().length > 0;
      });
      if (!hasRequiredIdentifier) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Queue payload must include one of: ${requiredAnyOf.map(String).join(", ")}`
        });
      }
    });
}

export const queuePayloadSchemas: Record<QueueName, z.ZodType<unknown>> = {
  source_poll_queue: queuePayloadSchema({ providerId: queueId.optional(), searchProfileId: queueId.optional() }, ["providerId", "searchProfileId"]),
  telegram_channel_ingest_queue: queuePayloadSchema({ channelId: queueId.optional() }, ["channelId"]),
  parsing_queue: queuePayloadSchema({ rawJobId: queueId.optional() }, ["rawJobId"]),
  dedup_queue: queuePayloadSchema({ jobId: queueId.optional() }, ["jobId"]),
  scoring_queue: queuePayloadSchema({ jobId: queueId.optional() }, ["jobId"]),
  resume_selection_queue: queuePayloadSchema({ jobId: queueId.optional(), profileId: queueId.optional() }, ["jobId", "profileId"]),
  application_generation_queue: queuePayloadSchema({ jobId: queueId.optional(), applicationId: queueId.optional() }, ["jobId", "applicationId"]),
  auto_apply_queue: queuePayloadSchema({ applicationId: queueId.optional(), jobId: queueId.optional(), providerId: queueId.optional() }, [
    "applicationId",
    "jobId"
  ]),
  inbox_sync_queue: queuePayloadSchema({ providerId: queueId.optional(), accountId: queueId.optional() }, ["providerId", "accountId"]),
  message_classification_queue: queuePayloadSchema({ inboundMessageId: queueId.optional() }, ["inboundMessageId"]),
  reply_generation_queue: queuePayloadSchema({ inboundMessageId: queueId.optional(), conversationId: queueId.optional() }, [
    "inboundMessageId",
    "conversationId"
  ]),
  reply_dispatch_queue: queuePayloadSchema({ outboundMessageId: queueId.optional(), conversationId: queueId.optional() }, [
    "outboundMessageId",
    "conversationId"
  ]),
  interview_coordination_queue: queuePayloadSchema({ conversationId: queueId.optional(), inboundMessageId: queueId.optional() }, [
    "conversationId",
    "inboundMessageId"
  ]),
  digest_queue: queuePayloadSchema({ userId: queueId.optional() }, ["userId"]),
  canary_queue: queuePayloadSchema({ providerId: queueId.optional() }, ["providerId"]),
  retry_queue: queuePayloadSchema({ taskRunId: queueId.optional(), deadLetterId: queueId.optional() }, ["taskRunId", "deadLetterId"]),
  dead_letter_queue: queuePayloadSchema({ taskRunId: queueId.optional(), errorCode: queueId.optional() }, ["taskRunId"])
};

export interface QueuePolicy {
  queueName: QueueName;
  attempts: number;
  backoffMs: number;
  concurrency: number;
  timeoutMs: number;
  noRetryErrorCodes: string[];
  blocksWhenPaused: boolean;
}

export const queuePolicies: Record<QueueName, QueuePolicy> = Object.fromEntries(
  queueNames.map((queueName) => [
    queueName,
    {
      queueName,
      attempts: queueName === "dead_letter_queue" ? 1 : 3,
      backoffMs: queueName === "auto_apply_queue" || queueName === "reply_dispatch_queue" ? 60_000 : 30_000,
      concurrency: queueName === "auto_apply_queue" || queueName === "reply_dispatch_queue" ? 1 : 4,
      timeoutMs: queueName.includes("apply") || queueName.includes("canary") ? 120_000 : 30_000,
      noRetryErrorCodes: [
        "captcha_required",
        "selector_missing",
        "policy_failed",
        "duplicate_company_thread_detected",
        "provider_terms_block",
        "anti_automation_detected"
      ],
      blocksWhenPaused: !["source_poll_queue", "telegram_channel_ingest_queue", "parsing_queue", "dedup_queue", "scoring_queue", "digest_queue", "canary_queue"].includes(queueName)
    } satisfies QueuePolicy
  ])
) as Record<QueueName, QueuePolicy>;

export interface QueueTask<T = unknown> {
  id: string;
  queueName: QueueName;
  payload: T;
  idempotencyKey: string;
  deduplicationKey: string;
  attempts: number;
  createdAt: string;
}

export interface BullMqQueueJobEnvelope<T = unknown> {
  payload: T;
  metadata: {
    idempotencyKey: string;
    deduplicationKey: string;
    createdAt: string;
  };
}

export interface BullMqQueueJobLike<T = unknown> {
  id?: string | number;
  data: BullMqQueueJobEnvelope<T> | T;
  timestamp?: number;
  attemptsMade?: number;
}

export type TaskRunStatus = "queued" | "running" | "succeeded" | "failed" | "dead_lettered";

export interface TaskRunRecord<T = unknown> {
  id: string;
  queueName: QueueName;
  payload: T;
  idempotencyKey: string;
  deduplicationKey: string;
  status: TaskRunStatus;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DeadLetterRecord<T = unknown> {
  id: string;
  taskRunId: string;
  queueName: QueueName;
  payload: T;
  errorCode: string;
  errorMessage: string;
  status: "open" | "assigned" | "resolved" | "discarded";
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface TaskRunStore {
  createQueued<T>(task: QueueTask<T>): TaskRunRecord<T>;
  getTaskRun(taskRunId: string): TaskRunRecord | null;
  markRunning(taskRunId: string): TaskRunRecord | null;
  heartbeat(taskRunId: string): TaskRunRecord | null;
  markSucceeded(taskRunId: string): TaskRunRecord | null;
  markFailed(taskRunId: string, error: { code: string; message: string }): TaskRunRecord | null;
  moveToDeadLetter(taskRunId: string, error: { code: string; message: string }): DeadLetterRecord | null;
  getDeadLetter(id: string): DeadLetterRecord | null;
  listDeadLetters(status?: DeadLetterRecord["status"]): DeadLetterRecord[];
  assignDeadLetter(id: string, input: { assignee: string; actor: string; note?: string | null }): DeadLetterRecord | null;
  resolveDeadLetter(id: string, input: { actor: string; note?: string | null }): DeadLetterRecord | null;
  discardDeadLetter(id: string, input: { actor: string; note?: string | null }): DeadLetterRecord | null;
}

export type IdempotencyStatus = "acquired" | "committed" | "failed" | "released";

export interface IdempotencyRecord {
  key: string;
  entityType: string;
  entityId: string;
  status: IdempotencyStatus;
  acquiredAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export class IdempotencyService {
  protected readonly records = new Map<string, IdempotencyRecord>();

  acquire(input: { key: string; entityType: string; entityId: string }): { acquired: boolean; record: IdempotencyRecord } {
    const existing = this.records.get(input.key);
    if (existing && existing.status !== "released") {
      return { acquired: false, record: existing };
    }
    const record: IdempotencyRecord = {
      key: input.key,
      entityType: input.entityType,
      entityId: input.entityId,
      status: "acquired",
      acquiredAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null
    };
    this.records.set(input.key, record);
    return { acquired: true, record };
  }

  commit(key: string): IdempotencyRecord {
    return this.transition(key, "committed", null);
  }

  fail(key: string, errorMessage: string): IdempotencyRecord {
    return this.transition(key, "failed", errorMessage);
  }

  release(key: string): IdempotencyRecord {
    return this.transition(key, "released", null);
  }

  get(key: string): IdempotencyRecord | null {
    return this.records.get(key) ?? null;
  }

  protected importRecord(record: IdempotencyRecord): void {
    this.records.set(record.key, record);
  }

  private transition(key: string, status: IdempotencyStatus, errorMessage: string | null): IdempotencyRecord {
    const existing = this.records.get(key);
    if (!existing) {
      throw new Error(`Idempotency key is not acquired: ${key}`);
    }
    const updated = {
      ...existing,
      status,
      completedAt: new Date().toISOString(),
      errorMessage
    };
    this.records.set(key, updated);
    return updated;
  }
}

/* v8 ignore start -- SQL execution is exercised through mocked pools in contract tests and live smoke environments. */
export class PostgresIdempotencyService extends IdempotencyService {
  private readonly pendingWrites: Array<Promise<void>> = [];
  private readonly persistenceErrors: Error[] = [];

  constructor(private readonly pool: pg.Pool) {
    super();
  }

  async hydrate(): Promise<void> {
    const rows = await this.pool.query<{
      key: string;
      entity_type: string;
      entity_id: string;
      status: IdempotencyStatus;
      acquired_at: Date;
      completed_at: Date | null;
      error_message: string | null;
    }>("SELECT * FROM idempotency_keys");
    for (const row of rows.rows) {
      this.importRecord({
        key: row.key,
        entityType: row.entity_type,
        entityId: row.entity_id,
        status: row.status,
        acquiredAt: row.acquired_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
        errorMessage: row.error_message
      });
    }
  }

  override acquire(input: { key: string; entityType: string; entityId: string }): { acquired: boolean; record: IdempotencyRecord } {
    const result = super.acquire(input);
    this.persistRecord(result.record);
    return result;
  }

  override commit(key: string): IdempotencyRecord {
    return this.persistAndReturn(super.commit(key));
  }

  override fail(key: string, errorMessage: string): IdempotencyRecord {
    return this.persistAndReturn(super.fail(key, errorMessage));
  }

  override release(key: string): IdempotencyRecord {
    return this.persistAndReturn(super.release(key));
  }

  async flushPersistence(): Promise<void> {
    const pending = this.pendingWrites.splice(0);
    if (pending.length > 0) {
      await Promise.all(pending);
    }
    if (this.persistenceErrors.length > 0) {
      const [first] = this.persistenceErrors.splice(0);
      throw first ?? new Error("Postgres idempotency persistence failed");
    }
  }

  private persistAndReturn(record: IdempotencyRecord): IdempotencyRecord {
    this.persistRecord(record);
    return record;
  }

  private persistRecord(record: IdempotencyRecord): void {
    this.pendingWrites.push(
      this.pool
        .query(
          `
INSERT INTO idempotency_keys (
  key, entity_type, entity_id, status, acquired_at, completed_at, error_message
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (key) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  entity_id = EXCLUDED.entity_id,
  status = EXCLUDED.status,
  completed_at = EXCLUDED.completed_at,
  error_message = EXCLUDED.error_message
`,
          [record.key, record.entityType, record.entityId, record.status, record.acquiredAt, record.completedAt, record.errorMessage]
        )
        .then(
          () => undefined,
          (error: unknown) => {
            this.persistenceErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        )
    );
  }
}
/* v8 ignore stop */

export class InMemoryTaskRunStore implements TaskRunStore {
  protected readonly taskRuns = new Map<string, TaskRunRecord>();
  protected readonly deadLetters = new Map<string, DeadLetterRecord>();

  createQueued<T>(task: QueueTask<T>): TaskRunRecord<T> {
    const existing = this.taskRuns.get(task.id) as TaskRunRecord<T> | undefined;
    if (existing) {
      return existing;
    }
    const record: TaskRunRecord<T> = {
      id: task.id,
      queueName: task.queueName,
      payload: task.payload,
      idempotencyKey: task.idempotencyKey,
      deduplicationKey: task.deduplicationKey,
      status: "queued",
      attempts: 0,
      createdAt: task.createdAt,
      startedAt: null,
      completedAt: null,
      lastHeartbeatAt: null,
      errorCode: null,
      errorMessage: null
    };
    this.taskRuns.set(record.id, record);
    return record;
  }

  getTaskRun(taskRunId: string): TaskRunRecord | null {
    return this.taskRuns.get(taskRunId) ?? null;
  }

  protected importTaskRun(record: TaskRunRecord): void {
    this.taskRuns.set(record.id, record);
  }

  protected importDeadLetter(record: DeadLetterRecord): void {
    this.deadLetters.set(record.id, record);
  }

  markRunning(taskRunId: string): TaskRunRecord | null {
    return this.patch(taskRunId, {
      status: "running",
      attempts: (this.taskRuns.get(taskRunId)?.attempts ?? 0) + 1,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString()
    });
  }

  heartbeat(taskRunId: string): TaskRunRecord | null {
    return this.patch(taskRunId, { lastHeartbeatAt: new Date().toISOString() });
  }

  markSucceeded(taskRunId: string): TaskRunRecord | null {
    return this.patch(taskRunId, { status: "succeeded", completedAt: new Date().toISOString() });
  }

  markFailed(taskRunId: string, error: { code: string; message: string }): TaskRunRecord | null {
    return this.patch(taskRunId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      errorCode: error.code,
      errorMessage: error.message
    });
  }

  moveToDeadLetter(taskRunId: string, error: { code: string; message: string }): DeadLetterRecord | null {
    const taskRun = this.markFailed(taskRunId, error);
    if (!taskRun) {
      return null;
    }
    const record: DeadLetterRecord = {
      id: `dlq:${taskRunId}`,
      taskRunId,
      queueName: taskRun.queueName,
      payload: taskRun.payload,
      errorCode: error.code,
      errorMessage: error.message,
      status: "open",
      assignedTo: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null
    };
    taskRun.status = "dead_lettered";
    this.deadLetters.set(record.id, record);
    return record;
  }

  getDeadLetter(id: string): DeadLetterRecord | null {
    return this.deadLetters.get(id) ?? null;
  }

  listDeadLetters(status?: DeadLetterRecord["status"]): DeadLetterRecord[] {
    const records = [...this.deadLetters.values()];
    return status ? records.filter((record) => record.status === status) : records;
  }

  assignDeadLetter(id: string, input: { assignee: string; actor: string; note?: string | null }): DeadLetterRecord | null {
    const record = this.deadLetters.get(id);
    if (!record || record.status === "resolved" || record.status === "discarded") {
      return null;
    }
    record.status = "assigned";
    record.assignedTo = input.assignee;
    record.updatedAt = new Date().toISOString();
    record.resolutionNote = input.note ?? `assigned by ${input.actor}`;
    return record;
  }

  resolveDeadLetter(id: string, input: { actor: string; note?: string | null }): DeadLetterRecord | null {
    return this.finishDeadLetter(id, "resolved", input);
  }

  discardDeadLetter(id: string, input: { actor: string; note?: string | null }): DeadLetterRecord | null {
    return this.finishDeadLetter(id, "discarded", input);
  }

  private patch(taskRunId: string, patch: Partial<TaskRunRecord>): TaskRunRecord | null {
    const existing = this.taskRuns.get(taskRunId);
    if (!existing) {
      return null;
    }
    Object.assign(existing, patch);
    return existing;
  }

  private finishDeadLetter(
    id: string,
    status: Extract<DeadLetterRecord["status"], "resolved" | "discarded">,
    input: { actor: string; note?: string | null }
  ): DeadLetterRecord | null {
    const record = this.deadLetters.get(id);
    if (!record || record.status === "resolved" || record.status === "discarded") {
      return null;
    }
    record.status = status;
    record.resolvedAt = new Date().toISOString();
    record.updatedAt = record.resolvedAt;
    record.resolvedBy = input.actor;
    record.resolutionNote = input.note ?? null;
    return record;
  }
}

/* v8 ignore start -- SQL execution is exercised through mocked pools in contract tests and live smoke environments. */
export class PostgresTaskRunStore extends InMemoryTaskRunStore {
  private readonly pendingWrites: Array<Promise<void>> = [];
  private readonly persistenceErrors: Error[] = [];

  constructor(private readonly pool: pg.Pool) {
    super();
  }

  async hydrate(): Promise<void> {
    const taskRuns = await this.pool.query<{
      id: string;
      queue_name: QueueName;
      payload: unknown;
      idempotency_key: string;
      deduplication_key: string;
      status: TaskRunStatus;
      attempts: number;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
      last_heartbeat_at: Date | null;
      error_code: string | null;
      error_message: string | null;
    }>("SELECT * FROM task_runs ORDER BY created_at");
    for (const row of taskRuns.rows) {
      this.importTaskRun({
        id: row.id,
        queueName: row.queue_name,
        payload: row.payload,
        idempotencyKey: row.idempotency_key,
        deduplicationKey: row.deduplication_key,
        status: row.status,
        attempts: row.attempts,
        createdAt: row.created_at.toISOString(),
        startedAt: row.started_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
        lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
        errorCode: row.error_code,
        errorMessage: row.error_message
      });
    }
    const deadLetters = await this.pool.query<{
      id: string;
      task_run_id: string;
      queue_name: QueueName;
      payload: unknown;
      error_code: string;
      error_message: string;
      status: DeadLetterRecord["status"];
      assigned_to: string | null;
      created_at: Date;
      updated_at: Date;
      resolved_at: Date | null;
      resolved_by: string | null;
      resolution_note: string | null;
    }>("SELECT * FROM dead_letter_tasks ORDER BY created_at");
    for (const row of deadLetters.rows) {
      this.importDeadLetter({
        id: row.id,
        taskRunId: row.task_run_id,
        queueName: row.queue_name,
        payload: row.payload,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        status: row.status,
        assignedTo: row.assigned_to,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        resolvedBy: row.resolved_by,
        resolutionNote: row.resolution_note
      });
    }
  }

  override createQueued<T>(task: QueueTask<T>): TaskRunRecord<T> {
    const record = super.createQueued(task);
    this.persistTaskRun(record);
    return record;
  }

  override markRunning(taskRunId: string): TaskRunRecord | null {
    return this.persistTaskRunResult(super.markRunning(taskRunId));
  }

  override heartbeat(taskRunId: string): TaskRunRecord | null {
    return this.persistTaskRunResult(super.heartbeat(taskRunId));
  }

  override markSucceeded(taskRunId: string): TaskRunRecord | null {
    return this.persistTaskRunResult(super.markSucceeded(taskRunId));
  }

  override markFailed(taskRunId: string, error: { code: string; message: string }): TaskRunRecord | null {
    return this.persistTaskRunResult(super.markFailed(taskRunId, error));
  }

  override moveToDeadLetter(taskRunId: string, error: { code: string; message: string }): DeadLetterRecord | null {
    const record = super.moveToDeadLetter(taskRunId, error);
    const taskRun = this.getTaskRun(taskRunId);
    if (taskRun) {
      this.persistTaskRun(taskRun);
    }
    if (record) {
      this.persistDeadLetter(record);
    }
    return record;
  }

  override assignDeadLetter(id: string, input: { assignee: string; actor: string; note?: string | null }): DeadLetterRecord | null {
    return this.persistDeadLetterResult(super.assignDeadLetter(id, input));
  }

  override resolveDeadLetter(id: string, input: { actor: string; note?: string | null }): DeadLetterRecord | null {
    return this.persistDeadLetterResult(super.resolveDeadLetter(id, input));
  }

  override discardDeadLetter(id: string, input: { actor: string; note?: string | null }): DeadLetterRecord | null {
    return this.persistDeadLetterResult(super.discardDeadLetter(id, input));
  }

  async flushPersistence(): Promise<void> {
    const pending = this.pendingWrites.splice(0);
    if (pending.length > 0) {
      await Promise.all(pending);
    }
    if (this.persistenceErrors.length > 0) {
      const [first] = this.persistenceErrors.splice(0);
      throw first ?? new Error("Postgres task-run persistence failed");
    }
  }

  private persistTaskRunResult(record: TaskRunRecord | null): TaskRunRecord | null {
    if (record) {
      this.persistTaskRun(record);
    }
    return record;
  }

  private persistDeadLetterResult(record: DeadLetterRecord | null): DeadLetterRecord | null {
    if (record) {
      this.persistDeadLetter(record);
    }
    return record;
  }

  private persistTaskRun(record: TaskRunRecord): void {
    this.persist(
      this.pool.query(
        `
INSERT INTO task_runs (
  id, queue_name, idempotency_key, deduplication_key, status, attempts, payload,
  created_at, started_at, completed_at, last_heartbeat_at, error_code, error_message
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (id) DO UPDATE SET
  queue_name = EXCLUDED.queue_name,
  idempotency_key = EXCLUDED.idempotency_key,
  deduplication_key = EXCLUDED.deduplication_key,
  status = EXCLUDED.status,
  attempts = EXCLUDED.attempts,
  payload = EXCLUDED.payload,
  started_at = EXCLUDED.started_at,
  completed_at = EXCLUDED.completed_at,
  last_heartbeat_at = EXCLUDED.last_heartbeat_at,
  error_code = EXCLUDED.error_code,
  error_message = EXCLUDED.error_message
`,
        [
          record.id,
          record.queueName,
          record.idempotencyKey,
          record.deduplicationKey,
          record.status,
          record.attempts,
          record.payload,
          record.createdAt,
          record.startedAt,
          record.completedAt,
          record.lastHeartbeatAt,
          record.errorCode,
          record.errorMessage
        ]
      )
    );
  }

  private persistDeadLetter(record: DeadLetterRecord): void {
    this.persist(
      this.pool.query(
        `
INSERT INTO dead_letter_tasks (
  id, task_run_id, queue_name, payload, error_code, error_message, status,
  assigned_to, created_at, updated_at, resolved_at, resolved_by, resolution_note
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  assigned_to = EXCLUDED.assigned_to,
  updated_at = EXCLUDED.updated_at,
  resolved_at = EXCLUDED.resolved_at,
  resolved_by = EXCLUDED.resolved_by,
  resolution_note = EXCLUDED.resolution_note
`,
        [
          record.id,
          record.taskRunId,
          record.queueName,
          record.payload,
          record.errorCode,
          record.errorMessage,
          record.status,
          record.assignedTo,
          record.createdAt,
          record.updatedAt,
          record.resolvedAt,
          record.resolvedBy,
          record.resolutionNote
        ]
      )
    );
  }

  private persist(write: Promise<unknown>): void {
    this.pendingWrites.push(
      write.then(
        () => undefined,
        (error: unknown) => {
          this.persistenceErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      )
    );
  }
}
/* v8 ignore stop */

export interface QueueAdapter {
  enqueue<T>(queueName: QueueName, payload: T, metadata: { idempotencyKey: string; deduplicationKey: string }): Promise<QueueTask<T>>;
  depth(queueName: QueueName): Promise<number>;
  oldestAgeSeconds(queueName: QueueName): Promise<number>;
  remove?(task: QueueTask): Promise<boolean>;
  close?(): Promise<void>;
}

export interface QueueWorkerExecution<T = unknown, R = unknown> {
  task: QueueTask<T>;
  taskRun: TaskRunRecord | null;
  status: "succeeded" | "failed" | "dead_lettered";
  result: R | null;
  errorCode: string | null;
}

export async function executeQueueTask<T, R>(input: {
  taskRunStore: TaskRunStore;
  task: QueueTask<T>;
  handler: (payload: T, task: QueueTask<T>) => Promise<R>;
  noRetryErrorCodes?: string[];
}): Promise<QueueWorkerExecution<T, R>> {
  input.taskRunStore.createQueued(input.task);
  input.taskRunStore.markRunning(input.task.id);
  try {
    input.taskRunStore.heartbeat(input.task.id);
    const result = await input.handler(input.task.payload, input.task);
    return {
      task: input.task,
      taskRun: input.taskRunStore.markSucceeded(input.task.id),
      status: "succeeded",
      result,
      errorCode: null
    };
  } catch (error) {
    const code = error instanceof QueueWorkerError ? error.code : "worker_failed";
    const message = error instanceof Error ? error.message : String(error);
    if ((input.noRetryErrorCodes ?? []).includes(code)) {
      input.taskRunStore.moveToDeadLetter(input.task.id, { code, message });
      return {
        task: input.task,
        taskRun: input.taskRunStore.getTaskRun(input.task.id),
        status: "dead_lettered",
        result: null,
        errorCode: code
      };
    }
    return {
      task: input.task,
      taskRun: input.taskRunStore.markFailed(input.task.id, { code, message }),
      status: "failed",
      result: null,
      errorCode: code
    };
  }
}

export class QueueWorkerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function bullMqJobToQueueTask<T>(queueName: QueueName, job: BullMqQueueJobLike<T>): QueueTask<T> {
  const envelope = parseBullMqJobEnvelope(job.data);
  const idempotencyKey = envelope.metadata.idempotencyKey || normalizeBullMqJobId(job.id);
  const createdAt = normalizeBullMqCreatedAt(envelope.metadata.createdAt, job.timestamp);
  queuePayloadSchemas[queueName].parse(envelope.payload);
  return {
    id: `${queueName}:${idempotencyKey}`,
    queueName,
    payload: envelope.payload,
    idempotencyKey,
    deduplicationKey: envelope.metadata.deduplicationKey || idempotencyKey,
    attempts: job.attemptsMade ?? 0,
    createdAt
  };
}

export async function executeBullMqQueueJob<T, R>(input: {
  queueName: QueueName;
  job: BullMqQueueJobLike<T>;
  taskRunStore: TaskRunStore;
  handler: (payload: T, task: QueueTask<T>) => Promise<R>;
  noRetryErrorCodes?: string[];
}): Promise<QueueWorkerExecution<T, R>> {
  const task = bullMqJobToQueueTask(input.queueName, input.job);
  const execution = await executeQueueTask({
    taskRunStore: input.taskRunStore,
    task,
    noRetryErrorCodes: input.noRetryErrorCodes ?? queuePolicies[input.queueName].noRetryErrorCodes,
    handler: input.handler
  });
  if (execution.status === "failed") {
    throw new QueueWorkerError(execution.errorCode ?? "worker_failed", `Retryable queue failure: ${execution.errorCode ?? "worker_failed"}`);
  }
  return execution;
}

/* v8 ignore start -- Redis worker construction is exercised in staging; executeBullMqQueueJob covers the processor logic locally. */
export function createBullMqQueueWorker<T, R>(input: {
  queueName: QueueName;
  redisUrl: string;
  taskRunStore: TaskRunStore;
  handler: (payload: T, task: QueueTask<T>) => Promise<R>;
  noRetryErrorCodes?: string[];
  concurrency?: number;
}): Worker<BullMqQueueJobEnvelope<T> | T, QueueWorkerExecution<T, R>, string> {
  const policy = queuePolicies[input.queueName];
  return new Worker<BullMqQueueJobEnvelope<T> | T, QueueWorkerExecution<T, R>, string>(
    input.queueName,
    async (job: Job<BullMqQueueJobEnvelope<T> | T, QueueWorkerExecution<T, R>, string>) =>
      executeBullMqQueueJob({
        queueName: input.queueName,
        job,
        taskRunStore: input.taskRunStore,
        handler: input.handler,
        noRetryErrorCodes: input.noRetryErrorCodes ?? policy.noRetryErrorCodes
      }),
    {
      connection: {
        url: input.redisUrl
      },
      concurrency: input.concurrency ?? policy.concurrency,
      lockDuration: policy.timeoutMs
    }
  );
}
/* v8 ignore stop */

export class InMemoryQueueAdapter implements QueueAdapter {
  private readonly tasks = new Map<QueueName, QueueTask[]>();

  constructor(private readonly taskRunStore?: TaskRunStore) {}

  async enqueue<T>(
    queueName: QueueName,
    payload: T,
    metadata: { idempotencyKey: string; deduplicationKey: string }
  ): Promise<QueueTask<T>> {
    queuePayloadSchemas[queueName].parse(payload);
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
    this.taskRunStore?.createQueued(task);
    return task;
  }

  async depth(queueName: QueueName): Promise<number> {
    return this.pendingTasks(queueName).length;
  }

  async oldestAgeSeconds(queueName: QueueName): Promise<number> {
    return oldestTaskAgeSeconds(this.pendingTasks(queueName));
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  async remove(task: QueueTask): Promise<boolean> {
    const tasks = this.tasks.get(task.queueName) ?? [];
    const nextTasks = tasks.filter((queuedTask) => queuedTask.id !== task.id);
    this.tasks.set(task.queueName, nextTasks);
    return nextTasks.length !== tasks.length;
  }

  private pendingTasks(queueName: QueueName): QueueTask[] {
    return (this.tasks.get(queueName) ?? []).filter((task) => {
      const taskRun = this.taskRunStore?.getTaskRun(task.id);
      return !taskRun || taskRun.status === "queued" || taskRun.status === "running";
    });
  }
}

/* v8 ignore start -- real Redis adapter is covered by smoke/integration runs, not unit coverage */
export class BullMqQueueAdapter implements QueueAdapter {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    private readonly redisUrl: string,
    private readonly taskRunStore?: TaskRunStore,
    private readonly queueFactory: (queueName: QueueName, redisUrl: string) => Queue = createBullMqQueue
  ) {}

  async enqueue<T>(
    queueName: QueueName,
    payload: T,
    metadata: { idempotencyKey: string; deduplicationKey: string }
  ): Promise<QueueTask<T>> {
    const queue = this.getQueue(queueName);
    const policy = queuePolicies[queueName];
    queuePayloadSchemas[queueName].parse(payload);
    const sanitizedPayload = sanitizeQueuePayload(payload);
    const createdAt = new Date().toISOString();
    const task: QueueTask<T> = {
      id: `${queueName}:${metadata.idempotencyKey}`,
      queueName,
      payload: sanitizedPayload as T,
      idempotencyKey: metadata.idempotencyKey,
      deduplicationKey: metadata.deduplicationKey,
      attempts: 0,
      createdAt
    };
    this.taskRunStore?.createQueued(task);
    await flushTaskRunStorePersistence(this.taskRunStore);
    try {
      await queue.add(queueName, { payload: sanitizedPayload, metadata: { ...metadata, createdAt } } satisfies BullMqQueueJobEnvelope, {
        jobId: bullMqJobIdForIdempotencyKey(metadata.idempotencyKey),
        attempts: policy.attempts,
        backoff: {
          type: "exponential",
          delay: policy.backoffMs
        },
        removeOnComplete: 1000,
        removeOnFail: false
      });
    } catch (error) {
      this.taskRunStore?.markFailed(task.id, {
        code: "bullmq_enqueue_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      await flushTaskRunStorePersistence(this.taskRunStore);
      throw error;
    }
    return task;
  }

  async depth(queueName: QueueName): Promise<number> {
    return this.getQueue(queueName).count();
  }

  async oldestAgeSeconds(queueName: QueueName): Promise<number> {
    const jobs = await this.getQueue(queueName).getJobs(["waiting", "wait", "delayed", "prioritized", "paused"], 0, 0, true);
    const oldest = jobs[0];
    return oldest ? Math.max(0, Math.floor((Date.now() - oldest.timestamp) / 1000)) : 0;
  }

  async remove(task: QueueTask): Promise<boolean> {
    const job = await this.getQueue(task.queueName).getJob(bullMqJobIdForIdempotencyKey(task.idempotencyKey));
    if (!job) {
      return false;
    }
    await job.remove();
    return true;
  }

  async close(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(queues.map((queue) => queue.close()));
  }

  private getQueue(queueName: QueueName): Queue {
    const existing = this.queues.get(queueName);
    if (existing) {
      return existing;
    }
    const queue = this.queueFactory(queueName, this.redisUrl);
    this.queues.set(queueName, queue);
    return queue;
  }
}
/* v8 ignore stop */

export function createRuntimeQueue(input: {
  backend: "memory" | "bullmq";
  redisUrl: string;
  taskRunStore?: TaskRunStore;
}): QueueAdapter {
  return input.backend === "bullmq" ? new BullMqQueueAdapter(input.redisUrl, input.taskRunStore) : new InMemoryQueueAdapter(input.taskRunStore);
}

function parseBullMqJobEnvelope<T>(data: BullMqQueueJobEnvelope<T> | T): BullMqQueueJobEnvelope<T> {
  if (isBullMqQueueJobEnvelope<T>(data)) {
    return data;
  }
  return {
    payload: data as T,
    metadata: {
      idempotencyKey: "",
      deduplicationKey: "",
      createdAt: ""
    }
  };
}

function isBullMqQueueJobEnvelope<T>(data: BullMqQueueJobEnvelope<T> | T): data is BullMqQueueJobEnvelope<T> {
  if (!data || typeof data !== "object" || !("payload" in data) || !("metadata" in data)) {
    return false;
  }
  const metadata = (data as { metadata?: unknown }).metadata;
  return Boolean(metadata && typeof metadata === "object" && "idempotencyKey" in metadata && "deduplicationKey" in metadata);
}

function normalizeBullMqJobId(id: string | number | undefined): string {
  if (typeof id === "string" && id.trim().length > 0) {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return stableQueueId();
}

function normalizeBullMqCreatedAt(createdAt: string, timestamp: number | undefined): string {
  if (Number.isFinite(Date.parse(createdAt))) {
    return createdAt;
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return new Date().toISOString();
}

function stableQueueId(): string {
  return `job:${Date.now()}`;
}

function bullMqJobIdForIdempotencyKey(idempotencyKey: string): string {
  return `idempotency-${Buffer.from(idempotencyKey).toString("base64url")}`;
}

function createBullMqQueue(queueName: QueueName, redisUrl: string): Queue {
  return new Queue(queueName, {
    connection: {
      url: redisUrl,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false
    }
  });
}

async function flushTaskRunStorePersistence(taskRunStore: TaskRunStore | undefined): Promise<void> {
  const maybeFlushable = taskRunStore as (TaskRunStore & { flushPersistence?: () => Promise<void> }) | undefined;
  if (typeof maybeFlushable?.flushPersistence === "function") {
    await maybeFlushable.flushPersistence();
  }
}

function oldestTaskAgeSeconds(tasks: QueueTask[]): number {
  const oldestCreatedAt = tasks
    .map((task) => Date.parse(task.createdAt))
    .filter((createdAt) => Number.isFinite(createdAt))
    .sort((left, right) => left - right)[0];
  return oldestCreatedAt ? Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1000)) : 0;
}

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
