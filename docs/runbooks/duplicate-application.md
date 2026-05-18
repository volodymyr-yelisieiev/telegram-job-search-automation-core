# Duplicate Application Runbook

## Trigger

Use this runbook when duplicate application attempts are detected by idempotency, dedup groups, provider confirmation conflicts, or an operator report.

## Immediate Actions

1. Set mode to `review_first` or `paused`.
2. Inspect `/applications`, `/logs/:entityId`, dedup decisions, and task idempotency records.
3. Identify whether the duplicate was prevented, queued, or externally submitted.
4. Disable the affected provider if provider-side confirmation is ambiguous.

## Recovery

- Keep the earliest valid application record as canonical.
- Attach proof packs and audit events to the incident.
- Mark duplicate attempts as prevented or blocked, not applied.
- Add or fix fixture cases that would have caught the duplicate.
- Run `pnpm verify` and `SOAK_ITERATIONS=2 pnpm soak:fixture` before re-enabling automation.
