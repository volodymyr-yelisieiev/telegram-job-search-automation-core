# R4 Auto-Apply Release Evidence

Date: 2026-05-18

## Scope

R4 local-safe evidence covers resume routing, cover-letter validation, proof metadata, policy checks, manual review fallback, application lifecycle transitions, and ordered submit guards.

## Evidence

- resume routing tests;
- cover-letter fact validation tests;
- application idempotency key tests;
- proof pack audit linkage tests;
- `ApplicationLifecycle` transition tests;
- `SubmitGuardSequence` tests;
- review-first manual approval workflow.

## Deferred External Evidence

- first live provider submit under review-first;
- confirmation screenshot/text/URL capture from real provider;
- controlled auto-submit ramp;
- cross-provider live duplicate prevention proof.

No live submit is enabled by R4 local-safe evidence.
