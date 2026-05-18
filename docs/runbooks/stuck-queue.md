# Stuck Queue Runbook

## Symptoms

- Queue depth keeps increasing.
- `task_runs` has old `running` records with stale `last_heartbeat_at`.
- `/queues` reports depth but no successful worker logs.

## Immediate Actions

1. Pause irreversible queues by switching mode to `paused` or `read_only`.
2. Inspect `/queues`, `/dlq`, or Telegram `/dlq`.
3. Check worker logs for timeout, provider, policy, and database errors.
4. Move no-retry failures to DLQ with the original error code.
5. Restart workers only after confirming idempotency keys prevent duplicate submit/reply/confirm behavior.

## Recovery

- Assign ownership with `POST /dlq/:id/assign`.
- Queue an idempotent retry with `POST /dlq/:id/retry`.
- Mark terminal items with `POST /dlq/:id/resolve` or `POST /dlq/:id/discard`.
- Retry only idempotent tasks or tasks whose idempotency key is still `released`.
- Keep `auto_apply_queue`, `reply_dispatch_queue`, and `interview_coordination_queue` paused until policy/proof gates are confirmed.
- Record an audit event or incident note for every manually retried irreversible-equivalent task.
