# Telegram Job Search Automation Core

Local-safe implementation of the PRD in `docs/prd/Telegram Job Search Automation v1.0.md`.

## Safety Posture

- Default mode is `review_first`.
- `IRREVERSIBLE_ACTIONS_ENABLED=false` by default.
- API routes are bearer-token protected by default.
- Live Telegram requires both `TELEGRAM_BOT_TOKEN` and non-empty `TELEGRAM_ALLOWED_USER_IDS`.
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
API_PORT=3127 API_TOKEN=local-dev-token pnpm smoke:local
```

Worker smoke commands:

```bash
pnpm worker:ingest
pnpm worker:apply
pnpm worker:inbox
pnpm worker:digest
pnpm worker:canary
```

Runtime state is in-memory for this local-safe implementation. Restarting API, bot, or worker processes resets local records unless they are represented in the Docker Postgres migration tests.

## Apps

- `apps/api`: Fastify Control Plane API.
- `apps/telegram-bot`: Telegram adapter and testable command handlers.
- `apps/worker-ingest`: fixture discovery, normalization, dedup, scoring.
- `apps/worker-apply`: deterministic dry-run automation.
- `apps/worker-inbox`: fixture inbox classification and review fallback.
- `apps/worker-digest`: digest rendering.
- `apps/worker-canary`: provider canary stubs.

## Packages

- `packages/domain`: entities, schemas, policies, scoring, dedup, routing, conversation and interview logic.
- `packages/db`: migrations, in-memory local repository, queue abstraction.
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
- Confirm every irreversible action has policy check, validation, idempotency, audit event, and proof pack.
- Keep `TELEGRAM_ALLOWED_USER_IDS` non-empty whenever `TELEGRAM_BOT_TOKEN` is configured.
- Keep live submit/reply/interview-confirm disabled until provider credentials, canary results, and manual review acceptance criteria are signed off.
