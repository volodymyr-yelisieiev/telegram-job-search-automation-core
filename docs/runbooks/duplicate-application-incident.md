# Runbook: Duplicate Application Incident

1. Pause auto-apply.
2. Locate idempotency key, dedup keys, application id, job id, and audit timeline.
3. Confirm whether submit happened or was only attempted.
4. Add regression fixture for the duplicate pattern.
5. Tighten dedup matching if needed.
6. Resume only after duplicate prevention test passes.
