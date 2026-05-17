# PRD Compliance Matrix

Source PRD: `docs/prd/Telegram Job Search Automation v1.0.md`.

Status meanings:

- Implemented/tested: local-safe behavior exists and is covered by automated tests.
- Partial/local-safe: production-shaped contracts exist, but live integrations remain intentionally disabled.
- Deferred/external: blocked by real credentials, accounts, provider review, calendar/secrets/object-storage infrastructure, or live acceptance criteria.

| PRD Area | Status | Evidence |
|---|---|---|
| Local-safe architecture | Implemented/tested | pnpm monorepo, Fastify API, Telegram bot handlers, workers, domain/db/providers/automation/llm/config/observability/testing packages. |
| Fixture providers for `hh`, `robota`, `telegram` | Implemented/tested | Provider contract, fixtures, normalization, dry-run, replay, selector packs, page fingerprints, canary checks. No live scraping. |
| Candidate profile, resumes, facts, search profile | Implemented/tested | Domain schemas/defaults, resume routing, fact disclosure validation, availability and consent gates. |
| Ingest, normalization, scoring, dedup | Implemented/tested | Provider discovery/fetch/normalize, canonical URL dedup, content/company role keys, scoring matrices, search-run records. |
| Application draft generation | Implemented/tested | Resume route, cover letter validation, draft variant key, submit idempotency key, proof pack metadata, policy checks, manual review fallback. |
| Policy safety | Implemented/tested | Hard-deny vs approval-required gates, read-only/degraded provider write blocks, consent/proof/idempotency/validation/rate-limit checks. |
| Irreversible actions | Local-safe only | Submit/reply/interview-confirm paths remain blocked or review-first by default. No real submit/reply/confirm implementation is enabled. |
| Deterministic automation | Implemented/tested | State-machine runner, guards, selectors, fingerprints, CAPTCHA DOM/text/URL detection, submit-boundary dry-run, replay reports. |
| CAPTCHA/block safe mode | Implemented/tested locally | CAPTCHA/rate-limit/terms/anti-automation signals mark provider `needs_review`, create manual review, and stop automation. |
| Telegram control plane | Implemented/tested | `/start`, `/status`, `/pause`, `/resume_bot`, `/mode`, `/pipeline`, `/jobs_applied*`, `/job`, `/responses`, `/interviews`, `/sources`, `/profiles`, `/manual_review`, `/digest_now`, `/logs`. |
| API control plane | Implemented/tested | Authenticated endpoints for status, ingest, pipeline, providers, profiles, jobs, applications, manual review, audit, metrics, responses, interviews, digest. `/health` remains unauthenticated. |
| API/Telegram security defaults | Implemented/tested | Bearer or `X-API-Token` auth, configured CORS, production token/public bind guardrails, Telegram token requires allowlist. |
| Inbox/conversation classification | Implemented/tested locally | Fixture inbox sync, inbound dedup, conversation records, classification records, sensitive/low-confidence/manual-review fallback. |
| Outbound recruiter replies | Partial/local-safe | Message validation and idempotency contracts exist. Real dispatch remains disabled until provider/channel approval and templates are reviewed. |
| Interview coordination | Partial/local-safe | Slot extraction, availability checks, interview event records, Telegram/API read surfaces. Real calendar integration is deferred. |
| Proof artifacts | Implemented locally | Proof packs link to audit events and in-memory object artifact metadata. Durable object storage is represented by a local adapter stub. |
| DB schema and migrations | Implemented/tested | SQL mirror matches executable migrations, indexes for job/application/inbound idempotency, Docker Postgres migration test and `pnpm db:migrate`. |
| Queues | Partial/local-safe | Queue names, in-memory/BullMQ adapters, idempotent enqueue, redaction. Durable queue consumers/DLQ processing are later production enablement. |
| Observability | Implemented locally | Structured logs with recursive redaction, metrics registry, alert condition evaluator, queue depth surfaces. Prometheus/Grafana/Sentry are deferred. |
| LLM gateway safety | Implemented/tested locally | Mock structured gateway, Zod validation, canonical input hash, cross-field checks, prompt-injection flags for messages and cover-letter inputs. |
| Runbooks and smoke | Implemented/tested | Runbooks, README, `pnpm db:migrate`, `pnpm smoke:local`, worker smoke commands. |
| Live providers/accounts/Telegram/calendar/secrets | Deferred/external | Requires real credentials, provider-specific compliance review, selector canaries against live pages, secrets manager, calendar integration, and staged review-first rollout. |

Coverage target after this pass:

- Statements: 97.82%
- Lines: 97.91%
- Functions: 98.28%
- Branches: 90.07%

The remaining deferred items are intentionally not implemented in this local-safe phase because they require live external systems or would enable irreversible actions.
