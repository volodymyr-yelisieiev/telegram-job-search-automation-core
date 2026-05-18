# Proof Missing Runbook

## Trigger

Use this runbook when an application, outbound reply, or scheduling action lacks required proof: policy result, validation result, idempotency key, audit event, provider confirmation, delivery proof, or final card.

## Immediate Actions

1. Stop further irreversible actions by switching to `review_first` or `paused`.
2. Query `/release-gates`; missing proof must remain a blocker.
3. Inspect entity logs and object artifact records.
4. Determine whether the action was externally visible.

## Recovery

- If no external action occurred, mark the task failed and retry only after proof capture is fixed.
- If an external action occurred, reconstruct evidence from provider/API screenshots or delivery receipts and attach it as incident evidence.
- Add a regression test for the missing proof path.
- Do not mark R8 acceptance passed until proof coverage returns to 100%.
