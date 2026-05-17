# Runbook: DLQ Triage

1. Inspect queue name, idempotency key, deduplication key, attempts, and error code.
2. Classify outcome: retry, manual review, provider disabled, apply failed, read-only fallback, or dead-lettered.
3. Never retry irreversible actions without checking idempotency and audit records.
4. Add missing error taxonomy mapping when a task has an unknown failure.
