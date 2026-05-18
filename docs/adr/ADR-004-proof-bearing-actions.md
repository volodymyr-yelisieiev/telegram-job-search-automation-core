# ADR-004: Proof-Bearing Irreversible Actions

## Decision

Every irreversible or externally visible action must be proof-bearing: policy decision, validation result, idempotency key, audit event, and action proof are required before the action can be treated as completed.

## Rationale

Applications, recruiter replies, and interview confirmations need post-action accountability. Without proof, the system cannot distinguish success, retry, duplicate prevention, provider failure, or an operator mistake.

## Consequences

- Application status cannot become `applied` without provider confirmation/proof in live mode.
- Reply dispatch records text hash, validation hash, policy result, delivery status, and idempotency.
- Interview scheduling stores the chosen slot, policy proof, calendar conflict result, and final card.
- Missing proof blocks release gates and creates an operations incident.
- Rollback downgrades automation mode and preserves audit history rather than deleting evidence.
