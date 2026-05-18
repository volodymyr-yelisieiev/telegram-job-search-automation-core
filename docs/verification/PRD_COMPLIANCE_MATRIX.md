# PRD Compliance Matrix

Source PRD: `docs/prd/Telegram Job Search Automation v1.0.md`.

Status meanings:

- Implemented/tested: local-safe behavior exists and is covered by automated tests.
- Partial/local-safe: production-shaped contracts exist, but live integrations remain intentionally disabled.
- Deferred/external: blocked by real credentials, accounts, provider review, calendar/secrets/object-storage infrastructure, or live acceptance criteria.

| PRD Area | Status | Evidence |
|---|---|---|
| Local-safe architecture | Implemented/tested | pnpm monorepo, Fastify API, Telegram bot handlers, workers, domain/db/providers/automation/llm/config/observability/testing packages. |
| Fixture providers for `hh`, `robota`, `telegram` | Implemented/tested | Provider contract, fixtures, normalization, dry-run, replay, selector packs, page fingerprints, runtime canary/readiness checks. No live scraping. |
| Candidate profile, resumes, facts, search profile | Implemented/tested | Domain schemas/defaults, resume routing, fact disclosure validation, availability and consent gates. |
| Ingest, normalization, scoring, dedup | Implemented/tested | Provider discovery/fetch/normalize, canonical URL dedup, content/company role keys, scoring matrices, search-run records with query/filter/error accounting in API and worker paths. |
| Application draft generation | Implemented/tested | Resume route, cover letter validation, draft variant key, submit idempotency key, matching submit-boundary proof pack metadata, fresh canary gate, policy checks, manual review fallback. |
| Policy safety | Implemented/tested | Hard-deny vs approval-required gates, read-only/degraded provider write blocks, consent/proof/idempotency/validation checks, and history-backed application/reply rate-limit checks. |
| Irreversible actions | Local-safe only | Submit/reply/interview-confirm paths remain blocked or review-first by default. Approved submit can be routed to an audited live submit executor only after exact approved draft hash revalidation, but real provider execution still requires credentials, canaries, release evidence, and GA sign-off. |
| Deterministic automation | Implemented/tested | State-machine runner, guards, selectors, fingerprints, CAPTCHA DOM/text/URL detection, submit-boundary dry-run, replay reports. |
| CAPTCHA/block safe mode | Implemented/tested locally | CAPTCHA/rate-limit/terms/anti-automation signals mark provider `needs_review`, create manual review, and stop automation. |
| Telegram control plane | Implemented/tested | `/start`, `/status`, `/pause`, `/resume_bot`, `/mode`, `/pipeline`, `/jobs_applied*`, `/job`, priority-grouped `/responses`, `/availability`, `/interviews` list/detail, `/sources`, `/profiles`, `/manual_review`, `/digest_now`, `/logs`; API webhook intake routes these commands through the same handler. |
| API control plane | Implemented/tested | Authenticated endpoints for status, ingest, pipeline, providers, profiles, jobs, applications, manual review, audit, metrics, responses, interviews, digest. `/health` remains unauthenticated. |
| API/Telegram security defaults | Implemented/tested | Bearer or `X-API-Token` auth, configured CORS, production token/public bind guardrails, Telegram token requires allowlist, guarded webhook secret, and allowed sender checks. |
| Inbox/conversation classification | Implemented/tested locally | Fixture inbox sync, inbound dedup, conversation records, classification records, sensitive/low-confidence/manual-review fallback. |
| Outbound recruiter replies | Partial/local-safe | Message validation, idempotency, expiring proof evidence, audit, conservative follow-up review planning, and explicit live transport readiness guard exist. Real dispatch remains disabled until provider/channel approval and templates are reviewed. |
| Interview coordination | Partial/local-safe | Slot extraction, availability checks, interview event records, Telegram/API read surfaces, local event busy windows, read-only ICS calendar export conflict checks, and explicit-confirm Google Calendar smoke for read/write/conflict/delete evidence. Real scheduling writes remain deferred until live evidence and approval exist. |
| Proof artifacts | Implemented/local-safe | Proof packs link to audit events and object artifact metadata. In-memory, filesystem-backed, and S3-compatible object storage adapters cover local tests and production-shaped durable artifact writes/readbacks/deletes; runtime preflight performs a temporary S3-compatible roundtrip and production irreversible config blocks filesystem-only proof storage. |
| DB schema and migrations | Implemented/tested | SQL mirror matches executable migrations, indexes for job/application/inbound idempotency, Docker Postgres migration test and `pnpm db:migrate`. |
| Queues | Implemented/local-safe | Queue names, in-memory/BullMQ adapters with fail-closed payload schemas, `QUEUE_BACKEND` runtime factory, idempotent enqueue, oldest-age reporting, worker execution wrapper, task-run store, redaction, DLQ assign/resolve/discard/retry, and resilience check. |
| Observability | Implemented locally | Structured logs with recursive redaction, metrics registry, JSON and Prometheus text metrics endpoints, alert condition evaluator, queue depth/oldest-age surfaces, and outbound reply safety alerts. Grafana/Sentry wiring is deployment-specific. |
| LLM gateway safety | Implemented/tested locally | Mock structured gateway, Zod validation, canonical input hash, cross-field checks, prompt-injection flags for messages and cover-letter inputs. |
| Runbooks and smoke | Implemented/tested | Runbooks, README, `pnpm db:migrate`, `pnpm smoke:local`, worker smoke commands. |
| Live providers/accounts/Telegram/calendar/secrets | Deferred/external | Requires real credentials, guarded Telegram webhook secret, provider-specific compliance review, selector canaries against live pages, secrets manager, calendar integration, staged review-first rollout, and real GA sign-off. Release evidence with weak metadata is rejected, and live acceptance stays blocked without `GA_SIGNOFF_PATH`. |

Latest local coverage after the roadmap pass:

- Statements: 98.72%
- Lines: 98.88%
- Functions: 98.5%
- Branches: 90.22%

The remaining deferred items are intentionally not implemented in this local-safe phase because they require live external systems or would enable irreversible actions.
