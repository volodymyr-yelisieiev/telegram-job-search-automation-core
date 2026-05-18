# Queues and Workers

## Queue Registry

The queue registry is typed in `packages/db/src/queue.ts` and currently includes:

- `source_poll_queue`
- `telegram_channel_ingest_queue`
- `parsing_queue`
- `dedup_queue`
- `scoring_queue`
- `resume_selection_queue`
- `application_generation_queue`
- `auto_apply_queue`
- `inbox_sync_queue`
- `message_classification_queue`
- `reply_generation_queue`
- `reply_dispatch_queue`
- `interview_coordination_queue`
- `digest_queue`
- `canary_queue`
- `retry_queue`
- `dead_letter_queue`

Each queue has:

- a Zod payload schema;
- retry attempts;
- backoff;
- concurrency;
- timeout;
- no-retry error code matrix;
- pause-blocking behavior.

Payload schemas fail closed when a task lacks the queue's identifying key, such as `applicationId`/`jobId` for `auto_apply_queue`, `outboundMessageId`/`conversationId` for `reply_dispatch_queue`, or `taskRunId`/`deadLetterId` for retry paths. Both in-memory and BullMQ adapters validate the same schemas before redacting payloads and enqueueing work.

Runtime queue selection is controlled by `QUEUE_BACKEND=memory|bullmq`; `createRuntimeQueue` returns `InMemoryQueueAdapter` for local-safe runs and `BullMqQueueAdapter` for Redis-backed production-shaped runs using `REDIS_URL`. API, Telegram approval enqueue, and worker entrypoints use that shared runtime factory. BullMQ enqueue stores a typed job envelope with redacted payload plus idempotency, deduplication, and creation metadata; `createBullMqQueueWorker` reconstructs the same `QueueTask`, writes task-run lifecycle through `TaskRunStore`, moves no-retry failures to DLQ, and rethrows retryable failures so BullMQ attempts/backoff remain authoritative.

When the in-memory adapter is backed by a task-run store, queue depth and oldest-age metrics only count `queued` or `running` tasks. Succeeded, failed, and dead-lettered records remain available for audit/DLQ workflows but no longer inflate backlog alerts.

## Idempotency

`IdempotencyService` owns the local lifecycle and `PostgresIdempotencyService` mirrors the same lifecycle into `idempotency_keys`:

1. `acquire`
2. execute guarded work
3. `commit` on success
4. `fail` on unrecoverable failure
5. `release` only for explicitly safe retry/rebuild paths

Irreversible-equivalent work must not run unless idempotency acquisition succeeds. When `STATE_BACKEND=postgres`, `PostgresRuntimeDatabase.idempotencyService` provides the durable implementation for production-shaped callers.

## Task Runs and DLQ

`InMemoryTaskRunStore` provides the fast local contract and `PostgresTaskRunStore` mirrors the same lifecycle into Postgres for production-shaped runs:

- `queued`
- `running`
- `succeeded`
- `failed`
- `dead_lettered`

No-retry failures such as `captcha_required`, `selector_missing`, `policy_failed`, `duplicate_company_thread_detected`, `provider_terms_block`, and `anti_automation_detected` should move to DLQ.

DLQ operational states are:

- `open`
- `assigned`
- `resolved`
- `discarded`

Each assignment, retry, resolve, or discard path has an API operation and records an audit event. Retry enqueue uses `retry:${deadLetterId}` as the retry idempotency key. When `STATE_BACKEND=postgres`, the API wires queue execution state to `PostgresRuntimeDatabase.taskRunStore`.

Durable Postgres tables are introduced by migration `003_runtime_execution` and extended by `004_ops_controls`:

- `task_runs`
- `dead_letter_tasks`
- `idempotency_keys`

Local resilience command:

```bash
pnpm queue:resilience
```

It verifies duplicate enqueue suppression, worker restart recovery through DLQ, dead-letter visibility, and retry queue creation. External Redis restart drills remain part of staging operations.

## API Surfaces

- `GET /queues` returns queue depth, oldest queued-task age, and queue policy.
- `GET /dlq` returns current dead-letter records.
- `POST /dlq/:id/assign` assigns owner.
- `POST /dlq/:id/retry` queues an idempotent retry.
- `POST /dlq/:id/resolve` closes a handled item.
- `POST /dlq/:id/discard` closes a non-retryable item.

## Worker Shutdown

Production-shaped worker entrypoints create the configured runtime database, execute one worker pass, flush durable persistence, and close the database. Long-running BullMQ consumers should use `createBullMqQueueWorker`, keep graceful signal handling around worker shutdown, and flush Postgres task-run persistence before process exit.
