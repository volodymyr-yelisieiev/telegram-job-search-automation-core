# R8 GA Candidate Evidence

Date: 2026-05-18

## Current State

The repository contains a local-safe GA harness (`pnpm soak:fixture`) and evidence templates. A real R8 GA decision still requires a dated 7-day soak in an approved environment.

Generate the consolidated acceptance package with:

```bash
ACCEPTANCE_ITERATIONS=7 pnpm acceptance:package
pnpm roadmap:local-gates
pnpm release:docs-pack
pnpm release:live-plan
```

For a live sign-off gate, export evidence from `GET /release-evidence` and run the fail-closed final audit:

```bash
cp docs/examples/release-evidence.example.json release-evidence.json
cp docs/examples/ga-signoff.example.json ga-signoff.json
# docs/examples/runtime-preflight.example.json is schema-only; generate a fresh runtime-preflight.json with the command below.
NODE_ENV=production API_TOKEN=<prod-token> APP_MODE=controlled_auto_apply IRREVERSIBLE_ACTIONS_ENABLED=true STATE_BACKEND=postgres DATABASE_URL=<postgres-url> QUEUE_BACKEND=bullmq REDIS_URL=<redis-url> SECRETS_BACKEND=<approved-backend> PROVIDER_CONFIG_JSON='[{"providerId":"hh","enabled":true,"runtimeKind":"live","statusOverride":"stable","liveSubmitEndpoint":"<submit-endpoint>","liveSubmitAuthTokenEnv":"HH_SUBMIT_TOKEN"},{"providerId":"robota","enabled":true,"runtimeKind":"live","statusOverride":"stable","liveSubmitEndpoint":"<submit-endpoint>","liveSubmitAuthTokenEnv":"ROBOTA_SUBMIT_TOKEN"}]' HH_SUBMIT_TOKEN=<token> ROBOTA_SUBMIT_TOKEN=<token> OBJECT_STORAGE_BACKEND=s3_compatible OBJECT_STORAGE_S3_ENDPOINT=<s3-url> OBJECT_STORAGE_S3_BUCKET=<bucket> OBJECT_STORAGE_S3_REGION=<region> OBJECT_STORAGE_S3_ACCESS_KEY_ID=<access-key> OBJECT_STORAGE_S3_SECRET_ACCESS_KEY=<secret-key> TELEGRAM_BOT_TOKEN=<bot-token> TELEGRAM_ALLOWED_USER_IDS=<user-ids> TELEGRAM_WEBHOOK_SECRET=<webhook-secret> LLM_PROVIDER=openai-compatible LLM_API_BASE_URL=<llm-url> LLM_API_KEY=<llm-key> RUNTIME_PREFLIGHT_OUTPUT_PATH=runtime-preflight.json pnpm runtime:preflight
RELEASE_EVIDENCE_PATH=release-evidence.json pnpm release:evidence:validate
LIVE_PROOF_INPUTS_ASSERT_LIVE=true EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH=live-secrets-probe.json EXTERNAL_SECRETS_EVIDENCE_SOURCE=<live-workflow-url> CANARY_EVIDENCE_RESULTS_PATH=live-canary-results.json CANARY_EVIDENCE_SOURCE=<live-workflow-url> PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH=live-provider-submit-proof.json PROVIDER_SUBMIT_EVIDENCE_SOURCE=<live-workflow-url> CALENDAR_EVIDENCE_INPUT_PATH=live-calendar-smoke.json CALENDAR_EVIDENCE_SOURCE=<live-workflow-url> OUTBOUND_EVIDENCE_INPUT_PATH=live-dispatch-proof.json OUTBOUND_EVIDENCE_SOURCE=<live-workflow-url> SOAK_EVIDENCE_INPUT_PATH=live-7-day-soak.json SOAK_EVIDENCE_SOURCE=<live-workflow-url> RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json ACCEPTANCE_ITERATIONS=7 LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE=true pnpm roadmap:live-acceptance
RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json pnpm roadmap:completion-audit
```

The example files are schema-valid templates only. They include template/example markers or local-only skipped-probe preflight status that is rejected by the live gates, and must be replaced with real dated production evidence, a fresh production runtime preflight, and real approver decisions before sign-off. The runtime preflight report must be generated from the same production-shaped environment used for the final audit and be fresh within the audit window, 24 hours by default. When `TELEGRAM_BOT_TOKEN` is configured, that environment must also include `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_WEBHOOK_SECRET`. `pnpm roadmap:live-acceptance` runs runtime config, prerequisite live-input validation when both `LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE=true` and `LIVE_PROOF_INPUTS_ASSERT_LIVE=true` are set, release-evidence validation, GA sign-off validation, acceptance package, and roadmap completion audit as one fail-closed bundle gate. `pnpm acceptance:package`, `pnpm roadmap:live-acceptance`, and `pnpm roadmap:completion-audit` all exit non-zero until the required live evidence, preflight, release gates, and GA sign-off pass.

The package includes the fixture soak report, provider readiness, release evidence summary, release gate checks, GA sign-off checks, blockers, and residual risks. `pnpm roadmap:local-gates` is part of `pnpm verify` and checks roadmap coverage, docs-pack validity, queue resilience, and redacted live-handoff generation without requiring live evidence. `pnpm release:docs-pack` emits the final documentation-pack manifest for PRD, roadmap, ADRs, runbooks, provider playbooks, security docs, release notes, and verification artifacts. The live plan report is a companion handoff artifact for operators; it is not release evidence and cannot satisfy the final audit by itself. Each live plan action group includes blocking roadmap/PRD row references, so the production operator can trace a runtime, evidence, sign-off, or final-audit action back to the exact still-blocked rows. Its final-audit action group includes `pnpm roadmap:live-acceptance` before `pnpm roadmap:completion-audit` so operators can validate every required artifact layer in one report. Its release-evidence action group lists the prerequisite live proof files (`live-secrets-probe.json`, `live-canary-results.json`, `live-provider-submit-proof.json`, `live-calendar-smoke.json`, `live-dispatch-proof.json`, and `live-7-day-soak.json`) alongside the final `release-evidence.json` ledger; matching parseable input-shape examples live under `docs/examples/` with `.example.json` suffixes and are rejected as non-live examples until replaced with real external sources. `pnpm release:live-inputs:validate` checks the full prerequisite input bundle before any append command writes to the ledger.

## Required Final Evidence

- completed 7-day soak report with zero duplicates, 100% proof coverage, no state loss, no unsupported outbound facts, and incident/rollback drill flags;
- sample proof packs with policy, validation, audit event, idempotency hash, and pre/post proof references;
- sample outbound reply proof from a live transport, not fixture transport;
- sample final interview cards backed by calendar read/conflict/write checks;
- approved secrets backend access proof and safe secret-reference ids, never raw secret values;
- runtime preflight report with production env, Postgres, Redis, Telegram bot plus webhook-secret readiness, LLM, object storage, and secrets checks passing;
- final risk register review referenced from `ga-signoff.json`;
- product owner, engineering, operations, and security sign-off with issue-register, runbook-drill, residual-risk, and maintenance-plan evidence references.
- acceptance package JSON attached to the release record.
- [GA sign-off checklist](GA-signoff-checklist.md) completed.

## Decision

GA is not automatically granted by local tests. It is granted only after the soak template is completed with real run evidence.
