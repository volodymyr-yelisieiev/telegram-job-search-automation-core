---
title: "Implementation Roadmap and Sprint Plan: Telegram Job Search Automation Core"
subtitle: "Extensive phase-by-phase and sprint-by-sprint execution plan with Definitions of Done"
author: "Prepared for product and engineering"
date: "2026-05-17"
lang: ru-RU
---

# Контроль документа

| Поле | Значение |
|---|---|
| Документ | Implementation Roadmap and Sprint Plan |
| Продукт | Telegram Job Search Automation Core |
| Версия | 1.0 |
| Дата | 2026-05-17 |
| Статус | Development execution draft |
| Основание | Первичное ТЗ, PRD v1.0, текущий public repository baseline |
| Главная цель | Разбить путь до финального продукта на фазы, спринты, deliverables, Definition of Done и release gates |
| Repository reference | https://github.com/volodymyr-yelisieiev/telegram-job-search-automation-core |

# 1. Executive summary

Этот документ превращает PRD в рабочий delivery plan. Он описывает полный путь от текущей local-safe реализации к финальному production-продукту: постоянно работающей системе, которая через Telegram управляет job-search pipeline от поиска вакансий до назначения live interview.

Главное допущение: репозиторий уже содержит local-safe TypeScript монорепозиторий с API, Telegram adapter, worker-ами, packages для domain/db/providers/automation/LLM/UI/config/observability/testing, fixture-backed provider-ами и deterministic dry-run automation. Это не финальное production-состояние. Roadmap строится как переход от этого безопасного baseline к durable, observable, proof-bearing, controlled production automation.

Ключевой принцип остается тем же, что в PRD: продукт не является generic autonomous agent runtime. Production поведение должно быть deterministic-first, LLM-last. LLM помогает извлекать, классифицировать, суммировать и генерировать текст, но не кликает, не подтверждает интервью, не отправляет сообщения и не submit-ит applications без policy/validation/proof gate.

# 2. Как читать этот документ

Документ предназначен для product owner, tech lead, backend/provider engineers, QA, DevOps/Ops и любого разработчика, которому нужно взять задачу без дополнительного discovery.

Каждый спринт содержит:

- цель спринта;
- конкретные deliverables;
- work packages с ticket IDs;
- testing and QA expectations;
- sprint Definition of Done;
- exit gate: что должно быть правдой, чтобы двигаться дальше.

Спринты описаны как reference plan для 2-недельного cadence. Это не обещание календарной длительности. При сильной команде часть спринтов можно параллелить; при малой команде отдельные спринты могут растягиваться. Главное - не нарушать порядок release gates: read-only -> dry-run -> review-first -> controlled automation -> final production.

# 3. Текущий baseline и последствия для roadmap

## 3.1. Наблюдаемое состояние repository baseline

Текущий repository baseline трактуется как **local-safe implementation**, а не как production-ready deployment. В нем уже есть структура, которая полезна для дальнейшей работы:

- apps/api: control plane API;
- apps/telegram-bot: Telegram adapter and command handlers;
- apps/worker-ingest: fixture discovery, normalization, dedup, scoring;
- apps/worker-apply: deterministic dry-run automation;
- apps/worker-inbox: fixture inbox classification and review fallback;
- apps/worker-digest: digest rendering;
- apps/worker-canary: provider canary stubs;
- packages/domain: entities, schemas, policies, scoring, dedup, routing, conversation and interview logic;
- packages/db: migrations, in-memory local repository, queue abstraction;
- packages/providers: fixture provider modules, selector packs, fingerprints;
- packages/automation: deterministic browser flow runner;
- packages/llm: schema-validating mock LLM gateway;
- packages/telegram-ui: Telegram cards and command renderers;
- packages/config, packages/observability, packages/testing.

## 3.2. Текущие production blockers

Roadmap исходит из того, что следующие вещи должны быть доведены до production-grade качества:

1. In-memory runtime state должен быть заменен durable Postgres-backed state для production path.
2. Fixture-backed providers должны быть заменены или дополнены real provider modules с read-only, dry-run, canary and controlled submit gates.
3. Mock LLM gateway должен стать controlled LLM gateway with schema validation, redaction, versioning and evals.
4. Browser automation должна пройти путь: fixtures -> dry-run -> canary -> review-first submit -> controlled auto-apply.
5. Every irreversible action должен иметь policy check, validation result, idempotency key, audit event and proof pack.
6. Telegram UI должен стать полноценным control plane: status, pause, modes, manual review, applied jobs, responses, interviews, logs.
7. Observability, security, deployment, rollback and runbooks должны быть такими же важными deliverables, как feature code.

# 4. Delivery model

## 4.1. Recommended sprint cadence

- Sprint length: 2 weeks.
- Release review: в конце каждого release gate, не обязательно в конце каждого sprint.
- Planning input: PRD + current repository state + previous sprint evidence.
- Sprint output: merged code, tests, documentation, metrics, runbooks and release notes where applicable.
- Production philosophy: no hidden irreversible behavior; every action is gated, observable and reversible where technically possible.

## 4.2. Suggested roles

| Role | Responsibility |
|---|---|
| Product owner | Strategy, acceptance criteria, profile/fact policy decisions, prioritization |
| Tech lead | Architecture, ADRs, code quality, release gates |
| Backend engineer | API, domain, DB, queues, policy, scoring, data model |
| Provider automation engineer | Provider modules, Playwright flows, selectors, fingerprints, canaries, replay |
| LLM/prompt engineer | LLM gateway, schemas, evaluation, prompt injection controls, generation quality |
| QA engineer | Test plans, fixture regression, integration, browser dry-run, soak, acceptance evidence |
| DevOps/Ops | CI/CD, environments, secrets, observability, incidents, runbooks |
| Security reviewer | Secrets, access control, logging, artifact retention, snippet/license review |

## 4.3. Release gates

| Gate | Name | Meaning |
|---|---|---|
| R0 | Delivery baseline | Planning, durable data/queues/control plane foundations are clear and safe |
| R1 | Profile/policy/intelligence | Candidate profile, fact registry, policy engine, LLM gateway and manual review are ready |
| R2 | Read-only MVP | System can discover, normalize, dedup, score and explain jobs without irreversible actions |
| R3 | Dry-run automation | Browser flows reach submit boundary only, with selectors/fingerprints/canary/replay |
| R4 | Controlled auto-apply | Applications can be generated and submitted under strict review/control/proof gates |
| R5 | Conversation automation | Inbound messages are linked/classified; safe replies can be drafted/sent under policy |
| R6 | Interview coordination | Scheduling requests can be handled up to final interview card |
| R7 | Production readiness | Observability, security, deployment, rollback and analytics are production-grade |
| R8 | GA candidate | 7-day continuous acceptance run passes final product criteria |

## 4.4. Phase overview

| Phase | Sprints | Output |
|---|---:|---|
| Phase 0 - Delivery foundation | 0-3 | Durable delivery baseline, data/queue/control plane safety. |
| Phase 1 - Profile, policy and safe intelligence | 4-7 | Validated candidate profile, policy engine, LLM boundaries, manual review UX. |
| Phase 2 - Read-only ingest and scoring | 8-14 | Stable read-only job discovery, normalization, dedup, scoring and pipeline visibility. |
| Phase 3 - Deterministic browser automation dry-run | 15-20 | State-machine browser automation to submit boundary, canary, replay and diagnostics. |
| Phase 4 - Application generation and controlled auto-apply | 21-25 | Resume routing, cover letters, proof packs, review-first submit and controlled auto-apply. |
| Phase 5 - Conversation automation | 26-30 | Inbox sync, classification, reply drafting, review-first dispatch, controlled auto-replies and follow-ups. |
| Phase 6 - Interview coordination | 31-33 | Availability, slot extraction, scheduling replies, interview event and final interview card. |
| Phase 7 - Production hardening, analytics and final product | 34-38 | Observability, security, deployment, optimization and GA acceptance. |
| Phase 8 - Post-GA scaling and provider expansion | 39-39 | Provider onboarding factory and long-term maintenance model. |

# 5. Global Definition of Ready

A feature story is ready for implementation only when all of the following are true:

- Business goal is clear.
- Entity/state transitions affected by the story are named.
- Inputs and outputs are typed or schematized.
- Safety mode impact is known: read_only, dry_run, review_first, controlled_auto_apply, full_auto_apply, conversation_only or paused.
- Irreversible action impact is explicitly stated.
- Policy engine interaction is known or explicitly not applicable.
- Audit events are specified or explicitly not applicable.
- Metrics/alerts are specified or explicitly not applicable.
- Test type is specified: unit, contract, integration, fixture, browser dry-run, canary, replay, soak.
- Acceptance criteria are written in observable terms.
- Rollback or safe failure behavior is known.

# 6. Global Definition of Done

A feature is done only when:

1. Implementation is complete and merged.
2. Unit tests pass.
3. Contract/integration tests pass where relevant.
4. No TypeScript errors.
5. Lint passes with zero warnings where repository policy requires it.
6. Coverage does not regress below configured thresholds.
7. Database migrations are tested if schema changed.
8. Queue behavior is idempotent if task execution changed.
9. Policy checks are added for any action that can affect user/provider/recruiter state.
10. Audit event is added for state changes and all irreversible actions.
11. Metrics are added for important successes/failures/latencies.
12. Error handling maps to canonical error taxonomy.
13. Telegram/API UX is tested if user-visible.
14. Sensitive data is not logged.
15. Documentation/runbook is updated if operation changed.
16. Release notes mention risk and rollback if production behavior changed.

# 7. Special Definitions of Done

## 7.1. Provider DoD

A provider is production-ready only if:

- read-only ingest is stable;
- normalization confidence is measured;
- dedup keys are implemented;
- selector pack is versioned;
- page fingerprints are versioned;
- dry-run reaches submit boundary for supported cases;
- canary passes;
- replay is available for failures;
- provider errors map to taxonomy;
- rate limits are configured;
- proof pack works where irreversible actions exist;
- manual fallback exists;
- no CAPTCHA or anti-automation bypass exists;
- provider can be disabled independently.

## 7.2. Auto-apply DoD

Auto-apply is ready only if:

- provider status is stable;
- recent canary passed;
- dry-run success target is met;
- apply policy allows action;
- dedup and idempotency pass;
- rate limits pass;
- resume and cover letter validation pass;
- proof capture readiness passes;
- confirmation capture works;
- rollback to review_first/read_only works;
- 100% applied statuses have proof packs.

## 7.3. Auto-reply DoD

Auto-reply is ready only if:

- message category is supported;
- classification confidence meets threshold;
- template exists;
- fact registry mapping exists;
- outbound validation passes;
- thread contradiction check passes;
- provider/channel dispatch is supported;
- delivery proof is captured;
- manual review fallback works;
- no sensitive/unsupported/legal category is auto-sent.

## 7.4. Interview scheduling DoD

Scheduling automation is ready only if:

- availability rules are validated;
- timezone is unambiguous;
- proposed slot is inside allowed windows;
- no conflict exists;
- min notice and max interviews/day pass;
- scheduling reply template passes validation;
- interview event is persisted;
- user receives final card only when required fields are present;
- no interview is confirmed outside policy.

# 8. Sprint index

| Sprint | Phase | Name | Release gate |
|---:|---|---|---|
| 0 | Phase 0 - Delivery foundation | Baseline audit, planning system, delivery rules | R0 Planning baseline |
| 1 | Phase 0 - Delivery foundation | Durable data model v1 and repository migration plan | R0.1 Durable core design |
| 2 | Phase 0 - Delivery foundation | Durable queues, idempotency and worker lifecycle | R0.2 Worker foundation |
| 3 | Phase 0 - Delivery foundation | Control Plane API, modes and Telegram safety shell | R0.3 Control plane |
| 4 | Phase 1 - Profile, policy and safe intelligence | Candidate profile, search profiles, resumes and fact registry | R1 Profile foundation |
| 5 | Phase 1 - Profile, policy and safe intelligence | Policy engine v1: apply, reply, scheduling, rate limits | R1 Policy foundation |
| 6 | Phase 1 - Profile, policy and safe intelligence | LLM gateway v1: structured outputs, safety, cost controls | R1 LLM boundary |
| 7 | Phase 1 - Profile, policy and safe intelligence | Manual review and approval UX | R1 Review-first UX |
| 8 | Phase 2 - Read-only ingest and scoring | Provider registry, search compiler and source polling runtime | R2 Read-only foundation |
| 9 | Phase 2 - Read-only ingest and scoring | hh.ru read-only provider productionization | R2 Provider hh read-only |
| 10 | Phase 2 - Read-only ingest and scoring | robota.ua read-only provider productionization | R2 Provider robota read-only |
| 11 | Phase 2 - Read-only ingest and scoring | Telegram channel ingest and unstructured vacancy parsing | R2 Telegram ingest |
| 12 | Phase 2 - Read-only ingest and scoring | Normalization, extraction confidence and dedup engine v1 | R2 Data quality |
| 13 | Phase 2 - Read-only ingest and scoring | Relevance scoring, low-quality filter and pipeline visibility | R2 Scoring |
| 14 | Phase 2 - Read-only ingest and scoring | Read-only soak, data quality gates and R2 release | R2 Read-only MVP |
| 15 | Phase 3 - Deterministic browser automation dry-run | Playwright runtime, browser sessions and artifact storage | R3 Automation foundation |
| 16 | Phase 3 - Deterministic browser automation dry-run | Selector registry, page fingerprints and canary v1 | R3 Automation identity |
| 17 | Phase 3 - Deterministic browser automation dry-run | Flow state machine runner, replay and error taxonomy | R3 Flow engine |
| 18 | Phase 3 - Deterministic browser automation dry-run | hh apply dry-run to submit boundary | R3 hh dry-run |
| 19 | Phase 3 - Deterministic browser automation dry-run | robota apply dry-run to submit boundary | R3 robota dry-run |
| 20 | Phase 3 - Deterministic browser automation dry-run | Automation soak, canary operations and R3 release | R3 Dry-run automation |
| 21 | Phase 4 - Application generation and controlled auto-apply | Resume router and cover letter engine | R4 Application drafting |
| 22 | Phase 4 - Application generation and controlled auto-apply | Submit guard sequence, proof pack and application lifecycle | R4 Apply safety gate |
| 23 | Phase 4 - Application generation and controlled auto-apply | Review-first application flow with first provider | R4 Review-first live boundary |
| 24 | Phase 4 - Application generation and controlled auto-apply | Controlled auto-apply for stable provider | R4 Controlled auto-apply |
| 25 | Phase 4 - Application generation and controlled auto-apply | Second provider enablement and apply maturity | R4 Multi-provider apply |
| 26 | Phase 5 - Conversation automation | Inbox sync provider contract and conversation linking | R5 Conversation foundation |
| 27 | Phase 5 - Conversation automation | Message classification and priority engine | R5 Classification |
| 28 | Phase 5 - Conversation automation | Template engine, fact validation and reply drafts | R5 Reply drafting |
| 29 | Phase 5 - Conversation automation | Review-first reply dispatch and outbound proof | R5 Review-first replies |
| 30 | Phase 5 - Conversation automation | Controlled auto-replies and follow-up MVP | R5 Controlled conversation automation |
| 31 | Phase 6 - Interview coordination | Availability rules and calendar integration strategy | R6 Calendar foundation |
| 32 | Phase 6 - Interview coordination | Slot extraction, proposal and confirmation workflow | R6 Scheduling workflow |
| 33 | Phase 6 - Interview coordination | Final interview card, summary pack and controlled scheduling automation | R6 Interview automation |
| 34 | Phase 7 - Production hardening, analytics and final product | Observability, dashboards, alerts and incident runbooks | R7 Operations readiness |
| 35 | Phase 7 - Production hardening, analytics and final product | Security, privacy, compliance and provider policy hardening | R7 Security readiness |
| 36 | Phase 7 - Production hardening, analytics and final product | Deployment, CI/CD, environments and rollback | R7 Deployment readiness |
| 37 | Phase 7 - Production hardening, analytics and final product | Analytics dashboard, optimization models and template experiments | R7 Product optimization |
| 38 | Phase 7 - Production hardening, analytics and final product | 7-day production soak and final acceptance | R8 GA candidate |
| 39 | Phase 8 - Post-GA scaling and provider expansion | Provider onboarding factory and long-term maintenance | Post-GA scale |

# 9. Phase-by-phase sprint plan


# Phase 0 - Delivery foundation

Durable delivery baseline, data/queue/control plane safety.

## Sprint 0: Baseline audit, planning system, delivery rules

**Release gate:** R0 Planning baseline

**Goal:** Зафиксировать текущее состояние local-safe репозитория, превратить PRD в исполняемую delivery-систему и устранить неопределенность по тому, что именно считается production-ready.

### Deliverables

- Repository audit report: текущие apps/packages, scripts, migrations, tests, coverage, current gaps.
- Backlog taxonomy: EPIC -> Capability -> Feature -> Story -> Task -> Test evidence.
- Roadmap board structure: phases, sprints, release gates, labels, severity, owner fields.
- ADR index: deterministic automation, LLM boundaries, provider onboarding, irreversible action gates.
- Global Definition of Ready and Definition of Done для всех последующих задач.

### Work packages

- RD-0001: Снять inventory текущего репозитория: apps/api, apps/telegram-bot, worker-* и packages/domain/db/providers/automation/llm/telegram-ui/config/observability/testing.
- RD-0002: Разделить текущий local-safe scope и production-enablement scope; отметить, какие части уже есть как fixture-backed/mocked, а какие должны быть заменены durable/live реализацией.
- RD-0003: Создать backlog map по эпикам PRD: Core, Data, Queue, Providers, Automation, Apply, Conversation, Calendar, Telegram, Observability, Security, Ops.
- RD-0004: Описать release gates R0-R7 и критерии запрета перехода между режимами read_only, dry_run_apply, review_first, controlled_auto_apply, full_auto_apply.
- RD-0005: Ввести ticket evidence policy: каждая задача должна иметь test evidence, audit evidence, docs evidence и rollout evidence, если влияет на production.
- RD-0006: Обновить README/development docs: как запускать verify, smoke, workers, migrations, где смотреть статусы и как работать с локальными fixtures.

### Testing and QA

- pnpm verify проходит на текущей main-ветке или документирован список fail-блокеров.
- Smoke-команды запускаются в local environment без live credentials.
- Backlog coverage review: каждый major PRD section связан минимум с одним epic или explicit non-scope решением.

### Sprint Definition of Done

- Есть утвержденный backlog skeleton с owner, priority, phase, sprint, dependencies, acceptance criteria.
- Все irreversible-action требования вынесены в отдельный gate checklist.
- Команда понимает, что текущий fixture-backed dry-run не является production-ready auto-apply.
- Есть список технических долгов, которые блокируют production: in-memory state, mock LLM, fixture providers, dry-run-only flows, отсутствие live provider sessions.
- Спринт не закрыт, пока не создана первая версия risk register и decision log.

### Exit gate

R0 считается достигнутым, когда дальнейшие спринты можно выдавать разработчикам как Jira/Linear задачи без повторного discovery.

## Sprint 1: Durable data model v1 and repository migration plan

**Release gate:** R0.1 Durable core design

**Goal:** Перевести проект из local-safe/in-memory мышления в durable domain model, не ломая текущие tests и fixture flows.

### Deliverables

- Database schema v1 for users, candidate_profiles, resumes, providers, raw_jobs, normalized_jobs, applications, conversations, messages, interviews, audit_logs.
- Repository interfaces split: domain repository contracts vs Postgres implementation vs in-memory test implementation.
- Migration strategy: expand/contract, rollback, seed fixtures, migration tests.
- Indexing plan: dedup keys, status filters, provider external ids, timeline queries.
- Data retention draft for raw payloads, DOM snapshots, screenshots, prompts and messages.

### Work packages

- DB-0101: Спроектировать canonical UUID/idempotency model для всех core entities.
- DB-0102: Добавить migrations для candidate profile, search profiles, resumes, fact registry, source providers/accounts.
- DB-0103: Добавить migrations для raw_jobs, normalized_jobs, dedup_groups, job_scores, applications, application_artifacts.
- DB-0104: Добавить migrations для conversations, inbound_messages, outbound_messages, message_classifications, interview_events.
- DB-0105: Добавить migrations для provider_flow_runs, provider_flow_steps, selector_packs, page_fingerprints, browser_artifacts, manual_review_items.
- DB-0106: Ввести repository contract tests: один набор тестов должен проходить на in-memory и Postgres implementations.
- DB-0107: Зафиксировать правила soft delete, archive, retention, immutable audit append-only.

### Testing and QA

- Migration test поднимает чистую Postgres DB и применяет все migrations в правильном порядке.
- Rollback/forward migration smoke документирован хотя бы для последних двух migrations.
- Repository contract tests покрывают create/read/update/status transition/idempotency для core entities.
- Проверены уникальные индексы на idempotency_key, provider+external_id, dedup_key там, где они критичны.

### Sprint Definition of Done

- После рестарта API/worker state не теряется для сущностей, уже перенесенных в Postgres.
- Ни один production-bound worker не зависит только от in-memory repository.
- Все status transitions пишутся в audit_logs или имеют запланированную task с blocking priority.
- Схема поддерживает будущие proof packs и replay artifacts без redesign.
- Документация содержит ERD или эквивалентную таблицу сущностей и связей.

### Exit gate

Можно начинать очереди и workers на durable state, потому что базовые сущности и индексы готовы.

## Sprint 2: Durable queues, idempotency and worker lifecycle

**Release gate:** R0.2 Worker foundation

**Goal:** Сделать task execution перезапускаемым, идемпотентным и наблюдаемым, чтобы дальнейшие provider-flow не теряли состояние.

### Deliverables

- BullMQ production queue wrapper with typed payloads and deduplication keys.
- Queue registry: source_poll, parsing, dedup, scoring, resume_selection, application_generation, auto_apply, inbox_sync, classification, reply_generation, dispatch, interview_coordination, digest, canary, retry, DLQ.
- Worker lifecycle policy: graceful shutdown, retry, timeout, concurrency, lock renewal, metrics.
- Dead-letter queue storage and triage API endpoint.
- Idempotency service for apply/reply/interview-confirm tasks.

### Work packages

- Q-0201: Реализовать typed queue abstraction и payload schemas через Zod.
- Q-0202: Для каждой queue задать retry policy, backoff, concurrency, timeout, dedup key и DLQ behavior.
- Q-0203: Добавить task_runs table или equivalent persistence для worker execution timeline.
- Q-0204: Добавить idempotency service: acquire, commit, fail, release, duplicate detection.
- Q-0205: Добавить worker health endpoint/status heartbeat.
- Q-0206: Реализовать DLQ viewer API и Telegram rendering draft для критических dead-letter items.
- Q-0207: Добавить integration tests: Redis restart, worker restart mid-task, duplicate task enqueue.

### Testing and QA

- Duplicate task не выполняет irreversible-equivalent logic дважды.
- Worker restart переводит task в retry/resume status, а не теряет его.
- DLQ получает no-retry errors: captcha_required, selector_missing, policy_failed, duplicate_company_thread_detected.
- Queue metrics доступны для depth, age, failures, retries, success latency.

### Sprint Definition of Done

- Все worker apps используют общий queue wrapper вместо ad-hoc execution.
- Каждый task пишет audit event или task_run event.
- Каждая queue имеет documented retry/no-retry matrix.
- Есть operational command/API для просмотра stuck/DLQ tasks.
- Система выдерживает restart API + worker + Redis scenario в integration smoke.

### Exit gate

Можно начинать read-only ingest pipeline, потому что queue layer уже не теряет работу и умеет безопасно повторять задачи.

## Sprint 3: Control Plane API, modes and Telegram safety shell

**Release gate:** R0.3 Control plane

**Goal:** Сделать управление системой безопасным: режимы, пауза, статус, ручные review items, запрет irreversible actions по умолчанию.

### Deliverables

- Mode manager: read_only, dry_run_apply, review_first, controlled_auto_apply, full_auto_apply, conversation_only, paused.
- API endpoints for status, pipeline summary, provider status, mode change, manual review, logs.
- Telegram command handlers: /status, /pause, /resume_bot, /mode, /pipeline, /sources, /manual_review, /logs.
- Bearer-token and Telegram allowed user enforcement hardened.
- Audit trail for all user-triggered commands that change state.

### Work packages

- API-0301: Добавить system_mode table/config source и immutable mode transition audit.
- API-0302: Реализовать `/health`, `/status`, `/pipeline`, `/sources`, `/mode`, `/manual-review`, `/logs/:entityId` endpoints.
- TG-0303: Расширить Telegram UI cards для provider status, queue health, pipeline, manual review items.
- SEC-0304: Проверить, что все non-health endpoints защищены token middleware.
- SEC-0305: Проверить, что live Telegram не стартует без TELEGRAM_ALLOWED_USER_IDS.
- POL-0306: Добавить global irreversible-action gate: если mode не разрешает action, task обязан остановиться до execution.
- QA-0307: Snapshot tests для Telegram renderers и integration tests для mode transitions.

### Testing and QA

- Unauthorized API requests получают 401/403 и не меняют состояние.
- /pause блокирует apply/reply/interview-confirm queues, но не ломает read-only ingest.
- /resume_bot возвращает только разрешенные типы задач в работу согласно mode.
- Mode transition пишет audit event с actor=user/bot/api, timestamp, previous_mode, next_mode, reason.

### Sprint Definition of Done

- Irreversible actions невозможны при IRREVERSIBLE_ACTIONS_ENABLED=false и/или mode=read_only/paused.
- Telegram UI показывает не только happy path, но и provider degraded/DLQ/manual review states.
- Команды не раскрывают секреты, cookies, raw credentials, полные prompt payloads.
- Все команды имеют tests на access control и rendering.
- Есть runbook: как остановить систему и как безопасно возобновить.

### Exit gate

R0 закрыт: есть durable foundation, queue semantics и безопасный control plane без live irreversible behavior.


# Phase 1 - Profile, policy and safe intelligence

Validated candidate profile, policy engine, LLM boundaries, manual review UX.

## Sprint 4: Candidate profile, search profiles, resumes and fact registry

**Release gate:** R1 Profile foundation

**Goal:** Сделать профиль пользователя машинно-валидируемым источником правды для поиска, откликов и коммуникации.

### Deliverables

- Candidate profile schema and validation service.
- Search profile compiler input model: roles, stack, geography, salary, strategy, provider filters.
- Resume registry with versioning, checksum, language, target stack, allowed providers.
- Fact registry with disclosure modes: allowed, range_only, forbidden, approval_required.
- Telegram/API commands for viewing active profile and missing setup requirements.

### Work packages

- PROF-0401: Реализовать candidate_profile domain model и Zod schemas.
- PROF-0402: Реализовать search_profiles с strategy modes: aggressive/balanced/selective.
- PROF-0403: Реализовать resume registry: active flag, provider constraints, file checksum, review status.
- PROF-0404: Реализовать fact_registry с category mapping для salary/location/notice_period/work_format/experience/language.
- PROF-0405: Добавить profile readiness validator: что блокирует read-only, dry-run, review-first, auto-apply, auto-reply.
- TG-0406: Добавить `/profiles`, `/set_profile`, profile card и missing fields card.
- QA-0407: Unit tests на profile validation и fact disclosure modes.

### Testing and QA

- Профиль без active resume не может перейти в apply-ready state.
- Fact with disclosure=forbidden не может быть использован cover letter/reply generator-ом.
- Salary range_only раскрывается только диапазоном, не точным hidden target.
- Profile readiness report объясняет, какие поля надо заполнить для следующего mode.

### Sprint Definition of Done

- Все будущие scoring/apply/reply components получают данные из profile service, а не из разбросанных env/mock values.
- Нет свободного текста в профиле, который можно отправить наружу без policy validation.
- Resume artifacts хранятся через object storage adapter или имеют clear staging replacement.
- Profile updates пишут audit events.
- Документация содержит пример валидного profile YAML/JSON для backend Node.js профиля.

### Exit gate

Система знает, кто кандидат, какие вакансии ему подходят и какие факты разрешено использовать автоматически.

## Sprint 5: Policy engine v1: apply, reply, scheduling, rate limits

**Release gate:** R1 Policy foundation

**Goal:** Централизовать все разрешения и запреты, чтобы ни один worker не принимал production-critical решения локально.

### Deliverables

- Policy engine interface with decisions: allow, deny, requires_user_approval, requires_ops_review, defer.
- Apply policy, outbound reply policy, scheduling policy, fact disclosure policy, provider execution policy, rate limit policy.
- Policy check persistence and audit event linking.
- Rate limit counters: global, per provider, per company, per clone group, per conversation.
- Policy simulator endpoint for testing decisions before enabling automation.

### Work packages

- POL-0501: Реализовать unified PolicyInput и PolicyDecision schemas.
- POL-0502: Реализовать apply policy: mode, score threshold, provider status, dedup, resume, cover letter, rate limits.
- POL-0503: Реализовать reply policy: classification confidence, fact registry, sensitive data, thread contradiction, category allowlist.
- POL-0504: Реализовать scheduling policy: availability, timezone, min notice, max interviews per day, no overlap.
- POL-0505: Реализовать provider execution policy: stable/read_only/apply_disabled/degraded/blocked behavior.
- POL-0506: Добавить rate limit service with transactional counters and reset windows.
- POL-0507: Добавить `/policy/simulate` API и test fixtures для major policy scenarios.

### Testing and QA

- Policy denies apply when provider status=read_only/apply_disabled/blocked.
- Policy requires approval when mode=review_first and action=send_application.
- Policy denies reply when classification confidence below threshold or facts unsupported.
- Rate limits are atomic under concurrent tasks.
- Every policy decision persists policy_version and checks array.

### Sprint Definition of Done

- Все irreversible candidate actions обязаны вызывать policy engine до execution.
- Policy engine tests покрывают at least 95% branches для critical decisions.
- Policy versions are explicit and included in audit/proof records.
- Manual review item создается автоматически для approval_required/ops_review decisions.
- Документация содержит матрицу: action x mode x provider_status x decision.

### Exit gate

Можно запускать application drafts and replies в безопасном режиме, потому что decisions централизованы и проверяемы.

## Sprint 6: LLM gateway v1: structured outputs, safety, cost controls

**Release gate:** R1 LLM boundary

**Goal:** Подключить LLM как controlled service для извлечения/классификации/генерации, но не как исполнителя actions.

### Deliverables

- LLM provider abstraction: mock, configured real provider, fallback strategy.
- JSON schema validation for job extraction, cover letter, message classification, slot extraction, summaries.
- Prompt injection controls: untrusted input separation, no tool execution, redaction, prompt/output hashing.
- Cost/latency metrics and budget guardrails.
- Evaluation fixture suite for classification and generation.

### Work packages

- LLM-0601: Реализовать llm_gateway interface with model config, timeout, retry, max tokens, JSON mode where supported.
- LLM-0602: Создать schemas для VacancyExtraction, CoverLetterDraft, MessageClassification, SlotExtraction, ThreadSummary.
- LLM-0603: Добавить validation pipeline: parse -> schema validate -> policy validate -> persist -> use.
- LLM-0604: Добавить prompt templates с explicit separation between system policy and external content.
- LLM-0605: Добавить redaction/hashing для prompts, recruiter messages и raw job descriptions в logs.
- LLM-0606: Создать eval fixtures: 100 vacancy descriptions, 100 recruiter messages, 30 scheduling cases, 30 unsafe fact cases.
- OBS-0607: Метрики: llm_latency_ms, llm_cost_estimate, schema_validation_failures, unsafe_output_rejections.

### Testing and QA

- Malformed LLM output is rejected and never reaches apply/reply dispatch.
- Prompt injection text inside job description cannot alter system policy or tool availability.
- Unsupported facts generated in cover letter are flagged by validation.
- LLM timeout creates retry/defer/manual_review according to task type.

### Sprint Definition of Done

- LLM has no direct browser, Telegram dispatch, calendar confirmation or provider submit capability.
- All LLM outputs are schema-validated and linked to model_version/prompt_version.
- There is a deterministic fallback for low-confidence/failed classifications: manual_review_required.
- Evaluation reports are stored and comparable across prompt/model changes.
- Prompt templates are versioned and reviewed as production logic.

### Exit gate

Система может безопасно использовать LLM for text understanding/generation without giving it control over actions.

## Sprint 7: Manual review and approval UX

**Release gate:** R1 Review-first UX

**Goal:** Создать человеко-управляемый контур для неопределенных, чувствительных и первых production actions.

### Deliverables

- Manual review queue with statuses: open, approved, rejected, resolved, ignored, expired.
- Telegram cards with approve/reject/edit/defer actions for applications, replies and scheduling.
- Approval request expiry, audit trail and conflict detection.
- Review reasons taxonomy: unsupported_fact, low_confidence, provider_degraded, first_n_review, sensitive_data, policy_conflict.
- Operator/user runbook for review handling.

### Work packages

- REV-0701: Реализовать manual_review_items repository and status transitions.
- REV-0702: Реализовать approval_requests с entity_type, entity_id, requested_action, expires_at, policy_decision_id.
- TG-0703: Реализовать Telegram interactive cards for approve/reject/defer; include reason summary and risk flags.
- TG-0704: Реализовать `/manual_review`, `/review <id>`, `/approve <id>`, `/reject <id>` command flows.
- SEC-0705: Проверить, что approval actions принимаются только от allowed Telegram users.
- AUD-0706: Все approvals/rejections пишут actor, previous status, next status, rendered text hash.
- QA-0707: Tests on stale approval, duplicate approval, conflicting entity already resolved.

### Testing and QA

- Approval after expiry is rejected and creates new review requirement if action still relevant.
- Two duplicate approval clicks do not dispatch two replies/applications.
- Rejected application/reply cannot be auto-requeued unless user explicitly changes mode or regenerates draft.
- Telegram card never exposes secrets, raw cookies or unredacted prompt payloads.

### Sprint Definition of Done

- Every requires_user_approval policy decision has a visible manual review item.
- Review actions are idempotent and audited.
- User can understand why item is blocked and what happens after approval.
- Manual review UI supports application drafts, outbound replies, interview slots and provider incidents.
- R1 release can run safely in review_first mode for all irreversible actions.

### Exit gate

R1 profile/policy/intelligence layer готов: можно строить read-only ingest and application drafts with human approval fallback.


# Phase 2 - Read-only ingest and scoring

Stable read-only job discovery, normalization, dedup, scoring and pipeline visibility.

## Sprint 8: Provider registry, search compiler and source polling runtime

**Release gate:** R2 Read-only foundation

**Goal:** Заложить deterministic provider architecture для поиска вакансий без live apply.

### Deliverables

- Provider registry with capabilities, status, mode, rate limits, health state.
- ProviderModule contract implemented through typed interfaces and contract tests.
- Search compiler from candidate/search profile to provider-specific query plans.
- Source polling scheduler using durable queues and per-provider concurrency limits.
- Search run persistence for reproducibility and explainability.

### Work packages

- PROV-0801: Реализовать provider registry persisted from config + DB override.
- PROV-0802: Реализовать ProviderModule contract tests: healthcheck, compileSearchPlan, discoverJobs, fetchJob, normalizeJob.
- SRC-0803: Реализовать search compiler для hh, robota, telegram using profile strategy.
- SRC-0804: Реализовать source_poll_queue scheduling with max_pages_per_run, max_jobs_per_run, stop conditions.
- SRC-0805: Добавить search_runs table: query, filters, raw count, normalized count, rejected, shortlisted, errors.
- SRC-0806: Добавить provider status transitions based on healthcheck/search errors.
- TG-0807: `/sources` shows provider capabilities, mode, status, last run, failure rate.

### Testing and QA

- Provider in status=blocked is not polled unless explicitly forced by ops/test mode.
- Search compiler produces deterministic plans for same profile/config.
- Search run records include stop condition and errors.
- Provider module contract tests fail if required methods are missing or schema invalid.

### Sprint Definition of Done

- Read-only provider execution does not call apply or reply methods.
- Provider capabilities are not inferred ad hoc; they are declared and validated.
- Search run can be replayed logically from stored query plan and result refs.
- Provider errors map to provider status and audit logs.
- R2 providers can be enabled/disabled independently from Telegram/API.

### Exit gate

Можно подключать specific providers because runtime, contracts and search run persistence exist.

## Sprint 9: hh.ru read-only provider productionization

**Release gate:** R2 Provider hh read-only

**Goal:** Довести hh provider до стабильного read-only discovery/fetch/normalize уровня с fixtures, limits and errors.

### Deliverables

- hh provider module: compileSearchPlan, discoverJobs, fetchJob, normalizeJob, dedupKey.
- hh fixtures: search results, job details, closed job, already applied indicator, salary missing, remote/hybrid ambiguity, multi-language.
- hh provider capability/status config and rate limit rules.
- hh parsing confidence and normalization tests.
- hh canary read-only healthcheck without irreversible actions.

### Work packages

- HH-0901: Выбрать stable read-only access mode: official/documented if available, structured HTTP if permitted, browser read-only otherwise.
- HH-0902: Реализовать hh search plan mapping: queries, filters, pagination, sorting, remote/hybrid/salary/seniority parameters.
- HH-0903: Реализовать raw job ref extraction and fetch job details.
- HH-0904: Реализовать normalization into NormalizedJob schema with extractionConfidence.
- HH-0905: Реализовать hh dedup key levels: provider external id, canonical URL, company+title+content hash.
- HH-0906: Создать at least 20 fixture cases and fixture regression tests.
- HH-0907: Реализовать hh health/canary read-only and provider error mapping.

### Testing and QA

- hh fixture suite passes with extractionConfidence >= threshold for normal cases.
- Closed/archived jobs are marked unavailable and cannot enter auto-apply later.
- Salary missing does not break normalization; it creates soft risk/reason.
- Pagination stops at configured max pages/jobs and records stop reason.

### Sprint Definition of Done

- hh read-only flow can process 1,000 fixture/live-like jobs without schema violations.
- No hh task performs submit/apply/reply behavior in this sprint.
- Provider failure does not block other providers or global pipeline.
- hh provider has documented rate limits and safe-mode behavior.
- hh provider status is visible in `/sources`.

### Exit gate

hh можно включить в read_only production-like сбор вакансий.

## Sprint 10: robota.ua read-only provider productionization

**Release gate:** R2 Provider robota read-only

**Goal:** Сделать robota.ua вторым полноценным read-only provider-ом, чтобы проверить abstraction на разных источниках.

### Deliverables

- robota provider module: search, fetch, normalize, dedup.
- robota fixtures for search/job/closed/missing salary/remote ambiguity/language variants.
- Provider-specific query plan mapping and rate limits.
- Provider error taxonomy mapping and canary.
- Cross-provider dedup with hh on similar company/title/content.

### Work packages

- ROB-1001: Определить safe read-only access mode for robota.ua.
- ROB-1002: Реализовать provider-specific filters: location/country, remote, salary, stack keywords, pagination.
- ROB-1003: Реализовать raw job ref extraction and details fetch.
- ROB-1004: Нормализовать compensation/currency/geography/work format для robota-specific formats.
- ROB-1005: Добавить 20+ fixture cases and regression tests.
- ROB-1006: Добавить cross-provider dedup tests where hh and robota publish same/similar vacancy.
- ROB-1007: Добавить canary, healthcheck and provider status visibility.

### Testing and QA

- robota normalization maps work formats consistently with hh and Telegram.
- Cross-provider duplicate creates dedup group instead of two independent apply candidates.
- Provider-specific errors map to canonical error taxonomy.
- Search plan compiler output remains deterministic and snapshot-tested.

### Sprint Definition of Done

- robota read-only provider reaches same quality bar as hh provider.
- Provider can be disabled independently without changing code.
- Dedup engine has at least one tested cross-provider scenario.
- Rate limits prevent accidental high-frequency polling.
- Documentation includes provider playbook draft for robota.ua.

### Exit gate

R2 has two job-board providers, proving provider abstraction is not hh-specific.

## Sprint 11: Telegram channel ingest and unstructured vacancy parsing

**Release gate:** R2 Telegram ingest

**Goal:** Подключить Telegram-каналы как источник вакансий, учитывая, что посты не имеют стабильной структуры.

### Deliverables

- Telegram source provider for configured channels.
- Unstructured post classifier: vacancy vs non-vacancy vs uncertain.
- Telegram vacancy extraction schema with confidence.
- Repost/forward/permalink handling.
- Telegram-source dedup by channel/post id, text hash, company+title+stack.

### Work packages

- TG-SRC-1101: Реализовать channel config, allowed channels, polling/webhook strategy depending on available access.
- TG-SRC-1102: Сохранять raw post payload: channel_id, post_id, text, timestamp, permalink, forward metadata.
- TG-SRC-1103: Реализовать vacancy classifier with rule-based prefilter + LLM extraction fallback.
- TG-SRC-1104: Нормализовать title/company/location/stack/compensation/contact/work_format/language.
- TG-SRC-1105: Реализовать duplicate detection for reposts and similar posts across channels.
- TG-SRC-1106: Добавить Telegram fixtures: clean vacancy, noisy post, repost, agency post, scam-like post, salary missing, contact-only post.
- TG-SRC-1107: Policy rule: Telegram applications remain draft/manual unless explicit provider/channel policy later allows otherwise.

### Testing and QA

- Non-vacancy posts are not normalized as jobs.
- Low-confidence Telegram extraction cannot enter auto-apply pipeline.
- Forwarded/reposted messages are linked rather than duplicated when confidence high.
- Contact-only postings create manual review or draft path, not autonomous outreach by default.

### Sprint Definition of Done

- Telegram channels can be added/removed via config without code change.
- Extraction confidence and risks are stored for every Telegram-derived job.
- LLM failure leads to uncertain/manual state, not silent data corruption.
- Digest rules still do not list all discovered/applied jobs; pipeline commands show details.
- Telegram source provider does not conflict with Telegram control bot auth/allowed users.

### Exit gate

R2 supports job boards and Telegram channels as read-only sources.

## Sprint 12: Normalization, extraction confidence and dedup engine v1

**Release gate:** R2 Data quality

**Goal:** Сделать raw->normalized->deduplicated lifecycle reliable enough to prevent duplicate applications later.

### Deliverables

- Canonical NormalizedJob service with field-level validation and extraction confidence.
- Dedup engine with provider job, canonical URL, content hash, company-role, thread keys.
- Dedup decisions: new, duplicate, possible_duplicate with confidence and actions.
- Rejected/shortlisted status transitions with audit and reasons.
- Data quality dashboard/API summary.

### Work packages

- NORM-1201: Реализовать normalization validator and canonical enums for work_format, seniority, employment_type, language, currency, compensation_period.
- NORM-1202: Реализовать extractionConfidence scoring by field weights.
- DEDUP-1203: Реализовать exact dedup: provider+external_id and canonical_url.
- DEDUP-1204: Реализовать content hash and normalized company/title similarity rules.
- DEDUP-1205: Реализовать possible_duplicate state with manual review option for ambiguous cases.
- DEDUP-1206: Добавить duplicate_prevented audit event and metrics.
- QA-1207: Build regression dataset with known duplicates and non-duplicates across hh/robota/telegram.

### Testing and QA

- Known duplicate set has high recall without incorrectly merging clearly distinct jobs above allowed false positive threshold.
- Every rejected/duplicate/possible_duplicate decision has reason codes.
- Normalization fails gracefully on missing optional fields and blocks missing required fields.
- Dedup engine is deterministic across repeated runs.

### Sprint Definition of Done

- No job can enter application_prepared without dedup decision.
- Dedup keys are stored and indexed.
- Possible duplicates do not get auto-applied until resolved or policy permits.
- Data quality report includes extraction confidence distribution by provider.
- Provider-specific normalization quirks are documented in provider playbooks.

### Exit gate

Pipeline can reliably tell whether a vacancy is new, duplicate or unsafe/uncertain.

## Sprint 13: Relevance scoring, low-quality filter and pipeline visibility

**Release gate:** R2 Scoring

**Goal:** Сделать понятную и объяснимую оценку вакансий, чтобы application pipeline получал только валидных кандидатов.

### Deliverables

- Relevance score v1 by strategy: aggressive, balanced, selective.
- Hard filters and soft filters with rejection reasons.
- Low-quality/scam/agency/noise signals v1.
- Interview-likelihood placeholder score with explainability fields.
- Telegram/API pipeline views: discovered, normalized, rejected, shortlisted, apply candidates.

### Work packages

- SCORE-1301: Реализовать factor scoring: title, primary_stack, secondary_stack, seniority, work_format, geography, compensation, language, resume similarity placeholder, company history.
- SCORE-1302: Реализовать hard filters: junior/intern exclusion, salary below hard minimum, office-only incompatible geography, blacklist, closed job, low extraction confidence.
- SCORE-1303: Реализовать soft filters and risk flags: missing salary, vague description, agency, mixed stack, unknown company.
- SCORE-1304: Реализовать low-quality score and penalty with explainable reasons.
- SCORE-1305: Реализовать interview-likelihood v0 from freshness/source/contact/quality/history placeholders.
- TG-1306: Add `/pipeline`, `/job <id>` read-only cards with score, reasons, risks, status timeline.
- QA-1307: Build scoring golden dataset and snapshot expected decisions per strategy.

### Testing and QA

- Same job/profile/strategy yields same score and reasons.
- Blacklisted company hard-rejects regardless of high stack match.
- Low extraction confidence blocks auto-apply candidate status.
- Pipeline card explains top 3-7 reasons and risks.

### Sprint Definition of Done

- Every normalized job has score or documented scoring_failed status.
- Every rejection has at least one hard/soft reason code.
- Shortlisted jobs satisfy profile hard filters and strategy threshold.
- Scoring weights are configurable and versioned.
- R2 users can inspect why a job was accepted or rejected.

### Exit gate

System can run read-only end-to-end from provider search to shortlist with explainability.

## Sprint 14: Read-only soak, data quality gates and R2 release

**Release gate:** R2 Read-only MVP

**Goal:** Доказать, что read-only pipeline стабилен на объемах и не теряет/искажает состояние.

### Deliverables

- Read-only 7-day or accelerated soak plan.
- Metrics dashboards: jobs by provider, parse confidence, dedup rate, rejection reasons, shortlist rate, queue health.
- Data quality report and bug backlog.
- R2 release notes and rollback plan.
- Provider playbooks v1 for hh, robota, telegram.

### Work packages

- REL-1401: Запустить continuous read-only polling with configured limits in staging/dev.
- OBS-1402: Добавить dashboards for read-only flow and alerts for parse spike, provider failure, queue backlog, dedup anomaly.
- QA-1403: Process target dataset: at least 10,000 jobs or fixture-equivalent stress set.
- QA-1404: Run data audit: required fields, confidence distribution, duplicate clusters, rejection reasons.
- OPS-1405: Создать runbooks: provider read-only failure, parsing regression, bad dedup merge, queue backlog.
- REL-1406: Release gate review: no irreversible actions enabled, read-only mode verified, production secrets not needed except safe provider read access if used.

### Testing and QA

- 10,000 jobs processed without state loss or queue deadlock.
- Duplicate normalized entries are below defined tolerance or documented with fixes.
- Provider outage/degraded state does not stop other providers.
- All critical read-only alerts fire in synthetic tests.

### Sprint Definition of Done

- R2 release can be operated safely in read_only mode.
- No job can reach application submit path from read-only release.
- Data quality report is reviewed and accepted for moving to dry-run apply.
- Known gaps are filed as backlog with severity and owner.
- Rollback procedure is tested at least once in staging.

### Exit gate

R2 accepted: stable read-only job search, normalization, dedup, scoring and Telegram visibility.


# Phase 3 - Deterministic browser automation dry-run

State-machine browser automation to submit boundary, canary, replay and diagnostics.

## Sprint 15: Playwright runtime, browser sessions and artifact storage

**Release gate:** R3 Automation foundation

**Goal:** Создать безопасную browser automation основу, которая хранит сессии и артефакты, но еще не отправляет отклики.

### Deliverables

- Playwright runtime wrapper with browser context isolation per provider account.
- Encrypted session/auth state storage via secrets/object storage adapter.
- Artifact capture: screenshots, DOM snapshots, traces, URL, timestamps.
- Browser worker isolation and resource limits.
- Session expiry detection and manual re-auth workflow draft.

### Work packages

- BR-1501: Реализовать browser runtime factory with headless/headed/debug modes and environment-specific restrictions.
- BR-1502: Реализовать provider account browser context isolation; no session sharing between users/providers.
- SEC-1503: Реализовать encrypted auth state storage; no cookies in logs.
- ART-1504: Реализовать artifact store for screenshots, DOM snapshots and traces with retention metadata.
- BR-1505: Реализовать session health and expiry detection before irreversible boundary.
- OPS-1506: Создать manual re-auth runbook and audit requirement.
- QA-1507: Integration tests using local fixture pages to validate artifact capture and isolation.

### Testing and QA

- Two provider accounts do not share cookies/storage state.
- Session expired state stops flow before submit boundary.
- Artifact capture works on success and failure.
- Debug/headed mode is unavailable in production unless explicit ops override is audited.

### Sprint Definition of Done

- Browser automation cannot run without provider account context and mode check.
- Artifacts have object keys linked to provider_flow_run_id.
- Sensitive artifact access is controlled and logged.
- No irreversible submit step exists in runtime yet.
- Resource leaks are covered by worker shutdown tests.

### Exit gate

Browser runtime is safe enough to execute deterministic dry-runs against fixtures and staging-like pages.

## Sprint 16: Selector registry, page fingerprints and canary v1

**Release gate:** R3 Automation identity

**Goal:** Сделать навигацию проверяемой: flow продолжает работу только на ожидаемых страницах и с ожидаемыми элементами.

### Deliverables

- Selector pack schema with primary/fallback selectors and criticality.
- Page fingerprint schema: URL patterns, title, DOM anchors, text anchors, auth/CAPTCHA/blocking indicators.
- Fixture regression suite for selectors and fingerprints.
- Canary runner: auth, search results, job page, apply form without submit.
- Selector usage logs and failure metrics.

### Work packages

- SEL-1601: Реализовать selector pack registry with versioning and provider binding.
- FP-1602: Реализовать page fingerprint evaluator and mismatch error output.
- FP-1603: Добавить CAPTCHA/blocking/session-expired indicators to fingerprint checks.
- SEL-1604: Добавить selector resolution logging: key, primary/fallback used, ambiguity count.
- CAN-1605: Реализовать canary_queue worker and provider canary run records.
- QA-1606: Fixture tests for selectors/fingerprints across hh and robota fixture pages.
- OBS-1607: Metrics: selector_missing, selector_ambiguous, fingerprint_mismatch, canary_success_rate.

### Testing and QA

- Fingerprint mismatch stops flow and saves diagnostic artifacts.
- Selector ambiguity fails critical steps instead of choosing randomly.
- Selector pack version is stored with every flow run.
- Canary can run without triggering submit/reply actions.

### Sprint Definition of Done

- Every critical selector has primary and at least two fallback strategies where feasible.
- Every key provider page has a fingerprint fixture.
- Selector changes require regression tests before merge.
- Canary status is visible in provider health view.
- Flow runner cannot click if page fingerprint does not match expected state.

### Exit gate

Automation can identify pages and elements deterministically before state-machine flow work.

## Sprint 17: Flow state machine runner, replay and error taxonomy

**Release gate:** R3 Flow engine

**Goal:** Перевести browser automation из последовательности действий в state machine с replay, diagnostics and explicit outcomes.

### Deliverables

- Flow definition DSL/schema for states, expected fingerprints, guards, actions, transitions, terminal states.
- Flow runner with step-level logs, timeouts, guard results and artifact capture.
- Replay mode from DOM snapshots and traces without live submit.
- Error taxonomy mapping and outcome rules.
- Flow diagnostics report for selector/fingerprint/layout failures.

### Work packages

- FLOW-1701: Реализовать flow definition schema and validation.
- FLOW-1702: Реализовать state machine runner: enter state, assert fingerprint, run guards, resolve action, transition, capture artifacts.
- FLOW-1703: Реализовать guard interface for not_already_applied, vacancy_active, resume_available, cover_letter_valid, no_captcha, rate_limit_ok.
- FLOW-1704: Реализовать replayFlow(flowRunId) against stored artifacts/DOM where possible.
- ERR-1705: Map all browser/provider/business errors to canonical taxonomy and outcomes.
- FLOW-1706: Создать flow diagnostics report with suspected root cause and next action.
- QA-1707: Test fixture flows: success dry-run, missing selector, fingerprint mismatch, unexpected modal, session expired, captcha detected.

### Testing and QA

- Flow never hangs beyond configured state/action timeout.
- No unknown browser error leaves task without terminal outcome.
- Replay does not execute live actions and cannot submit.
- Error outcome is one of retry_scheduled, manual_review_required, provider_disabled, apply_failed, read_only_fallback, dead_lettered.

### Sprint Definition of Done

- All provider automation uses flow runner; no ad-hoc Playwright scripts in production path.
- Flow run, step logs and artifacts are persisted and linked.
- Replay report is actionable enough to update selector/fingerprint.
- Error taxonomy is covered by tests and documented in runbook.
- No flow has generic agentic clicking or LLM-selected UI actions.

### Exit gate

Automation core can run deterministic dry-runs with auditable failures.

## Sprint 18: hh apply dry-run to submit boundary

**Release gate:** R3 hh dry-run

**Goal:** Довести hh browser flow до границы submit без отправки отклика, с selectors, fingerprints, guards and proof artifacts.

### Deliverables

- hh_auto_apply_dry_run_v1 flow: search/job/apply form states, no submit.
- hh selector pack and page fingerprints for apply path.
- hh dry-run proof pack: pre-submit screenshot, DOM, selected resume placeholder, cover letter field check.
- hh canary apply-form check without submit.
- hh dry-run diagnostics and provider status integration.

### Work packages

- HH-DRY-1801: Define hh flow states: search_results, job_details, application_form, submit_boundary, dry_run_complete.
- HH-DRY-1802: Implement guards: active job, apply button exists, not already applied, account authenticated, no captcha, provider mode allows dry-run.
- HH-DRY-1803: Implement form detection and dry-fill behavior without submit.
- HH-DRY-1804: Capture proof artifacts and attach to application_draft/flow_run.
- HH-DRY-1805: Implement hh apply-form canary without submit.
- QA-1806: Run dry-run fixture and staging-like cases; collect success/failure rate.
- OPS-1807: Provider playbook: selector update, auth expiry, captcha, layout change.

### Testing and QA

- Dry-run cannot click submit even if submit button is visible.
- Already-applied indicator stops with job_already_applied/duplicate_prevented path.
- CAPTCHA/blocking indicator stops and provider becomes degraded/read_only/blocked per policy.
- Dry-run success rate target is tracked on fixtures and canary runs.

### Sprint Definition of Done

- hh flow reaches submit boundary in dry-run mode with >=95% fixture success for supported cases.
- Every dry-run result has flow_run_id, selector_pack_version, fingerprints, artifacts.
- Failures are diagnosable through replay or report.
- No live application is submitted in this sprint.
- hh dry-run readiness is approved before any controlled submit sprint begins.

### Exit gate

hh is a candidate for controlled auto-apply after application generation/proof gates are implemented.

## Sprint 19: robota apply dry-run to submit boundary

**Release gate:** R3 robota dry-run

**Goal:** Повторить deterministic dry-run подход на втором job board, выявив общие и provider-specific automation gaps.

### Deliverables

- robota_auto_apply_dry_run_v1 flow to submit boundary.
- robota selector pack and fingerprints.
- robota dry-run proof artifacts and canary.
- Provider-specific failure mapping and diagnostics.
- Cross-provider automation quality comparison.

### Work packages

- ROB-DRY-1901: Define robota flow states and application-form variants.
- ROB-DRY-1902: Implement selectors/fingerprints for supported apply path.
- ROB-DRY-1903: Implement guards: active job, not already applied, resume upload capability, no captcha/blocking, authenticated account.
- ROB-DRY-1904: Implement dry-fill to submit boundary and proof capture.
- ROB-DRY-1905: Implement robota apply-form canary.
- QA-1906: Fixture/staging dry-run suite with supported and unsupported form variants.
- OPS-1907: Provider playbook for robota automation incidents.

### Testing and QA

- Unsupported form schema stops with form_schema_changed/manual_review_required.
- Dry-run artifacts include enough data to update selectors without re-running live session.
- Robota provider remains read_only/apply_disabled unless dry-run readiness gate passes.
- Flow handles missing cover letter field if provider supports resume-only flow and policy allows.

### Sprint Definition of Done

- robota dry-run reaches submit boundary for supported fixture cases.
- Unsupported variants are explicitly listed, not silently skipped.
- Canary and replay reports are implemented.
- No live submit occurs.
- Provider readiness matrix ranks hh vs robota for first controlled submit.

### Exit gate

At least one provider can be selected for first controlled auto-apply based on measured dry-run stability.

## Sprint 20: Automation soak, canary operations and R3 release

**Release gate:** R3 Dry-run automation

**Goal:** Доказать, что deterministic automation canaries/dry-runs стабильны и failure handling не опасен.

### Deliverables

- Dry-run automation soak report for hh/robota.
- Canary schedule and post-deploy canary hooks.
- Selector/fingerprint change workflow and regression gate.
- Automation incident runbooks.
- R3 release decision: which provider can move to controlled submit first.

### Work packages

- REL-2001: Run scheduled canaries for auth/search/job/apply-form without submit.
- REL-2002: Run N dry-run cycles against supported jobs under realistic limits.
- OBS-2003: Dashboards: dry-run success rate, selector failures, fingerprint mismatches, captcha/blocking, session expiry.
- OPS-2004: Runbook drills: selector_missing, auth_expired, provider_degraded, captcha_required, stuck browser worker.
- QA-2005: Regression gate: selector pack update triggers fixture tests + canary.
- REL-2006: R3 acceptance review and first-provider selection for controlled auto-apply.

### Testing and QA

- No dry-run task crosses submit boundary.
- Canaries catch synthetic broken selector/fingerprint cases.
- Provider status changes correctly under repeated failure thresholds.
- Replay report is generated for failed dry-run flows.

### Sprint Definition of Done

- Dry-run success rate >=95% on supported fixture set for selected first provider.
- Failure categories are actionable and mapped to runbooks.
- Post-deploy canary is mandatory before provider returns to stable/apply-enabled state.
- Known unsupported cases are blocked by policy/manual review.
- R3 release is documented and reversible.

### Exit gate

R3 accepted: deterministic dry-run automation is operational and ready for controlled submit work.


# Phase 4 - Application generation and controlled auto-apply

Resume routing, cover letters, proof packs, review-first submit and controlled auto-apply.

## Sprint 21: Resume router and cover letter engine

**Release gate:** R4 Application drafting

**Goal:** Генерировать application draft: правильное резюме, безопасное cover letter, rationale and validation, without submit.

### Deliverables

- Resume router with confidence and rationale.
- Cover letter generator using LLM gateway + approved facts only.
- Cover letter validation: facts, length, language, compensation, unsupported claims, placeholders.
- Application draft entity and lifecycle.
- Telegram review cards for application drafts.

### Work packages

- APP-2101: Implement resume selection by language, target title, stack, seniority, provider constraints, active/reviewed status.
- APP-2102: Implement application_generation_queue from shortlisted jobs.
- CL-2103: Implement cover letter prompt/schema with facts_used and risk_flags.
- CL-2104: Implement validation service that blocks unsupported facts, invented experience, salary conflicts, wrong language, placeholders.
- APP-2105: Persist application_drafts with resume_id, cover_letter_id, score, policy check, dedup key.
- TG-2106: Render application draft card with approve/reject/regenerate/manual review actions.
- QA-2107: Golden tests for resume routing and cover letter validation.

### Testing and QA

- Cover letter cannot include facts not present in profile/resume/fact registry.
- Wrong-language vacancy produces correct language selection or manual review if unsupported.
- Resume not available blocks application draft from apply queue.
- Regeneration creates new version and preserves previous audit trail.

### Sprint Definition of Done

- Every application draft has selected resume, cover letter, rationale, policy result and validation result.
- Drafts can be approved/rejected in Telegram without submitting yet.
- LLM schema failure or validation failure creates manual review, not bad draft.
- Cover letter generator has evaluation fixtures and versioned prompts.
- No submit action is enabled before proof/guard sprint completes.

### Exit gate

The system can prepare high-quality, policy-safe application drafts for selected jobs.

## Sprint 22: Submit guard sequence, proof pack and application lifecycle

**Release gate:** R4 Apply safety gate

**Goal:** Реализовать полный safety/proof слой перед реальным submit, чтобы каждый отклик был объясним, идемпотентен и доказуем.

### Deliverables

- Application lifecycle statuses from prepared to applied/apply_failed/manual_review.
- Submit guard sequence: re-fetch, dedup, idempotency, provider status, auth, rate limit, policy, proof readiness, dry-run state.
- Application proof pack schema and object storage linkage.
- Pre-submit and post-submit artifact capture contract.
- Apply failure handling and Telegram alerts.

### Work packages

- APP-2201: Implement application status machine and allowed transitions.
- APP-2202: Implement submit guard service with explicit ordered checks.
- APP-2203: Implement application idempotency key and duplicate prevention at DB + service layer.
- APP-2204: Implement proof_pack builder: provider, account, job, profile, resume, cover letter, flow, selector pack, artifacts, confirmation.
- APP-2205: Implement proof readiness check before enabling submit.
- APP-2206: Implement apply failure taxonomy mapping and manual review creation.
- TG-2207: Add `/jobs_applied`, `/jobs_applied_today`, `/jobs_applied_week`, proof/status cards.

### Testing and QA

- Application cannot submit without idempotency key.
- Application cannot submit without passed policy check and proof readiness.
- Duplicate application attempt is prevented even under concurrent enqueue.
- Failed apply has terminal status and reason; no hanging applying state.
- Applied status requires confirmation artifact in tests or cannot be set.

### Sprint Definition of Done

- 100% of simulated submits have proof pack linkage.
- No status transition bypasses allowed transition map.
- All guard failures create clear audit events and Telegram/manual review when needed.
- Applied jobs are not included in digest by default; they are visible via explicit commands.
- Submit remains disabled globally until controlled provider sprint explicitly enables it.

### Exit gate

The system has all safety infrastructure needed for first live submit experiment.

## Sprint 23: Review-first application flow with first provider

**Release gate:** R4 Review-first live boundary

**Goal:** Разрешить live submit только после human approval, для выбранного стабильного provider-а и в малых лимитах.

### Deliverables

- Provider submit implementation for selected first provider, behind review_first and IRREVERSIBLE_ACTIONS_ENABLED gate.
- Human-approved submit path through Telegram.
- First-N review configuration and audit.
- Live submit confirmation capture.
- Incident stop switch and rollback to read_only/dry_run.

### Work packages

- LIVE-2301: Select first provider based on R3 dry-run stability and operational risk.
- LIVE-2302: Implement real submit action in provider flow, disabled by default and gated by mode/config/policy.
- LIVE-2303: Wire Telegram approval to enqueue apply task with immutable approved draft hash.
- LIVE-2304: Capture pre-submit screenshot, submit action, post-submit screenshot, confirmation text/URL.
- LIVE-2305: Add emergency `/pause` and provider apply_disabled fallback on critical error.
- LIVE-2306: Run first small batch: manual approval for every submit, strict rate limits.
- QA-2307: Validate no duplicate, proof presence, provider status after each live submit.

### Testing and QA

- Submit task without valid approval is denied.
- Approval draft hash mismatch blocks submit if draft changed after approval.
- Provider critical failure flips provider to apply_disabled/degraded as configured.
- Every live applied record has confirmation artifact before status=applied.

### Sprint Definition of Done

- First live submit path works for selected provider under review_first.
- 0 duplicate applications in live/review-first batch.
- 100% of applied statuses include proof pack.
- Manual approval UX is understandable and low-friction.
- Any unsafe failure can stop further live submits immediately.

### Exit gate

Live application is possible, but still human-approved for every submit.

## Sprint 24: Controlled auto-apply for stable provider

**Release gate:** R4 Controlled auto-apply

**Goal:** Перейти от approve-every-submit к controlled auto-apply for high-confidence jobs only, with strict limits and rollback.

### Deliverables

- controlled_auto_apply mode for selected provider.
- Eligibility rules: score threshold, confidence, provider stable, recent canary pass, no risk flags, no duplicates, rate limits.
- Auto-apply dashboards and alerts.
- Gradual rollout plan: 5/day -> 10/day -> configured cap.
- Post-apply monitoring for responses/errors.

### Work packages

- AUTO-2401: Implement controlled_auto_apply eligibility evaluator.
- AUTO-2402: Configure high-confidence threshold stricter than balanced default for initial rollout.
- AUTO-2403: Require fresh successful canary before provider can auto-submit.
- AUTO-2404: Implement progressive rate limit ramp and automatic rollback on failure threshold.
- AUTO-2405: Add alerts: duplicate attempt, proof missing, failure rate, confirmation missing, provider block.
- AUTO-2406: Run monitored controlled auto-apply batch.
- QA-2407: Daily audit sample of applications and cover letters.

### Testing and QA

- Job with risk flag or possible duplicate does not auto-apply.
- Canary failure disables auto-apply but may keep read-only ingest.
- Rate limit ramp cannot exceed configured daily/hourly/provider/company caps.
- Proof missing alert fires and provider moves to safe mode.

### Sprint Definition of Done

- Controlled auto-apply runs for selected provider with 0 duplicates and 100% proof packs.
- Auto-apply eligibility decisions are explainable in audit/logs.
- Provider rollback to review_first/read_only works without data loss.
- Application success/failure metrics are visible.
- User receives digest/status only for important changes, not every application spam.

### Exit gate

R4 controlled auto-apply is operational for one stable provider.

## Sprint 25: Second provider enablement and apply maturity

**Release gate:** R4 Multi-provider apply

**Goal:** Расширить controlled apply на второй provider или зафиксировать его как read_only/apply_disabled с документированными причинами.

### Deliverables

- Second provider readiness assessment and decision.
- Provider-specific submit implementation or explicit defer plan.
- Cross-provider dedup hardening under live application conditions.
- Company-level and clone-group rate limits enforced across providers.
- R4 release report for application automation.

### Work packages

- MP-2501: Compare first and second provider dry-run/live risk: stability, forms, CAPTCHA, session, confirmation reliability.
- MP-2502: If ready, implement review_first live submit for second provider; otherwise mark apply_disabled with blockers.
- MP-2503: Enforce per_company and per_job_clone_group limits across hh/robota/telegram-derived jobs.
- MP-2504: Add conflict detection: same company similar role already applied recently.
- MP-2505: Add application history cards linking clone groups and company interactions.
- MP-2506: R4 audit: applications count, duplicates prevented, proof completeness, provider incidents.

### Testing and QA

- Two providers cannot both apply to same clone group within restricted window.
- Company limit blocks second same-company similar-role application when configured.
- Second provider follows same proof and policy requirements as first provider.
- Provider not ready cannot accidentally enter controlled_auto_apply.

### Sprint Definition of Done

- Multi-provider application policy is enforced centrally.
- Second provider has either controlled path or explicit blocked/read_only decision.
- Cross-provider dedup is proven on live-like cases.
- R4 application automation report is accepted.
- System can now run production-like job search + controlled apply within strict guardrails.

### Exit gate

R4 accepted: application automation is safe, auditable, rate-limited and multi-provider aware.


# Phase 5 - Conversation automation

Inbox sync, classification, reply drafting, review-first dispatch, controlled auto-replies and follow-ups.

## Sprint 26: Inbox sync provider contract and conversation linking

**Release gate:** R5 Conversation foundation

**Goal:** Получать ответы рекрутеров и надежно связывать их с вакансией, компанией, provider account and application history.

### Deliverables

- Inbox sync provider contract for supported providers/channels.
- Conversation model with provider conversation id, company, job, application, recruiter identity.
- Inbound message persistence and thread timeline.
- Conversation linking rules: exact application, provider thread, company/title similarity, manual link.
- Telegram `/responses` read-only command.

### Work packages

- CONV-2601: Реализовать syncInbox contract and queue integration.
- CONV-2602: Implement inbound_messages storage with raw payload, normalized text, attachments metadata, received_at.
- CONV-2603: Implement conversation linking algorithm with confidence and ambiguity handling.
- CONV-2604: Add recruiter/company memory fields: last contact, response rate, status, notes.
- CONV-2605: Add manual link/unlink review flow for ambiguous messages.
- TG-2606: Implement `/responses` and `/job <id>` conversation timeline section.
- QA-2607: Fixtures: exact reply, recruiter outreach without application, duplicate auto-reply, rejection, scheduling message, test assignment.

### Testing and QA

- Inbound message linked to application by provider thread id where available.
- Ambiguous company/title link creates manual review, not wrong attachment.
- Repeated provider sync does not duplicate messages.
- Thread timeline orders inbound/outbound/audit events correctly.

### Sprint Definition of Done

- Every inbound message has classification pending/ignored/manual state and source metadata.
- No outbound reply is attempted in this sprint.
- Conversation linking confidence is persisted and explainable.
- User can view new responses in Telegram.
- Provider inbox errors do not affect job discovery/apply pipeline.

### Exit gate

The system can ingest and track recruiter communication safely before auto-reply logic starts.

## Sprint 27: Message classification and priority engine

**Release gate:** R5 Classification

**Goal:** Классифицировать входящие сообщения, выделять intent, priority, deadlines, sensitive data and reply requirements.

### Deliverables

- Message classification schema and LLM/rule pipeline.
- Categories: acknowledgment, request_for_salary, location, notice_period, test_assignment, rejection, interview_invitation, scheduling_request, spam, unknown etc.
- Confidence thresholds and manual review fallback.
- Priority scoring for recruiter replies.
- Classification evaluation report.

### Work packages

- CLS-2701: Implement rule-based pre-classifier for obvious cases: rejection, scheduling keywords, salary requests, spam.
- CLS-2702: Implement LLM classification with schema: category, confidence, requires_reply, deadline, slots, sensitive_data_requested, allowed_auto_reply, reasons.
- CLS-2703: Implement priority score: interview invitations, deadlines, direct questions, high-value companies, stale unanswered messages.
- CLS-2704: Implement manual review fallback for unknown, low confidence, sensitive, legal, test assignment.
- CLS-2705: Persist classifications with model_version/prompt_version/rule_version.
- TG-2706: Render `/responses` grouped by priority and required action.
- QA-2707: Evaluation set with confusion matrix and target thresholds.

### Testing and QA

- Sensitive personal data request cannot auto-reply without fact policy approval.
- Test assignment category goes to manual review by default.
- Low-confidence classification does not dispatch reply.
- Scheduling request extracts slots where present and flags timezone ambiguity.

### Sprint Definition of Done

- Classification accuracy meets agreed threshold on fixture/eval set or gaps are documented.
- Every inbound message has classification or explicit classification_failed/manual_review state.
- Unknown category defaults to safe/manual, not auto-reply.
- Priority view helps user triage responses.
- Classification outputs are schema-validated and auditable.

### Exit gate

System understands recruiter messages enough to draft safe responses.

## Sprint 28: Template engine, fact validation and reply drafts

**Release gate:** R5 Reply drafting

**Goal:** Готовить исходящие ответы по утвержденным шаблонам и фактам без автоматической отправки.

### Deliverables

- Reply template engine with categories, variables, tone, language, max length.
- Fact registry mapping per template.
- Reply draft generation and validation pipeline.
- Thread contradiction checker v1.
- Telegram review cards for reply drafts.

### Work packages

- REPLY-2801: Implement templates for interest_confirmation, salary_range_reply, location_reply, notice_period_reply, stack_summary_reply, scheduling_reply, ask_for_details, polite_decline.
- REPLY-2802: Implement template variable resolver from fact registry/profile/thread context.
- REPLY-2803: Implement LLM adaptation layer constrained by template and approved facts.
- REPLY-2804: Implement outbound validation: facts, language, salary range, unsupported promises, sensitive data, length, placeholders.
- REPLY-2805: Implement contradiction check against previous outbound messages in thread.
- TG-2806: Render reply draft review cards with approve/reject/edit/manual review.
- QA-2807: Tests for each template category and unsupported fact scenario.

### Testing and QA

- Citizenship/right-to-work question blocks if fact registry forbids disclosure.
- Salary reply uses allowed range and does not reveal hidden target outside policy.
- Reply cannot contradict previous notice period/salary/location statement.
- LLM-adapted text cannot introduce new facts not in approved variable set.

### Sprint Definition of Done

- Every reply draft has template_id or generation_strategy, facts_used, validation_result and policy_decision.
- No reply is dispatched automatically in this sprint unless explicitly approved in review UX tests.
- Manual review path is created for all unsupported facts and uncertain classifications.
- Template library is versioned and documented.
- Reply drafts are readable, minimal and aligned with communication policy.

### Exit gate

The system can draft safe recruiter replies ready for review-first dispatch.

## Sprint 29: Review-first reply dispatch and outbound proof

**Release gate:** R5 Review-first replies

**Goal:** Включить отправку ответов рекрутерам только после approval, с idempotency, proof and delivery status.

### Deliverables

- Reply dispatch worker behind policy and approval.
- Outbound message idempotency and delivery status.
- Outbound proof pack: conversation, inbound reference, template, facts, text hash, delivery confirmation/screenshot/API result.
- Provider-specific reply form/API flow where supported, otherwise manual mode.
- Telegram approval flow for outbound replies.

### Work packages

- DISP-2901: Implement reply_dispatch_queue with idempotency key reply:{conversation_id}:{inbound_message_id}:{template_id}.
- DISP-2902: Implement provider reply dispatch for selected provider/channel, gated by approval and provider capabilities.
- DISP-2903: Capture delivery proof: API response, screenshot, message id, timestamp, status.
- DISP-2904: Implement failure handling: delivery_failed, policy_failed, thread_context_conflict, provider_unavailable.
- DISP-2905: Update conversation statuses: awaiting_bot_reply, replied_by_bot, awaiting_recruiter, manual_review_required.
- TG-2906: Approval action sends exact approved text hash only.
- QA-2907: Tests for double-click approval, changed draft, delivery retry, provider failure.

### Testing and QA

- Reply cannot dispatch without approval in review_first mode.
- Approved draft hash mismatch blocks dispatch.
- Duplicate approval/dispatch does not send two messages.
- Delivery failure creates terminal or retry status according to taxonomy.

### Sprint Definition of Done

- Review-first reply dispatch works for selected supported channel/provider.
- Every outbound message has validation, policy, audit and proof linkage.
- Outbound messages are visible in thread timeline.
- Manual review can resolve or suppress outbound reply requirements.
- No auto-reply category is enabled without explicit policy config.

### Exit gate

R5 can safely send human-approved recruiter replies.

## Sprint 30: Controlled auto-replies and follow-up MVP

**Release gate:** R5 Controlled conversation automation

**Goal:** Разрешить автоматическую отправку только для безопасных reply categories и добавить follow-up с жесткими лимитами.

### Deliverables

- Auto-reply allowlist for safe categories.
- Category-specific confidence thresholds and fact requirements.
- Auto-follow-up MVP for no-response cases, policy and limit controlled.
- Conversation metrics and alerts.
- R5 conversation automation release report.

### Work packages

- AUTO-R-3001: Configure safe auto-reply categories: acknowledgment, interest_confirmation, cv_already_sent, basic scheduling reply where calendar policy is clear.
- AUTO-R-3002: Require high classification confidence and no sensitive data for auto dispatch.
- AUTO-R-3003: Implement follow-up scheduler: after X days, max N follow-ups, per company/thread caps, stop on recruiter reply/rejection.
- AUTO-R-3004: Add alerts: unsupported fact attempted, reply validation spike, thread contradiction, delivery failure.
- AUTO-R-3005: Run controlled auto-reply batch and audit all auto-sent messages.
- QA-3006: Evaluation of auto-reply accuracy and no-unsupported-facts proof.

### Testing and QA

- Unknown/sensitive/test-assignment categories never auto-reply.
- Follow-up stops after recruiter replies or thread closes.
- Follow-up cannot exceed per-thread/company limits.
- Auto-reply proof pack is complete for 100% messages.

### Sprint Definition of Done

- Controlled auto-replies produce 0 unsupported fact incidents in test and monitored rollout.
- All auto-sent messages are auditable and can be viewed in Telegram timeline.
- Follow-up automation is conservative and rate-limited.
- Conversation statuses update correctly through reply cycles.
- R5 release is accepted before scheduling automation begins.

### Exit gate

R5 accepted: system can process recruiter replies and safely automate low-risk responses.


# Phase 6 - Interview coordination

Availability, slot extraction, scheduling replies, interview event and final interview card.

## Sprint 31: Availability rules and calendar integration strategy

**Release gate:** R6 Calendar foundation

**Goal:** Определить и реализовать источник доступности пользователя для interview scheduling.

### Deliverables

- Availability rules model: timezone, working days, preferred windows, buffers, min notice, max interviews per day.
- Calendar integration decision: internal rules only vs Google/Outlook sync for first release.
- Conflict checker and slot generator.
- Telegram commands/cards for availability preview and schedule constraints.
- Scheduling policy extension.

### Work packages

- CAL-3101: Implement availability_rules schema and validation.
- CAL-3102: Implement slot generator with timezone, min_notice_hours, meeting duration, buffers, max_interviews_per_day.
- CAL-3103: Implement conflict checker against existing interview_events and optional external calendar if chosen.
- CAL-3104: Extend policy engine for scheduling: no outside window, no overlap, no too-soon slots, no unknown timezone confirmation.
- TG-3105: Add `/interviews` read-only and availability summary cards.
- QA-3106: Timezone and DST tests for Europe/Vienna and recruiter-proposed zones.

### Testing and QA

- Slot generator never proposes outside allowed windows.
- DST/timezone conversion tests pass for Europe/Vienna.
- Existing interview blocks overlapping new proposals.
- Unknown timezone requires manual review before confirmation.

### Sprint Definition of Done

- Scheduling policy is explicit and test-covered.
- Availability can be inspected by user before auto scheduling starts.
- Calendar source decision is documented with tradeoffs.
- No interview confirmation action is enabled yet.
- System can safely propose candidate slots as drafts.

### Exit gate

The system knows when the user is available and how to avoid scheduling conflicts.

## Sprint 32: Slot extraction, proposal and confirmation workflow

**Release gate:** R6 Scheduling workflow

**Goal:** Обрабатывать scheduling requests: извлекать слоты, сравнивать с доступностью, предлагать альтернативы and confirm when policy allows.

### Deliverables

- Slot extraction from recruiter messages with timezone handling.
- Scheduling decision engine: accept proposed slot, propose alternatives, ask clarification, manual review.
- Scheduling reply templates and validation.
- Review-first interview confirmation flow.
- Conversation state transitions for interview_requested, slot_proposed, interview_scheduled.

### Work packages

- SCHED-3201: Implement slot extraction schema: date, time, timezone, duration, confidence, source text span.
- SCHED-3202: Implement scheduling decision: proposed slot fits -> draft confirmation; no fit -> draft alternatives; ambiguous -> ask clarification/manual.
- SCHED-3203: Implement scheduling reply templates: confirm slot, propose alternatives, ask for link/format, ask for timezone.
- SCHED-3204: Implement review-first confirmation: user approval required for first scheduling confirmations or all until R6 gate.
- SCHED-3205: Persist interview_event draft before confirmation and finalize after recruiter confirmation.
- TG-3206: Telegram cards for scheduling request with proposed slots and approve actions.
- QA-3207: Fixtures for single slot, multiple slots, timezone ambiguity, outside availability, link already included, recruiter asks for candidate slots.

### Testing and QA

- Slot outside availability creates alternative proposal, not confirmation.
- Ambiguous date/time requires manual review or clarification.
- Confirmation cannot be sent without scheduling policy allow/review approval.
- All scheduling replies pass fact/template validation.

### Sprint Definition of Done

- System can draft/dispatch scheduling replies in review-first mode.
- Interview event lifecycle is persisted and linked to conversation/job/company.
- No slot is confirmed outside policy.
- Timezones are displayed in user-local timezone and recruiter-relevant text where appropriate.
- Scheduling workflow integrates with conversation statuses.

### Exit gate

System can coordinate interview scheduling up to approved confirmation behavior.

## Sprint 33: Final interview card, summary pack and controlled scheduling automation

**Release gate:** R6 Interview automation

**Goal:** Довести pipeline до финальной точки: назначенное интервью и Telegram карточка с полным контекстом.

### Deliverables

- Final interview card: vacancy, company, date/time/timezone, format, link, recruiter, thread summary, expectations.
- Company/vacancy/thread summary pack.
- Controlled auto-confirm for low-risk scheduling cases if policy allows.
- Interview reminders/digest integration.
- R6 interview coordination release report.

### Work packages

- INT-3301: Implement final interview_event status and required fields validation.
- INT-3302: Implement summary pack generator: vacancy summary, company context, thread history, promised facts, risks/gaps, prep notes.
- INT-3303: Implement Telegram interview card and `/interviews` list/detail views.
- INT-3304: Implement controlled auto-confirm only for high-confidence, within-availability, no-sensitive, no-ambiguity cases.
- INT-3305: Add notification rules: user receives card only when interview scheduled, important change, or system issue.
- QA-3306: End-to-end test from inbound scheduling request to final interview card.
- REL-3307: R6 acceptance review with sample scheduled interviews.

### Testing and QA

- Interview_scheduled status cannot be set without required fields or clear next step.
- Final card includes all mandatory fields and summary.
- Auto-confirm cannot run when timezone ambiguous, availability conflict, low confidence or sensitive conditions exist.
- Thread summary does not invent facts and includes promises already made.

### Sprint Definition of Done

- Pipeline endpoint is achieved: interview scheduled and user receives complete card.
- All interview confirmations have policy/audit/proof records.
- Interview cards are concise but complete.
- Conversation status closes/updates correctly after scheduling.
- R6 is accepted before final production hardening/GA.

### Exit gate

R6 accepted: product can automate from job discovery through interview scheduling under controlled policies.


# Phase 7 - Production hardening, analytics and final product

Observability, security, deployment, optimization and GA acceptance.

## Sprint 34: Observability, dashboards, alerts and incident runbooks

**Release gate:** R7 Operations readiness

**Goal:** Сделать систему управляемой в production: видеть ошибки до пользователя, быстро останавливать опасные provider flows и расследовать incidents.

### Deliverables

- Metrics dashboards: pipeline, providers, queues, applications, conversations, interviews, LLM, costs, errors.
- Critical alerts: duplicate attempt, proof missing, provider stuck, failure rate, CAPTCHA, auth expired, policy unavailable, queue backlog, DB/object-store failure.
- DLQ triage workflow and Telegram/ops views.
- Runbooks for all critical incidents.
- SLO/SLA definitions for internal operations.

### Work packages

- OBS-3401: Implement OpenTelemetry/log correlation ids across API, workers, provider flows, LLM gateway.
- OBS-3402: Build dashboards for conversion funnel and technical health.
- OBS-3403: Implement alert rules and synthetic alert tests.
- OPS-3404: Implement DLQ triage commands/API: view, retry, discard, assign, resolve with audit.
- OPS-3405: Write runbooks: duplicate application, proof missing, selector broken, CAPTCHA, auth expired, queue stuck, prompt validation spike, Telegram webhook failure, DB migration rollback.
- QA-3406: Run incident drills and document time-to-detect/time-to-mitigate.

### Testing and QA

- Synthetic duplicate attempt triggers critical alert.
- Synthetic provider selector failure creates provider degraded/needs_review and runbook path.
- Queue backlog alert fires with correct queue and age labels.
- DLQ retry is audited and respects idempotency.

### Sprint Definition of Done

- Operators can identify and stop unsafe automation quickly.
- Every critical alert has a linked runbook and owner.
- Dashboards show both business funnel and technical risk.
- No critical incident class lacks detection.
- Operational evidence is available for GA review.

### Exit gate

Production system is observable and operable, not just functionally complete.

## Sprint 35: Security, privacy, compliance and provider policy hardening

**Release gate:** R7 Security readiness

**Goal:** Уменьшить риск утечки данных, нарушений provider policy, небезопасного хранения credentials and unsafe automation behavior.

### Deliverables

- Secrets manager integration and credential rotation procedure.
- Data classification and retention enforcement.
- PII/secrets log redaction tests.
- Provider policy review checklist and stop-on-block behavior.
- Security review report and remediation backlog.

### Work packages

- SEC-3501: Move provider credentials/session cookies to approved secrets/encrypted storage.
- SEC-3502: Add log redaction tests for tokens, cookies, resume data, email/phone if present, raw prompt sensitive fields.
- SEC-3503: Implement retention jobs for raw payloads, DOM snapshots, traces, prompts, recruiter messages per policy.
- SEC-3504: Enforce access control for object artifacts and proof packs.
- SEC-3505: Provider policy checklist: no CAPTCHA bypass, no anti-automation evasion, stop on explicit block/terms signal.
- SEC-3506: Dependency audit, license review for reused snippets, external_snippet_registry completion.
- QA-3507: Run security smoke: unauthorized access, token missing, artifact access, env dump safety, prompt injection regression.

### Testing and QA

- Secrets never appear in logs/test snapshots.
- Unauthorized user cannot access Telegram/API data or artifacts.
- Retention job deletes/expires artifacts according to policy and keeps required audit references.
- CAPTCHA/blocking detection never triggers bypass attempts.

### Sprint Definition of Done

- No production credential is stored in plaintext repo/env dumps/logs.
- Sensitive artifacts have access controls and retention metadata.
- Snippet reuse records have license/security status.
- Provider compliance stop rules are test-covered.
- Security blockers are resolved or explicitly accepted before GA.

### Exit gate

Security/privacy gate is ready for production acceptance.

## Sprint 36: Deployment, CI/CD, environments and rollback

**Release gate:** R7 Deployment readiness

**Goal:** Сделать production deployment repeatable, observable and reversible across dev/staging/production environments.

### Deliverables

- Environment model: local, dev, staging, production.
- CI pipeline: lint, typecheck, unit, coverage, integration, build, migration tests, fixture regression.
- Dockerized services and deployment manifests.
- Migration/rollback procedure and release checklist.
- Post-deploy canary automation and provider safe-mode defaults.

### Work packages

- DEP-3601: Define service topology: api, telegram-bot, workers, postgres, redis, object storage, secrets, observability.
- DEP-3602: Implement Docker/build pipeline and image versioning.
- CI-3603: Add CI stages and required checks for PR merge.
- CI-3604: Add fixture regression and provider selector tests to required checks.
- DEP-3605: Implement deploy script/process with migrations, healthchecks, graceful shutdown, queue drain.
- DEP-3606: Implement rollback process and test rollback in staging.
- CAN-3607: Post-deploy canary runs before provider auto-apply is re-enabled.

### Testing and QA

- Fresh staging environment can be provisioned and migrated from scratch.
- Failed deploy rolls back without losing application/conversation state.
- Workers gracefully stop without leaving tasks in hanging state.
- Post-deploy canary blocks auto-apply if provider check fails.

### Sprint Definition of Done

- Deployments are not manual snowflake operations.
- Every release has version, changelog, migration status, canary status and rollback plan.
- Production defaults are safe: no irreversible actions until mode and provider gates pass.
- CI prevents untested selector/policy/schema changes from shipping.
- Infrastructure documentation is complete enough for another engineer to operate.

### Exit gate

System can be deployed and rolled back safely.

## Sprint 37: Analytics dashboard, optimization models and template experiments

**Release gate:** R7 Product optimization

**Goal:** Добавить не только автоматизацию, но и product intelligence: какие источники, шаблоны, вакансии and companies actually convert.

### Deliverables

- Analytics dashboard: discovered -> shortlisted -> applied -> replied -> interview_scheduled conversion.
- Interview-likelihood model v1 from historical features.
- Provider reliability score and ranking.
- Template A/B testing framework with safety constraints.
- Low-quality vacancy model improvements.

### Work packages

- AN-3701: Build funnel metrics by provider, strategy, company, role, resume, template, time window.
- AN-3702: Implement interview-likelihood v1 features: freshness, source, company history, recruiter responsiveness, stack match, description quality, previous conversion.
- AN-3703: Implement provider reliability score: canary success, flow failure, response rate, confirmation reliability, blocking incidents.
- AN-3704: Implement template experiment assignment with guardrails: no unsupported facts, no unsafe categories, limited variants.
- AN-3705: Improve low-quality detection from rejected/ignored/no-response patterns.
- TG-3706: Add summarized analytics cards via `/pipeline` or future dashboard link.
- QA-3707: Validate metrics definitions and prevent double-counting.

### Testing and QA

- Funnel metrics are consistent with raw application/conversation/interview counts.
- Template experiment never bypasses policy validation.
- Interview-likelihood score does not override hard filters or policy.
- Provider reliability score changes after synthetic canary/failure events.

### Sprint Definition of Done

- User/ops can see where conversion is good or bad.
- Optimization features are advisory unless explicitly wired into policy thresholds.
- A/B testing is safe and auditable.
- Low-quality filters reduce noise without blocking high-value jobs through unreviewed logic.
- Analytics are based on durable data, not in-memory counters.

### Exit gate

Product can improve targeting and conversion over time, not just run static rules.

## Sprint 38: 7-day production soak and final acceptance

**Release gate:** R8 GA candidate

**Goal:** Проверить весь продукт end-to-end в production-like или controlled production режиме до финального принятия.

### Deliverables

- 7-day continuous run report.
- End-to-end acceptance test suite results.
- Final risk register and accepted residual risks.
- GA release checklist and sign-off package.
- Post-GA maintenance plan.

### Work packages

- GA-3801: Run continuous system for 7 days with configured providers, modes and rate limits.
- GA-3802: Verify full funnel: discover -> normalize -> dedup -> score -> draft -> dry-run/submit -> proof -> inbox -> classify -> reply -> schedule -> interview card.
- GA-3803: Audit sample of applications, replies, proof packs and interview cards.
- GA-3804: Check acceptance metrics: 0 duplicates, 100% irreversible proof, no unsupported facts, no stuck flows, no state loss.
- GA-3805: Run incident drills and rollback drill during soak window.
- GA-3806: Prepare final documentation pack: PRD, roadmap, ADRs, runbooks, provider playbooks, security report, release notes.
- GA-3807: Product/engineering sign-off and residual risk acceptance.

### Testing and QA

- 7-day continuous run has no state loss after controlled restarts.
- All irreversible actions have policy check, validation, audit and proof.
- No duplicate applications in real or test set.
- Failed flows have terminal outcomes and are visible in DLQ/manual review/provider status.
- User notifications follow digest/notification rules.

### Sprint Definition of Done

- Final product meets system acceptance, technical acceptance and performance acceptance criteria.
- All critical runbooks have been used in drill or reviewed with owner.
- Known P0/P1 issues are closed; P2/P3 issues have owner and timeline.
- GA mode is explicitly configured; unsafe providers remain read_only/apply_disabled.
- Post-GA monitoring and provider maintenance cadence are scheduled.

### Exit gate

Final product is accepted: stable job-search automation up to interview scheduling with deterministic provider flows and proof-bearing irreversible actions.


# Phase 8 - Post-GA scaling and provider expansion

Provider onboarding factory and long-term maintenance model.

## Sprint 39: Provider onboarding factory and long-term maintenance

**Release gate:** Post-GA scale

**Goal:** Сделать добавление новых providers repeatable and controlled instead of bespoke engineering each time.

### Deliverables

- Provider onboarding template and checklist.
- Provider fixture generator workflow.
- Selector/fingerprint update SLA and maintenance cadence.
- Provider reliability board and deprecation policy.
- Backlog for next providers and channels.

### Work packages

- SCALE-3901: Create provider onboarding playbook: discovery, policy review, read-only, fixtures, dry-run, canary, review-first, controlled auto-apply.
- SCALE-3902: Create tooling to scaffold ProviderModule, selector pack, fingerprints, fixture folders and tests.
- SCALE-3903: Define provider maintenance SLA: canary frequency, selector update process, failure threshold, deprecation criteria.
- SCALE-3904: Create provider scorecard: job volume, quality, response rate, failure rate, automation risk.
- SCALE-3905: Prioritize new providers and Telegram channels based on conversion and operational risk.
- SCALE-3906: Document governance for snippet reuse from OpenClaw/Hermes/others.

### Testing and QA

- New provider scaffold generates contract tests and placeholder playbook.
- Provider cannot be marked stable without onboarding checklist completion.
- Selector pack update requires fixture regression and canary pass.
- Provider deprecation/read_only/apply_disabled policy works through config and status transitions.

### Sprint Definition of Done

- Adding a provider is a defined process with acceptance gates.
- Maintenance is measurable through provider scorecards.
- Open-source snippets are tracked and reviewed before reuse.
- Future growth does not weaken deterministic automation rules.
- Post-GA roadmap is ready for continuous improvement cycles.

### Exit gate

The product is not only built, but maintainable and extensible over time.


# 10. Cross-sprint dependency map

## 10.1. Hard dependencies

| Capability | Must exist before | Reason |
|---|---|---|
| Durable DB state | Queue workers, provider flows, proof packs | Restart safety and auditability |
| Queue idempotency | Apply, reply, scheduling | Prevent duplicate irreversible actions |
| Candidate profile | Scoring, resume routing, cover letters, replies | Single source of user facts and constraints |
| Fact registry | Cover letters, replies, scheduling | Prevent hallucinated or unsupported disclosure |
| Policy engine | Apply, replies, interview confirmations | Centralized allow/deny decisions |
| LLM gateway schemas | Classification, generation, summaries | Prevent malformed/untrusted outputs |
| Manual review UX | review_first apply/reply/scheduling | Human approval fallback |
| Provider read-only stability | Dry-run apply | Need reliable job discovery and normalization |
| Selector/fingerprint registry | Flow runner | Deterministic browser identity checks |
| Dry-run success | Live submit | Submit is not allowed until dry-run is stable |
| Proof pack | Live submit/reply | Irreversible actions require evidence |
| Inbox linking | Classification/replies | Avoid wrong recruiter/thread responses |
| Availability rules | Scheduling confirmation | Avoid confirming outside user windows |
| Observability/runbooks | GA | Production without detection is unsafe |

## 10.2. Parallelizable streams

Some work can run in parallel if team capacity exists:

- Security and retention design can start during Phase 1, even though final security gate is Phase 7.
- Observability primitives can start during queue/provider work, not wait until Sprint 34.
- Provider playbooks should be updated in every provider sprint.
- LLM evaluations can grow continuously as new fixtures appear.
- Telegram UI snapshot tests can be developed alongside domain work.
- Deployment foundations can start before all product features are complete, as long as unsafe modes stay disabled.

# 11. Testing strategy by phase

| Phase | Required test evidence |
|---|---|
| Phase 0 | Repository verify, migrations, queue restart tests, access-control tests |
| Phase 1 | Profile validation, policy matrix, LLM schema validation, prompt injection regression, manual review idempotency |
| Phase 2 | Provider contract tests, fixture regression, normalization, dedup, scoring golden dataset, read-only soak |
| Phase 3 | Selector/fingerprint tests, browser dry-run, flow replay, canary, error taxonomy tests |
| Phase 4 | Cover letter validation, application guard tests, proof pack tests, review-first live submit audit, duplicate prevention |
| Phase 5 | Inbox sync idempotency, conversation linking, classification eval, reply validation, dispatch proof, auto-reply audit |
| Phase 6 | Timezone/DST tests, slot extraction eval, scheduling policy tests, interview card completeness |
| Phase 7 | Incident drills, security tests, CI/CD, deployment rollback, dashboards, 7-day soak |

# 12. Final acceptance criteria

The final product is accepted only if all statements below are true.

## 12.1. Product acceptance

- System runs continuously for at least 7 days.
- It collects jobs from configured hh, robota and Telegram channels, or explicitly approved replacements.
- It normalizes, deduplicates and scores jobs with explainable reasons.
- It prepares applications with correct resume and policy-safe cover letter.
- It auto-applies only through provider flows that are stable and explicitly enabled.
- It prevents duplicate applications across provider id, URL, content clone and company-role limits.
- It does not include the full list of applied jobs in digest.
- It shows applied jobs through `/jobs_applied`, `/jobs_applied_today`, `/jobs_applied_week` and `/job <id>`.
- It receives and classifies recruiter responses.
- It sends only allowed auto-replies.
- It coordinates interviews inside availability windows.
- It sends final interview cards with full context.
- It stores full audit timeline.
- It does not hang on provider failures.

## 12.2. Technical acceptance

- 100% irreversible actions have policy check, validation result and audit event.
- 100% application submits have proof pack.
- 100% outbound recruiter messages have validation and proof.
- 100% interview confirmations have scheduling policy proof.
- No application can be sent without idempotency key.
- No reply can be sent without idempotency key.
- All LLM outputs are schema validated.
- Provider-flow errors map to error taxonomy.
- Selector packs are versioned.
- Canaries exist for production providers.
- Replay mode exists for failed browser flows.
- Queue tasks are idempotent.
- DLQ is monitored.
- Secrets are not logged.
- CAPTCHA/blocking does not trigger bypass attempts.

## 12.3. Performance acceptance

| Operation | Target |
|---|---:|
| New job processing without browser | <= 10 seconds under normal load |
| Message classification | <= 5 seconds under normal load |
| Digest generation | <= 30 seconds |
| Telegram normal command response | <= 3 seconds |
| Queue task stuck detection | within configured timeout |
| Provider canary failure detection | within scheduled canary interval |
| Browser dry-run | provider-specific SLO, no unbounded hang |

## 12.4. Safety acceptance

- No unsupported facts in outbound messages.
- No hallucinated facts in cover letters.
- No salary expectation outside configured policy.
- No interview outside availability policy.
- No automatic handling of legal/offers/sensitive data beyond approved matrix.
- No generic agentic clicking in production.
- No direct LLM execution of browser/send/submit actions.
- No automated CAPTCHA/bot-protection bypass.

# 13. Required project documents and artifacts

By the time GA is reached, the repository or delivery folder should contain:

- PRD v1.0 and later revisions.
- This roadmap/sprint plan.
- ADR-001 Purpose-built core over generic agent runtime.
- ADR-002 Deterministic provider flows.
- ADR-003 LLM as assistant, not executor.
- ADR-004 Proof-bearing irreversible actions.
- ADR-005 Provider onboarding and stability model.
- ERD/data model document.
- Queue and worker architecture document.
- Provider playbooks for each provider.
- Selector/fingerprint maintenance guide.
- LLM gateway and prompt/versioning guide.
- Fact registry and communication policy guide.
- Security and privacy policy.
- Deployment and rollback guide.
- Incident runbooks.
- Release notes for R0-R8.
- Final 7-day soak report.

# 14. Recommended repository documentation layout

```text
/docs
  /prd
    Telegram Job Search Automation v1.0.md
  /roadmap
    Implementation Roadmap and Sprint Plan v1.0.md
  /adr
    ADR-001-purpose-built-core.md
    ADR-002-deterministic-provider-flows.md
    ADR-003-llm-boundaries.md
    ADR-004-proof-bearing-actions.md
    ADR-005-provider-onboarding.md
  /architecture
    data-model.md
    queues-and-workers.md
    policy-engine.md
    llm-gateway.md
    browser-automation.md
  /provider-playbooks
    hh.md
    robota.md
    telegram.md
  /runbooks
    duplicate-application.md
    proof-missing.md
    provider-selector-update.md
    provider-auth-expired.md
    captcha-detected.md
    dlq-triage.md
    stuck-queue.md
    telegram-webhook-failure.md
    db-migration-rollback.md
  /releases
    R0-baseline.md
    R1-profile-policy.md
    R2-read-only.md
    R3-dry-run.md
    R4-auto-apply.md
    R5-conversation.md
    R6-interview.md
    R7-production-readiness.md
    R8-ga.md
```

# 15. Operating principle

The correct end state is not: "the agent figures it out".

The correct end state is:

```text
Provider module defines the flow.
Flow runner executes deterministic steps.
Policy engine decides whether the action is allowed.
LLM supplies structured interpretation or text.
Validation rejects unsafe output.
Idempotency prevents duplicate actions.
Proof layer records what happened.
Observability detects failure.
Telegram informs the user only when needed.
```

That is the product path from current local-safe core to final production-grade job-search automation.
