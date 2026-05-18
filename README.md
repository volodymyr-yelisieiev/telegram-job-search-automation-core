# Telegram Job Search Automation Core

Local-safe implementation of the PRD in `docs/prd/Telegram Job Search Automation v1.0.md`.

## Safety Posture

- Default mode is `review_first`.
- `IRREVERSIBLE_ACTIONS_ENABLED=false` by default.
- API routes are bearer-token protected by default.
- Live Telegram requires `TELEGRAM_BOT_TOKEN`, non-empty `TELEGRAM_ALLOWED_USER_IDS`, and `TELEGRAM_WEBHOOK_SECRET` for the guarded API webhook.
- Providers are fixture-backed for `hh`, `robota`, and `telegram`.
- Browser automation is deterministic state-machine dry-run only.
- CAPTCHA, blocking, selector mismatch, unsupported facts, duplicate attempts, and low-confidence messages stop into review instead of being bypassed.

## Quick Start

```bash
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm verify
API_TOKEN=local-dev-token pnpm api
```

Useful local endpoints:

- `GET http://127.0.0.1:3000/health`
- `POST http://127.0.0.1:3000/ingest/run`
- `GET http://127.0.0.1:3000/pipeline`
- `GET http://127.0.0.1:3000/status/telegram`

All routes except `/health` require `Authorization: Bearer local-dev-token` or `X-API-Token: local-dev-token`.

Redis is exposed on host port `6380` by default to avoid colliding with a local Redis already using `6379`.

Coverage is part of verification and enforced globally at statements 95%, lines 95%, functions 95%, branches 90%:

```bash
pnpm test:coverage
```

Full local smoke:

```bash
docker compose up -d postgres redis
STATE_BACKEND=postgres API_PORT=3127 API_TOKEN=local-dev-token pnpm smoke:local
```

Accelerated local soak:

```bash
SOAK_ITERATIONS=7 pnpm soak:fixture
STRESS_JOBS=10000 pnpm soak:read-only-stress
pnpm queue:resilience
```

R8 acceptance package:

```bash
ACCEPTANCE_ITERATIONS=7 pnpm acceptance:package
pnpm roadmap:compliance
pnpm roadmap:local-gates
pnpm release:docs-pack
pnpm release:live-plan
pnpm roadmap:completion-audit
cp docs/examples/release-evidence.example.json release-evidence.json
cp docs/examples/ga-signoff.example.json ga-signoff.json
# docs/examples/runtime-preflight.example.json is schema-only; generate a fresh runtime-preflight.json with the command below.
NODE_ENV=production API_TOKEN=<prod-token> APP_MODE=controlled_auto_apply IRREVERSIBLE_ACTIONS_ENABLED=true STATE_BACKEND=postgres DATABASE_URL=<postgres-url> QUEUE_BACKEND=bullmq REDIS_URL=<redis-url> SECRETS_BACKEND=<approved-backend> PROVIDER_CONFIG_JSON='[{"providerId":"hh","enabled":true,"runtimeKind":"live","statusOverride":"stable","liveSubmitEndpoint":"<submit-endpoint>","liveSubmitAuthTokenEnv":"HH_SUBMIT_TOKEN"},{"providerId":"robota","enabled":true,"runtimeKind":"live","statusOverride":"stable","liveSubmitEndpoint":"<submit-endpoint>","liveSubmitAuthTokenEnv":"ROBOTA_SUBMIT_TOKEN"}]' HH_SUBMIT_TOKEN=<token> ROBOTA_SUBMIT_TOKEN=<token> OBJECT_STORAGE_BACKEND=s3_compatible OBJECT_STORAGE_S3_ENDPOINT=<s3-url> OBJECT_STORAGE_S3_BUCKET=<bucket> OBJECT_STORAGE_S3_REGION=<region> OBJECT_STORAGE_S3_ACCESS_KEY_ID=<access-key> OBJECT_STORAGE_S3_SECRET_ACCESS_KEY=<secret-key> TELEGRAM_BOT_TOKEN=<bot-token> TELEGRAM_ALLOWED_USER_IDS=<user-ids> TELEGRAM_WEBHOOK_SECRET=<webhook-secret> LLM_PROVIDER=openai-compatible LLM_API_BASE_URL=<llm-url> LLM_API_KEY=<llm-key> RUNTIME_PREFLIGHT_OUTPUT_PATH=runtime-preflight.json pnpm runtime:preflight
LLM_PROVIDER=openai-compatible LLM_API_BASE_URL=<llm-url> LLM_API_KEY=<llm-key> LLM_MODEL=<model> LLM_SMOKE_CONFIRM_LIVE=true LLM_SMOKE_ASSERT_LIVE=true pnpm llm:smoke
SECRETS_BACKEND=local_encrypted_file LOCAL_SECRET_STORE_ROOT=./var/secrets LOCAL_SECRET_STORE_MASTER_KEY=<managed-key> SECRET_STORE_PROBE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm secrets:probe
EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH=live-secrets-probe.json EXTERNAL_SECRETS_EVIDENCE_SOURCE=<live-workflow-url> EXTERNAL_SECRETS_EVIDENCE_ASSERT_LIVE=true EXTERNAL_SECRETS_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm secrets:evidence
CANARY_EVIDENCE_RESULTS_PATH=live-canary-results.json CANARY_EVIDENCE_SOURCE=<live-workflow-url> CANARY_EVIDENCE_ASSERT_LIVE=true CANARY_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm canary:evidence
CANARY_SMOKE_TARGETS_JSON='<targets-json>' CANARY_SMOKE_EXPECTED_PROVIDER_IDS=hh,robota,telegram CANARY_SMOKE_SOURCE=<live-workflow-url> CANARY_SMOKE_CONFIRM_LIVE=true CANARY_EVIDENCE_ASSERT_LIVE=true CANARY_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json TELEGRAM_BOT_TOKEN=<bot-token> pnpm canary:live-smoke
CALENDAR_EVIDENCE_INPUT_PATH=live-calendar-smoke.json CALENDAR_EVIDENCE_SOURCE=<live-workflow-url> CALENDAR_EVIDENCE_ASSERT_LIVE=true CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm calendar:evidence
GOOGLE_CALENDAR_ACCESS_TOKEN=<oauth-token> GOOGLE_CALENDAR_ID=<calendar-id> GOOGLE_CALENDAR_SMOKE_TIME_MIN=<iso-start> GOOGLE_CALENDAR_SMOKE_TIME_MAX=<iso-end> GOOGLE_CALENDAR_SMOKE_SOURCE=<live-workflow-url> GOOGLE_CALENDAR_SMOKE_CONFIRM_LIVE=true CALENDAR_EVIDENCE_ASSERT_LIVE=true CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm google-calendar:smoke
PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH=live-provider-submit-proof.json PROVIDER_SUBMIT_EVIDENCE_SOURCE=<live-workflow-url> PROVIDER_SUBMIT_EVIDENCE_ASSERT_LIVE=true PROVIDER_SUBMIT_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm provider-submit:evidence
OUTBOUND_EVIDENCE_INPUT_PATH=live-dispatch-proof.json OUTBOUND_EVIDENCE_SOURCE=<live-workflow-url> OUTBOUND_EVIDENCE_ASSERT_LIVE=true OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm outbound:evidence
TELEGRAM_BOT_TOKEN=<bot-token> TELEGRAM_DISPATCH_CHAT_ID=<chat-id> TELEGRAM_DISPATCH_TEXT=<approved-text> TELEGRAM_DISPATCH_SOURCE=<live-workflow-url> TELEGRAM_DISPATCH_CONFIRM_LIVE=true OUTBOUND_EVIDENCE_ASSERT_LIVE=true OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm telegram:dispatch-smoke
SOAK_EVIDENCE_INPUT_PATH=live-7-day-soak.json SOAK_EVIDENCE_SOURCE=<live-workflow-url> SOAK_EVIDENCE_ASSERT_LIVE=true SOAK_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm soak:evidence
GA_SIGNOFF_PATH=ga-signoff.json pnpm ga-signoff:validate
NODE_ENV=production API_TOKEN=<prod-token> APP_MODE=controlled_auto_apply IRREVERSIBLE_ACTIONS_ENABLED=true STATE_BACKEND=postgres DATABASE_URL=<postgres-url> QUEUE_BACKEND=bullmq REDIS_URL=<redis-url> SECRETS_BACKEND=<approved-backend> PROVIDER_CONFIG_JSON='[{"providerId":"hh","enabled":true,"runtimeKind":"live","statusOverride":"stable","liveSubmitEndpoint":"<submit-endpoint>","liveSubmitAuthTokenEnv":"HH_SUBMIT_TOKEN"},{"providerId":"robota","enabled":true,"runtimeKind":"live","statusOverride":"stable","liveSubmitEndpoint":"<submit-endpoint>","liveSubmitAuthTokenEnv":"ROBOTA_SUBMIT_TOKEN"}]' HH_SUBMIT_TOKEN=<token> ROBOTA_SUBMIT_TOKEN=<token> OBJECT_STORAGE_BACKEND=s3_compatible OBJECT_STORAGE_S3_ENDPOINT=<s3-url> OBJECT_STORAGE_S3_BUCKET=<bucket> OBJECT_STORAGE_S3_REGION=<region> OBJECT_STORAGE_S3_ACCESS_KEY_ID=<access-key> OBJECT_STORAGE_S3_SECRET_ACCESS_KEY=<secret-key> TELEGRAM_BOT_TOKEN=<bot-token> TELEGRAM_ALLOWED_USER_IDS=<user-ids> TELEGRAM_WEBHOOK_SECRET=<webhook-secret> LLM_PROVIDER=openai-compatible LLM_API_BASE_URL=<llm-url> LLM_API_KEY=<llm-key> RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json pnpm roadmap:completion-audit
```

`pnpm roadmap:local-gates` is included in `pnpm verify` and CI. It compactly checks roadmap matrix coverage, the final documentation pack, and redacted live-handoff generation without requiring external live evidence. `pnpm roadmap:completion-audit` is expected to fail until all external live evidence, real GA sign-off, and a production-shaped runtime envelope are present. `pnpm release:live-plan` reads the same audit and emits a redacted handoff plan with missing artifacts, missing live checks, required env key names, and the exact evidence commands still needed; it never creates evidence or prints secret values. The audit parses the live evidence/sign-off/preflight files when they exist, then runs aggregate release-gate and acceptance-package checks; file presence alone is not enough. The audit reports `requiredLiveChecks` and `missingLiveChecks` per local-safe/external roadmap row, and the production envelope must include `NODE_ENV=production`, `STATE_BACKEND=postgres` with `DATABASE_URL`, `QUEUE_BACKEND=bullmq` with `REDIS_URL`, a non-env `SECRETS_BACKEND`, explicit `PROVIDER_CONFIG_JSON` disable-switch coverage for enabled auto-apply providers, live-submit endpoints plus configured token env vars for irreversible provider submit runtime, S3-compatible object storage for irreversible proof artifacts, live Telegram credentials plus a guarded webhook secret, `IRREVERSIBLE_ACTIONS_ENABLED=true` in an enabled automation mode, a configured non-mock LLM provider, and a matching `runtime-preflight.json` generated by `pnpm runtime:preflight` inside the default 24-hour freshness window. The audit also requires each expected preflight check/probe to be present and passed. The preflight validates BullMQ queue backend selection, live submit runtime config, and S3-compatible storage with a small write/read/delete roundtrip, and records only hashes/booleans for submit endpoints, token env names, endpoint, bucket, access key id, and secret presence. Telegram webhook readiness is recorded as a boolean/hash only; raw bot tokens and webhook secrets are not emitted. Set `RUNTIME_PREFLIGHT_MAX_AGE_HOURS` on the audit command to use a narrower or wider window. If `SECRETS_BACKEND=local_encrypted_file`, `LOCAL_SECRET_STORE_ROOT` and `LOCAL_SECRET_STORE_MASTER_KEY` must be set before irreversible production use. Fill `release-evidence.json` with real dated production evidence and `ga-signoff.json` with real approver decisions plus `evidenceRefs` for the issue register, runbook drill report, residual-risk record, and maintenance plan before validating. `docs/examples/runtime-preflight.example.json` is schema-only and intentionally fails because it is local, skipped external probes, and is not fresh production evidence. The example files contain template markers, example names, and example evidence references that are intentionally rejected by live gates until replaced:

```bash
RELEASE_EVIDENCE_PATH=release-evidence.json pnpm release:evidence:validate
```

The validator checks the release evidence ledger without running the soak, and provider readiness in release/acceptance reports is derived from current live canary evidence plus explicit provider configs rather than static selector metadata alone. In production, missing canary, replay, or provider config evidence is reported as `canary_missing`, `replay_missing`, or `disable_switch_missing`; local fixture metadata is only a local diagnostic shortcut. Release and acceptance reports also fail closed when the runtime envelope is not production-shaped. `pnpm runtime:preflight` proves the durable proof-artifact store by creating, reading, and deleting a temporary S3-compatible object when that backend is configured. `pnpm llm:smoke` performs a live OpenAI-compatible structured JSON diagnostics call only when `LLM_SMOKE_CONFIRM_LIVE=true` and `LLM_SMOKE_ASSERT_LIVE=true`; the report stores model/prompt/input hashes and validation status, not API keys, prompts, or raw endpoint URLs. `pnpm secrets:probe` checks the configured local encrypted secret store and can upsert a 24-hour `external_secrets_backend` release-evidence record when `SECRET_STORE_PROBE_APPEND_RELEASE_EVIDENCE=true` and `RELEASE_EVIDENCE_PATH` are set; use `SECRET_STORE_PROBE_EVIDENCE_TTL_HOURS` to change that TTL. When the store contains current safe references for every expected provider plus a Telegram bot credential, it also upserts 24-hour `live_credentials_configured`; set `SECRET_STORE_PROBE_REQUIRE_CREDENTIALS=true` to fail the probe if that inventory is incomplete. `pnpm secrets:evidence` converts an externally captured managed secret-store probe for `vault`, `aws_secrets_manager`, `gcp_secret_manager`, or `local_encrypted_file` into the same expiring release evidence, hashes backend scope values, rejects raw secret-like input fields, and can add `live_credentials_configured` from safe secret-reference handles. `pnpm canary:evidence` converts an externally captured live canary result file into per-provider `live_canary_passed` records only when a non-fixture source and `CANARY_EVIDENCE_ASSERT_LIVE=true` are supplied; canary records expire after 24 hours by default and can use `CANARY_EVIDENCE_TTL_HOURS` for a different TTL. `pnpm canary:live-smoke` executes read-only live canaries itself from `CANARY_SMOKE_TARGETS_JSON`: HTTP targets perform GET/status/text checks, Telegram targets call `getMe`, and the report stores hashes instead of raw URLs, tokens, or expected text. `pnpm provider-submit:evidence` converts externally captured first-provider submit proof into `provider_submit_proof_ready` only when it has provider transport, `send_application`, submitted status, hashed idempotency, approved draft hash, submitted timestamp, a live source, and no raw application payload; generated submit evidence expires 24 hours after submission by default and can use `PROVIDER_SUBMIT_EVIDENCE_TTL_HOURS`. `pnpm calendar:evidence` converts externally captured checks into `calendar_integration_ready`. `pnpm google-calendar:smoke` is the executable Google Calendar path: with explicit live confirmation it performs freeBusy read, creates a temporary event, verifies the conflict via freeBusy, deletes the event, emits only hashes for calendar/event identifiers, and can append 24-hour `calendar_integration_ready`. `pnpm outbound:evidence` converts a live sent dispatch proof into `outbound_dispatch_proof_ready` only when the proof has a live transport, sent status, hashed idempotency/text values, `deliveredAt`, and a future `expiresAt`; generated dispatch evidence expires 24 hours after delivery by default and can use `OUTBOUND_EVIDENCE_TTL_HOURS`. `pnpm telegram:dispatch-smoke` is the executable Telegram transport smoke path: it sends only when `TELEGRAM_DISPATCH_CONFIRM_LIVE=true` and `OUTBOUND_EVIDENCE_ASSERT_LIVE=true`, records hashes instead of raw text/chat ids, and can append expiring `outbound_dispatch_proof_ready` directly. `pnpm soak:evidence` converts a real 7-day soak artifact only when `startedAt`/`completedAt` prove at least seven elapsed days and the duplicate, proof coverage, state-loss, unsupported-fact, and drill counters satisfy the release gate; soak evidence expires 30 days after `completedAt` by default and can use `SOAK_EVIDENCE_TTL_DAYS`. The acceptance package emits JSON with fixture soak results, provider readiness, release evidence, release gates, and GA sign-off blockers, and the CLI exits non-zero whenever that package is not accepted. Local runs are expected to keep live automation blocked until external evidence and explicit sign-off are recorded.

Approved submit can call an audited live submit executor when the provider config uses `runtimeKind: "live"`, `liveSubmitEndpoint`, and `liveSubmitAuthTokenEnv`. The worker regenerates the approved draft payload, rechecks its content hash, records only proof metadata, and records provider-submit release evidence only after the executor returns submitted proof. The runtime preflight records only hashes/booleans for live submit config.

Provider expansion:

```bash
pnpm provider:scaffold example-provider
```

Worker smoke commands:

```bash
pnpm worker:ingest
pnpm worker:apply
APPROVED_SUBMIT_APPLICATION_ID=<application-id> pnpm worker:apply
pnpm worker:inbox
pnpm worker:reply
pnpm worker:digest
pnpm worker:canary
```

Runtime state defaults to in-memory for local-safe development. For durable production-shaped runs, set `STATE_BACKEND=postgres`; API and worker entrypoints will apply migrations, seed the default profile/search profile, hydrate persisted state, and flush writes to Postgres before shutdown.

Queueing defaults to `QUEUE_BACKEND=memory` for local-safe runs. Production-shaped runs should set `QUEUE_BACKEND=bullmq` with `REDIS_URL`; API, Telegram approval enqueue, and queue-capable worker entrypoints use the shared runtime queue factory. BullMQ jobs carry typed payload metadata so worker consumers can reconstruct the same `QueueTask`, persist task-run lifecycle, and hand retryable failures back to BullMQ retry policy.

```bash
STATE_BACKEND=postgres DATABASE_URL=postgres://job_search:job_search@127.0.0.1:5432/job_search API_TOKEN=local-dev-token pnpm api
```

## Apps

- `apps/api`: Fastify Control Plane API.
- `apps/telegram-bot`: Telegram adapter and testable command handlers.
- `apps/worker-ingest`: fixture discovery, normalization, dedup, scoring.
- `apps/worker-apply`: deterministic dry-run automation.
- `apps/worker-inbox`: fixture inbox classification and review fallback.
- `apps/worker-reply`: reply draft generation, policy checks, contradiction guard, and outbound proof recording.
- `apps/worker-digest`: digest rendering.
- `apps/worker-canary`: provider fixture canary checks.

## Packages

- `packages/domain`: entities, schemas, policies, scoring, dedup, routing, conversation and interview logic.
- `packages/db`: migrations, in-memory local repository, queue abstraction, history-backed rate-limit evaluators.
- `packages/providers`: fixture provider modules, selector packs, fingerprints.
- `packages/automation`: deterministic browser flow runner.
- `packages/llm`: schema-validating mock LLM gateway.
- `packages/telegram-ui`: Telegram cards and command renderers.
- `packages/config`: environment loader.
- `packages/observability`: structured logs, metrics, alerts.
- `packages/testing`: shared test fixtures.

## Production Enablement Checklist

Before live auto-apply:

- Configure real secrets outside repo.
- Add real provider account sessions through a secrets store.
- Run provider onboarding checklist from the PRD.
- Prove selector packs and fingerprints against fixtures and canaries.
- Keep first N actions in review-first mode.
- Confirm every irreversible action has policy check, history-backed rate-limit check, validation, idempotency, audit event, and proof pack.
- Keep `TELEGRAM_ALLOWED_USER_IDS` non-empty whenever `TELEGRAM_BOT_TOKEN` is configured, and set `TELEGRAM_WEBHOOK_SECRET` before exposing the API webhook.
- Keep live submit/reply/interview-confirm disabled until provider credentials, canary results, and manual review acceptance criteria are signed off.
