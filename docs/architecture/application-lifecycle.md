# Application Lifecycle

Application state is controlled by `ApplicationLifecycle`.

## Allowed Transitions

| Current | Allowed next |
|---|---|
| `application_prepared` | `manual_review_required`, `apply_queued`, `apply_blocked_by_policy`, `apply_blocked_by_provider` |
| `manual_review_required` | `apply_queued`, `apply_blocked_by_policy`, `duplicate_prevented` |
| `apply_queued` | `apply_dry_run_passed`, `applying`, `apply_failed` |
| `apply_dry_run_passed` | `applying`, `manual_review_required` |
| `applying` | `applied`, `apply_failed` |
| terminal | `applied`, `duplicate_prevented` |

## Submit Guard Sequence

`SubmitGuardSequence` checks, in order:

1. policy allows submit;
2. dry-run passed with a matching provider/job proof pack and submit-boundary final status;
3. proof capture is ready with pre-action screenshot and DOM snapshot metadata;
4. idempotency key exists;
5. recent canary passed;
6. provider is stable.

The approved-submit worker enforces canary freshness with a 24-hour local window and rejects stale historical canary passes. The guard sequence is necessary but not sufficient for live submit. Live submit also requires a provider implementation, operator rollout approval, and external provider/account readiness.
