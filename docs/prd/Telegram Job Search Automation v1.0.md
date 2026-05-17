---
title: "PRD: Telegram Job Search Automation Core"
subtitle: "Development-ready product and technical requirements"
author: "Prepared for product and engineering"
date: "2026-05-16"
lang: ru-RU
---

# Контроль документа

| Поле | Значение |
|---|---|
| Название | Telegram Job Search Automation Core |
| Тип | Product Requirements Document + Technical Requirements |
| Версия | 1.0 development-ready draft |
| Дата | 2026-05-16 |
| Статус | Готово для архитектурного review и декомпозиции в backlog |
| Исходная база | Первичное ТЗ пользователя: Telegram-бот/агент для job-search pipeline до стадии назначения интервью |
| Главная архитектурная правка | OpenClaw/Hermes используются как reference/snippet source, но production-core строится как узкий deterministic automation runtime |

## Назначение PRD

Документ описывает продукт, архитектуру, технические контракты, данные, очереди, автоматизацию provider-ов, политики безопасности, acceptance criteria и этапы реализации системы, которая автоматически ведет job-search pipeline от появления вакансии до стадии назначенного live interview.

Документ должен быть достаточным, чтобы:

- начать разработку без отдельного discovery-документа;
- спроектировать БД, очереди, provider modules и Telegram-интерфейс;
- реализовать MVP без архитектурной переделки ядра;
- постепенно расширять систему до full production;
- контролировать риски дублирующих откликов, нестабильной browser automation, неконтролируемых LLM-решений и ошибок в коммуникации.

## Краткое executive summary

Система является персональным job-search ассистентом, управляемым через Telegram. Она 24/7 мониторит вакансии, нормализует и дедуплицирует их, оценивает релевантность, выбирает резюме, генерирует сопроводительное письмо, выполняет отклики в разрешенных сценариях, синхронизирует ответы рекрутеров, классифицирует входящие сообщения, автоматически отвечает в рамках утвержденной матрицы фактов и доводит процесс до назначения интервью.

Ключевое проектное решение: система не должна быть generic autonomous agent deployment. Production-core строится как специализированный deterministic runtime. LLM используется для извлечения, классификации, генерации текста и объяснения, но не как основной исполнитель навигации, не как единственный decision-maker и не как субъект irreversible actions.

# 1. Vision и продуктовая цель

## 1.1. Vision

Пользователь получает постоянно работающего ассистента, который берет на себя операционную работу по поиску вакансий и первичной коммуникации с рекрутерами, а пользователь подключается только в точках, где требуется человеческое решение: сомнительные факты, нестандартные вопросы, тестовые задания, юридически значимые обязательства, назначенное интервью, технические проблемы provider-ов.

## 1.2. Бизнес-цель

Максимально увеличить количество качественных откликов и конверсию в интервью при минимальном времени пользователя.

## 1.3. Операционная цель

Автоматизировать следующие участки:

- мониторинг вакансий на hh.ru, robota.ua, Telegram-каналах и будущих provider-ах;
- фильтрацию, hard filters, relevance scoring и interview-likelihood scoring;
- выбор резюме и генерацию cover letter;
- отправку отклика в поддерживаемых сценариях;
- хранение истории всех откликов;
- синхронизацию входящей коммуникации;
- классификацию, приоритизацию и reply decision;
- генерацию и отправку безопасных автоответов;
- согласование interview slots;
- отправку пользователю карточки назначенного интервью.

## 1.4. Граница automated pipeline

Автоматизированный pipeline завершается, когда:

- интервью назначено;
- есть дата, время, timezone, формат и ссылка или clear next step;
- пользователь получил карточку интервью с summary вакансии, компании и переписки;
- thread переведен в состояние `interview_scheduled`.

После этой точки система может помогать summary и подготовкой, но не должна самостоятельно вести переговоры об оффере, компенсации вне рамок, юридических документах или персональных данных.

# 2. Scope, non-scope и режимы продукта

## 2.1. In scope

| Область | Требования |
|---|---|
| Job discovery | Поиск вакансий в job boards и Telegram-каналах |
| Job normalization | Raw payload -> normalized job schema |
| Deduplication | Между источниками, компаниями, job clones и повторными публикациями |
| Scoring | Relevance score, interview-likelihood score, rejection reasons |
| Resume routing | Выбор версии резюме по профилю, роли, языку, стеку |
| Cover letter | Генерация письма без вымышленных фактов |
| Auto-apply | Только provider flows, прошедшие acceptance criteria |
| Inbox sync | Получение сообщений от рекрутеров по поддерживаемым каналам |
| Auto-reply | Только safe categories и approved facts |
| Scheduling | Предложение, сравнение и подтверждение interview slots |
| Telegram control | Команды управления, статусы, дайджесты, manual review |
| Audit | Timeline и proof pack для irreversible actions |
| Monitoring | Метрики, алерты, canary, replay, DLQ |

## 2.2. Explicitly out of scope для первой production-версии

- обход CAPTCHA, bot protection и антиавтоматизационных блокировок;
- массовая рассылка вне job application context;
- подтверждение офферов или юридически значимых условий;
- изменение профиля пользователя без explicit approval;
- автономное выполнение тестовых заданий;
- фальсификация опыта, навыков, локации, гражданства или права на работу;
- автоматическая коммуникация на темы, не включенные в матрицу допустимых фактов;
- generic агент, который сам решает, куда кликать на сайте в production;
- подключение всего OpenClaw/Hermes runtime как неограниченного orchestration layer.

## 2.3. Product modes

| Mode | Назначение | Поведение |
|---|---|---|
| `read_only` | Безопасный старт | Сбор, нормализация, скоринг, но без отправки откликов |
| `dry_run_apply` | Тест browser-flow | Доходит до submit boundary, но не отправляет отклик |
| `review_first` | Первые N откликов с подтверждением | Бот готовит draft, пользователь подтверждает |
| `controlled_auto_apply` | Ограниченный автопилот | Auto-apply только для stable provider-ов и high-confidence jobs |
| `full_auto_apply` | Целевой режим | Автоотклики по политике, лимитам и guardrails |
| `conversation_only` | Автоматизация переписки | Обрабатывает входящие и safe replies без новых откликов |
| `paused` | Пауза | Не выполняет новые irreversible actions |

# 3. Архитектурное решение: purpose-built core

## 3.1. Главный принцип

Система должна быть построена как Job Search Automation Core, а не как generic agent framework. OpenClaw, Hermes и аналогичные проекты могут использоваться как reference systems, источники архитектурных паттернов и отдельных фрагментов кода после review, но production flow должен быть узким, проверяемым и детерминированным.

## 3.2. Reference-only policy для OpenClaw/Hermes

Разрешенные режимы использования:

1. `reference_only` - изучение подходов к gateway, channel integration, browser tools, sessions, skills, cron.
2. `snippet_reuse` - перенос отдельных функций или паттернов после license, dependency и security review.
3. `isolated_adapter` - ограниченный внешний компонент через API, без доступа к irreversible actions.
4. `prototype_only` - эксперименты, которые не входят в production path.

Запрещено:

- делать OpenClaw/Hermes главным production orchestrator-ом;
- давать generic-agent toolset доступ к отправке откликов, сообщений и календарных подтверждений без policy gate;
- включать community plugins/skills без security audit;
- позволять агенту самостоятельно выбирать UI-кнопки в production;
- использовать browser automation primitives для обхода ограничений сайта.

## 3.3. Production-core components

Целевая архитектура:

```text
Telegram User Interface
        |
        v
Control Plane API ------------------------ Admin / Ops Dashboard
        |
        v
Job Automation Core
  |-- Provider Runtime
  |-- Search Compiler
  |-- Ingest Engine
  |-- Parser / Normalizer
  |-- Dedup Engine
  |-- Scoring Engine
  |-- Resume Router
  |-- Cover Letter Engine
  |-- Application Orchestrator
  |-- Conversation Engine
  |-- Calendar Coordination Engine
  |-- Policy Engine
  |-- Audit / Proof Layer
  |-- Monitoring / Replay / Canary
        |
        v
PostgreSQL + Redis/Queue + Object Storage + Secrets Store
```

## 3.4. Deterministic-first, LLM-last

Иерархия способов доступа к provider-у:

1. official API или documented interface;
2. structured HTTP flow, если он стабилен и допустим;
3. deterministic browser automation;
4. LLM-assisted extraction и fallback diagnostics;
5. manual handoff.

LLM может читать, классифицировать, суммировать и генерировать текст. Provider-flow кликает, валидирует, отправляет и логирует.

## 3.5. Irreversible actions

Irreversible actions:

- отправка отклика;
- отправка сообщения рекрутеру;
- подтверждение interview slot;
- изменение профиля кандидата;
- отправка файла;
- изменение статуса provider account.

Каждое irreversible action должно проходить:

```text
input -> policy check -> validation -> dry-run capability check
      -> action guard -> execution -> proof capture -> audit log
```

# 4. Рекомендуемый технический стек

## 4.1. MVP stack

| Слой | Рекомендация | Причина |
|---|---|---|
| Runtime | Node.js 22/24 + TypeScript | Совместимость с Playwright и Telegram ecosystem |
| API | Fastify или NestJS | Typed API, middleware, DI, lifecycle hooks |
| Browser automation | Playwright | Stable selectors, browser contexts, screenshots, tracing |
| Telegram bot | grammy или Telegraf | Mature Telegram bot frameworks |
| Database | PostgreSQL 16+ | Transactional integrity, JSONB, indexes, audit data |
| Queue | Redis + BullMQ для MVP | Быстрый старт, retries, concurrency limits |
| Workflow engine | Temporal как target architecture | Durable workflows, state machines, replay, retries |
| Object storage | S3-compatible | Raw payload, screenshots, traces, DOM snapshots |
| Secrets | Vault, Doppler, SOPS или cloud KMS | Credential isolation |
| Observability | OpenTelemetry + Prometheus + Grafana + Sentry | Metrics, traces, errors |
| LLM gateway | Отдельный provider-agnostic service | Model routing, JSON schema validation, retry, cost control |

## 4.2. Почему не только Redis queue

Redis/BullMQ достаточно для MVP. Но для долгоживущих provider-flow, retries, compensation, replay и orchestration лучше проектировать границы так, чтобы позже перейти на Temporal без переписывания business logic.

Минимальное требование: каждый worker должен быть stateless, а workflow state должен храниться в БД, чтобы рестарт не ломал pipeline.

## 4.3. Repository layout

```text
/apps
  /api                # Control Plane API
  /telegram-bot       # Telegram adapter
  /worker-ingest      # Job discovery and normalization
  /worker-apply       # Browser automation and applications
  /worker-inbox       # Inbox sync and message classification
  /worker-digest      # Digest generation
  /worker-canary      # Provider health and canary flows
/packages
  /domain             # Entities, value objects, policies
  /db                 # Migrations, repositories, generated client
  /providers          # Provider module implementations
  /automation         # Browser runtime, flow engine, selectors
  /llm                # LLM gateway, schemas, validators
  /telegram-ui        # Command rendering, cards, keyboards
  /config             # Config schemas and loaders
  /observability      # Logging, metrics, tracing
  /testing            # Fixtures, replay, test factories
/infrastructure
  /docker
  /k8s
  /terraform
/docs
  /prd
  /adr
  /runbooks
  /provider-playbooks
```

# 5. Пользовательские роли и actor model

## 5.1. Actors

| Actor | Описание |
|---|---|
| User | Владелец профиля, принимает финальные решения |
| Bot | Telegram control surface |
| Provider Worker | Исполняет provider-specific flows |
| LLM Service | Выполняет extraction, classification, generation |
| Policy Engine | Принимает разрешение/запрет на действие |
| Recruiter | Внешний собеседник |
| Ops/Admin | Техническое обслуживание, provider debug, rollout |

## 5.2. Permissions

| Action | User | Bot | Worker | LLM | Ops |
|---|---:|---:|---:|---:|---:|
| View pipeline | yes | renders | no | no | yes |
| Edit candidate profile | yes | request only | no | no | optional |
| Send application | approve or policy | no | yes, gated | no | no |
| Send recruiter reply | approve or policy | no | yes, gated | draft only | no |
| Confirm interview slot | approve or policy | no | yes, gated | draft only | no |
| Modify provider selectors | no | no | no | no | yes |
| Disable provider | yes | command | yes on critical | no | yes |

# 6. Candidate profile domain

## 6.1. Candidate profile fields

Candidate profile хранит структурированные данные, которые используются для поиска, scoring, cover letters и communication policy.

Обязательные группы:

- identity;
- target roles;
- skills;
- seniority and years of experience;
- languages;
- geography;
- compensation expectations;
- employment preferences;
- resume versions;
- cover letter templates;
- recruiter reply templates;
- availability rules;
- fact registry;
- blacklists and whitelists;
- strategy settings.

## 6.2. Candidate profile schema

```yaml
candidate_profile:
  id: backend-node-main
  user_id: user-001
  display_name: Backend Node.js Profile
  active: true
  target_titles:
    - Backend Developer
    - Node.js Developer
    - TypeScript Backend Engineer
  primary_stack:
    - Node.js
    - TypeScript
    - NestJS
    - PostgreSQL
  secondary_stack:
    - AWS
    - Docker
    - Redis
    - GraphQL
  years_of_experience: 5
  seniority_targets:
    - middle_plus
    - senior
  languages:
    communication_default: en
    allowed:
      - en
      - ru
      - uk
  geography:
    current_location: Vienna, Austria
    allowed_work_formats:
      - remote
      - hybrid
    relocation:
      allowed: false
  compensation:
    min_monthly_eur: 4000
    target_monthly_eur: 5500
    disclose_mode: range_only
  employment:
    types:
      - full_time
      - contract
  strategies:
    default: balanced
    allowed:
      - aggressive
      - balanced
      - selective
```

## 6.3. Resume versions

Система должна поддерживать несколько резюме:

| Resume type | Назначение |
|---|---|
| `backend_node` | Node.js/TypeScript backend roles |
| `backend_general` | General backend roles |
| `fullstack_light` | Fullstack roles, если frontend не основной |
| `contractor` | Contract/freelance profile |
| `english_cv` | English-first communication |
| `localized_cv` | Provider/language-specific version |

Каждое резюме должно иметь:

- `resume_id`;
- filename;
- language;
- target stack;
- target seniority;
- allowed providers;
- object storage key;
- version;
- active flag;
- checksum;
- last_reviewed_at.

## 6.4. Fact registry

Fact registry - это список фактов, которые бот имеет право использовать.

```yaml
facts:
  current_location:
    value: Vienna, Austria
    disclosure: allowed
    categories:
      - location_reply
      - scheduling_reply

  salary_expectation:
    value:
      min: 4000
      max: 5500
      currency: EUR
      period: month
    disclosure: range_only
    categories:
      - salary_range_reply

  citizenship:
    value: null
    disclosure: forbidden_without_user_approval
    categories: []

  notice_period:
    value: 2 weeks
    disclosure: allowed
    categories:
      - notice_period_reply
```

## 6.5. Profile validation rules

Перед включением auto-apply профиль должен пройти валидацию:

- есть минимум одно active resume;
- есть целевые роли;
- заданы hard filters;
- заданы compensation rules;
- задан blacklist минимум для явно нежелательных компаний;
- задана матрица фактов;
- задана стратегия;
- настроены rate limits;
- настроены availability rules;
- есть user consent на автоматическую отправку откликов.

# 7. Search profiles и strategy engine

## 7.1. Search profile

Search profile - это компилируемая конфигурация поиска вакансий. Один candidate profile может иметь несколько search profiles.

Примеры:

- `backend_node_balanced`;
- `backend_node_aggressive`;
- `senior_backend_selective`;
- `remote_contracts_only`.

## 7.2. Strategy modes

| Strategy | Threshold | Поведение |
|---|---:|---|
| `aggressive` | 60 | Максимум охвата, больше false positives, ниже personalized cover letter strictness |
| `balanced` | 72 | Оптимальный default, hard filters + score threshold |
| `selective` | 84 | Только high-confidence вакансии, меньше откликов, выше качество |

## 7.3. Search compiler

Search compiler преобразует профиль пользователя в provider-specific query plan.

```yaml
search_profile_id: backend_node_balanced
strategy: balanced
providers:
  hh:
    enabled: true
    queries:
      - Node.js backend
      - NestJS backend
      - TypeScript backend
    filters:
      remote:
        - remote
        - hybrid
      salary_min: 4000
      currency: EUR
      experience:
        - 3-6
        - 6+
    sort: newest
    max_pages_per_run: 5
    max_jobs_per_run: 100

  robota:
    enabled: true
    queries:
      - Node.js
      - Backend Developer
    filters:
      remote: true
      country:
        - Ukraine
        - remote_global
    sort: newest
    max_pages_per_run: 5

  telegram:
    enabled: true
    channels:
      - channel_id_1
      - channel_id_2
    include_keywords:
      - Node.js
      - Backend
      - TypeScript
      - NestJS
    exclude_keywords:
      - junior
      - intern
      - unpaid
```

## 7.4. Search reproducibility

Каждый search run сохраняет:

- search profile;
- provider;
- query;
- filters;
- timestamp;
- raw count;
- normalized count;
- deduped count;
- rejected count;
- shortlisted count;
- apply candidate count;
- stop condition;
- errors.

Это нужно для explainability: почему вакансия была найдена, пропущена, отклонена или отправлена.

# 8. Provider architecture

## 8.1. Provider module contract

Каждый сайт или источник реализуется как отдельный provider module.

```ts
export interface ProviderModule {
  providerId: string;
  capabilities: ProviderCapabilities;

  healthcheck(ctx: ProviderContext): Promise<ProviderHealth>;
  authenticate(ctx: AuthContext): Promise<AuthResult>;

  compileSearchPlan(
    profile: SearchProfile
  ): Promise<ProviderSearchPlan>;

  discoverJobs(
    plan: ProviderSearchPlan
  ): Promise<RawJobRef[]>;

  fetchJob(
    ref: RawJobRef
  ): Promise<RawJobPayload>;

  normalizeJob(
    raw: RawJobPayload
  ): Promise<NormalizedJobDraft>;

  deduplicateKey(
    job: NormalizedJobDraft
  ): Promise<DedupKey>;

  prepareApplication(
    input: PrepareApplicationInput
  ): Promise<ApplicationDraft>;

  dryRunApplication(
    draft: ApplicationDraft
  ): Promise<DryRunResult>;

  submitApplication(
    draft: ApplicationDraft
  ): Promise<ApplicationResult>;

  syncInbox(
    accountId: string
  ): Promise<InboundMessageDraft[]>;

  replayFlow(
    flowRunId: string
  ): Promise<ReplayReport>;
}
```

## 8.2. Provider capabilities

```yaml
provider_id: hh
capabilities:
  job_discovery: true
  job_detail_fetch: true
  auto_apply: true
  inbox_sync: true
  recruiter_reply: true
  file_upload: true
  cover_letter: true
  salary_filter: true
  remote_filter: true
  pagination: true
  browser_required: true
  official_api_available: unknown
  captcha_expected: possible
  deterministic_flow_supported: true
```

## 8.3. Provider stability status

| Status | Значение |
|---|---|
| `stable` | Flow работает, canary успешен, failure rate ниже threshold |
| `degraded` | Часть функций работает, повышенный failure rate |
| `read_only` | Чтение работает, auto-apply отключен |
| `apply_disabled` | Отклики отключены, ingest может продолжаться |
| `blocked` | Provider или account заблокирован/недоступен |
| `needs_review` | Изменился layout/API, требуется update |
| `deprecated` | Provider больше не поддерживается |

## 8.4. Provider onboarding checklist

Provider нельзя включать в auto-apply, пока не выполнено:

- module contract implemented;
- capabilities documented;
- selector pack v1 есть;
- page fingerprints есть;
- fixtures минимум 20 cases;
- canary flows есть;
- dry-run проходит с success rate >= 95% на тестовой выборке;
- dedup key logic есть;
- proof pack сохраняется;
- error taxonomy mapped;
- rate limits заданы;
- manual fallback path есть;
- monitoring и alerts подключены.

# 9. Deterministic browser automation

## 9.1. Production rule

В production запрещено свободное agentic clicking. Browser-flow должен быть описан как state machine с явными состояниями, fingerprint-ами, selector registry, guard-ами и artifact capture.

## 9.2. Flow state machine

```yaml
flow_id: provider_auto_apply_v1
provider: hh
entry_state: search_results
states:
  search_results:
    expected_fingerprint: hh_results_page
    actions:
      - open_job_card
    transitions:
      open_job_card: job_details

  job_details:
    expected_fingerprint: hh_job_page
    guards:
      - not_already_applied
      - vacancy_is_active
      - apply_button_exists
    actions:
      - click_apply
    transitions:
      click_apply: application_form

  application_form:
    expected_fingerprint: hh_apply_form
    guards:
      - resume_available
      - cover_letter_valid
      - no_captcha
    actions:
      - select_resume
      - fill_cover_letter
      - submit_application
    transitions:
      submit_application: confirmation

  confirmation:
    expected_fingerprint: hh_apply_confirmation
    actions:
      - capture_confirmation
      - persist_application_result
    terminal: true
```

## 9.3. Page fingerprinting

Каждая ключевая страница provider-а должна иметь fingerprint.

Fingerprint включает:

- URL pattern;
- title pattern;
- required DOM anchors;
- required text anchors;
- interactive elements;
- authorization indicators;
- apply button state;
- already applied indicators;
- CAPTCHA/blocking indicators;
- locale/language;
- optional screenshot or visual hash;
- version.

Flow не должен продолжаться, если fingerprint не совпал.

## 9.4. Selector registry

```yaml
provider: hh
selector_pack_version: 2026-05-16-v1
selectors:
  job_card:
    primary: "[data-qa='vacancy-serp__vacancy-title']"
    fallbacks:
      - "a[href*='/vacancy/']"
      - "xpath=//a[contains(@href, '/vacancy/')]"
    required: true

  apply_button:
    primary: "[data-qa='vacancy-response-link-top']"
    fallbacks:
      - "button:has-text('Откликнуться')"
      - "a:has-text('Откликнуться')"
    required: true

  cover_letter_textarea:
    primary: "textarea[name='letter']"
    fallbacks:
      - "[data-qa='vacancy-response-popup-form-letter-input']"
    required: false
```

Требования:

- selector key имеет primary и fallback;
- critical selector имеет минимум два fallback;
- selector pack версионируется;
- каждый selector тестируется на fixtures;
- flow log сохраняет фактически использованный selector;
- любое изменение selector pack проходит regression tests.

## 9.5. Action guards

Перед отправкой отклика должны пройти guards:

- vacancy status = active;
- hard filters passed;
- relevance score >= threshold;
- interview-likelihood score не ниже нижнего порога, если включен;
- company не в blacklist;
- dedup key не применялся раньше;
- resume selected;
- cover letter valid;
- provider status позволяет apply;
- account authenticated;
- no CAPTCHA;
- rate limits not exceeded;
- no manual review flag.

## 9.6. Browser session management

Требования:

- отдельный browser context на provider account;
- persistent auth state хранится зашифрованно;
- session не шарится между пользователями;
- session не шарится между provider-ами;
- session expiry детектируется до irreversible action;
- re-login flow не выполняется бесконтрольно;
- screenshots и traces сохраняются по retention policy;
- headless/headed mode конфигурируется;
- debug mode может запускаться только для ops.

## 9.7. CAPTCHA and blocking policy

Если обнаружена CAPTCHA, anti-bot block или explicit provider terms block:

- не обходить автоматически;
- остановить irreversible actions;
- сохранить screenshot, DOM snapshot, URL, timestamp;
- перевести provider/account в `degraded`, `read_only` или `blocked`;
- уведомить пользователя/ops в Telegram;
- создать manual review item.

# 10. Job ingest, parsing и normalization

## 10.1. Raw job lifecycle

```text
discovered -> raw_persisted -> parsed -> normalized
          -> deduplicated -> scored -> shortlisted/rejected
```

## 10.2. Normalized job schema

```ts
export interface NormalizedJob {
  id: string;
  sourceProvider: string;
  externalId: string;
  canonicalUrl: string | null;
  title: string;
  companyName: string | null;
  companyExternalId: string | null;
  location: string | null;
  workFormat: 'remote' | 'hybrid' | 'office' | 'unknown';
  compensationMin: number | null;
  compensationMax: number | null;
  compensationCurrency: string | null;
  compensationPeriod: 'hour' | 'month' | 'year' | 'unknown';
  seniority: string | null;
  employmentType: string | null;
  description: string;
  requirements: string[];
  responsibilities: string[];
  niceToHave: string[];
  language: string;
  contactMethod: string | null;
  publicationDate: string | null;
  rawPayloadId: string;
  extractionConfidence: number;
  createdAt: string;
  updatedAt: string;
}
```

## 10.3. Extraction confidence

Extraction confidence рассчитывается по полям:

| Поле | Вес |
|---|---:|
| title | 15 |
| company | 10 |
| canonical URL/external ID | 15 |
| description | 15 |
| requirements | 10 |
| location/work format | 10 |
| compensation | 10 |
| publication date | 5 |
| source consistency | 10 |

Если confidence < 70, вакансия может быть сохранена, но не должна идти в auto-apply без дополнительной проверки.

## 10.4. Telegram vacancy parsing

Telegram-каналы часто не имеют structured fields. Для Telegram требуется:

- извлекать text, channel id, post id, permalink, timestamp;
- выделять title, stack, compensation, contact, work format;
- определять, является ли пост вакансией;
- учитывать reposts и forwarded messages;
- дедуплицировать по company + title + stack + text hash;
- не отправлять отклики в Telegram без отдельной policy.

# 11. Deduplication

## 11.1. Dedup goals

Система должна предотвращать:

- повторные отклики на одну вакансию;
- отклики на клоны одной вакансии;
- повторные отклики в одну компанию по практически одинаковой роли;
- конфликтные threads по одной компании;
- повторную отправку после retry.

## 11.2. Dedup key levels

| Level | Key | Назначение |
|---|---|---|
| Provider job | provider + external_id | Точная дедупликация |
| Canonical URL | normalized canonical_url | Между повторными fetch-ами |
| Content hash | title + company + normalized description hash | Клоны |
| Company role | company + normalized title + seniority | Ограничение частоты по компании |
| Thread | provider + conversation_id | Связь с перепиской |

## 11.3. Dedup decision

```yaml
dedup_decision:
  status: duplicate | new | possible_duplicate
  confidence: 0.92
  matched_entities:
    - application_id: app_123
      match_type: content_hash
  action:
    - skip_apply
    - link_to_existing_company_thread
```

## 11.4. Idempotency

Каждый irreversible task должен иметь idempotency key:

```text
apply:{user_id}:{provider}:{external_job_id}:{resume_id}:{profile_id}
reply:{conversation_id}:{inbound_message_id}:{template_id}
interview_confirm:{conversation_id}:{slot_hash}
```

# 12. Scoring engine

## 12.1. Relevance score

Relevance score = 0-100. Сохраняется вместе с reasons.

Пример весов для `balanced`:

| Factor | Weight |
|---|---:|
| Title match | 15 |
| Primary stack match | 20 |
| Secondary stack match | 8 |
| Seniority fit | 10 |
| Work format fit | 10 |
| Geography fit | 8 |
| Compensation fit | 10 |
| Language fit | 5 |
| Resume similarity | 8 |
| Company priority/history | 4 |
| Low-quality penalty | -20 max |

## 12.2. Hard filters

Hard rejection examples:

- role is junior/intern when profile excludes it;
- compensation below minimum, если compensation указан явно;
- work format office-only outside allowed geography;
- company in blacklist;
- forbidden stack mismatch;
- vacancy is closed/archived;
- already applied;
- suspicious/scam indicators above threshold;
- provider extraction confidence below safe threshold for auto-apply.

## 12.3. Soft filters

Soft filters влияют на score, но не блокируют:

- нет зарплаты;
- неопределенный seniority;
- неполное описание;
- mixed stack;
- компания неизвестна;
- требования шире профиля;
- agency/recruiting firm.

## 12.4. Explainability

Для каждой вакансии сохранить 3-7 reasons.

```json
{
  "score": 82,
  "decision": "shortlisted",
  "reasons": [
    "Title matches target role: Backend Developer",
    "Primary stack match: Node.js, TypeScript, PostgreSQL",
    "Remote format is compatible",
    "Compensation is within target range",
    "No blacklist or duplicate detected"
  ],
  "risks": [
    "Company size unknown",
    "No explicit interview process description"
  ]
}
```

## 12.5. Interview-likelihood score

Отдельный score оценивает вероятность получить интервью.

Factors:

- история ответов компании;
- источник вакансии;
- свежесть публикации;
- наличие прямого контакта;
- совпадение стека;
- степень seniority fit;
- качество описания;
- recruiter responsiveness;
- прошлые конверсии по похожим вакансиям;
- low-quality/agency penalty.

Этот score не заменяет relevance. Он используется для приоритизации очереди откликов.

# 13. Resume router и cover letter engine

## 13.1. Resume selection

Resume router выбирает резюме по:

- language;
- target title;
- primary stack;
- seniority;
- provider constraints;
- file availability;
- user approval status;
- recency/version.

Output:

```json
{
  "resume_id": "resume_backend_node_en_v4",
  "confidence": 0.93,
  "rationale": [
    "Vacancy language is English",
    "Role is Node.js backend",
    "Provider allows PDF upload",
    "Resume is active and reviewed"
  ]
}
```

## 13.2. Cover letter generation rules

Cover letter должен:

- использовать только facts из profile/fact registry/resume;
- быть на языке вакансии или выбранном communication language;
- иметь ограничение длины;
- не выдумывать experience, employers, locations, compensation;
- не обещать availability вне календаря;
- не обсуждать чувствительные факты;
- проходить policy validation.

## 13.3. Cover letter schema

```json
{
  "job_id": "job_123",
  "resume_id": "resume_backend_node_en_v4",
  "language": "en",
  "text": "...",
  "facts_used": [
    "years_of_experience",
    "primary_stack",
    "current_location"
  ],
  "risk_flags": [],
  "validation_status": "passed",
  "model_version": "configured_by_llm_gateway",
  "created_at": "2026-05-16T10:30:00Z"
}
```

## 13.4. Validation

Cover letter не допускается к отправке, если:

- содержит fact вне registry/resume;
- compensation выходит за рамки;
- есть unsupported claim;
- язык не соответствует policy;
- текст слишком длинный;
- содержит placeholder;
- содержит прямое обещание интервью/созвона вне availability;
- schema validation failed.

# 14. Auto-apply orchestrator

## 14.1. Application lifecycle

```text
shortlisted
  -> application_prepared
  -> apply_queued
  -> apply_dry_run_passed
  -> applying
  -> applied | apply_failed | manual_review_required
```

## 14.2. Application statuses

| Status | Значение |
|---|---|
| `application_prepared` | Резюме и письмо готовы |
| `apply_queued` | Отклик поставлен в очередь |
| `apply_dry_run_passed` | Проверка до submit успешна |
| `applying` | Browser/API flow выполняется |
| `applied` | Подтверждение получено |
| `apply_failed` | Отклик не отправлен |
| `manual_review_required` | Нужен пользователь или ops |
| `apply_blocked_by_policy` | Policy запретила действие |
| `apply_blocked_by_provider` | Provider status запрещает |
| `duplicate_prevented` | Дубликат предотвращен |

## 14.3. Submit guard sequence

Перед submit:

```text
1. Re-fetch job status
2. Recompute dedup key
3. Check application idempotency key
4. Check provider status
5. Check account auth
6. Check rate limits
7. Check policy result
8. Check proof capture readiness
9. Check dry-run state
10. Submit
11. Capture confirmation
12. Persist application result
```

## 14.4. Proof pack для отклика

Обязательно сохранять:

- provider;
- account id;
- job id;
- external job id;
- candidate profile id;
- resume id;
- cover letter id;
- flow id and version;
- selector pack version;
- started_at/completed_at;
- browser session id;
- pre-submit screenshot;
- post-submit screenshot;
- DOM snapshot before/after;
- confirmation text;
- confirmation URL;
- network status, если доступен;
- final status;
- error code;
- audit event id.

# 15. Conversation engine

## 15.1. Message lifecycle

```text
inbound_received
  -> linked_to_job_or_company
  -> classified
  -> policy_checked
  -> reply_draft_created
  -> reply_validated
  -> dispatched | manual_review_required | ignored
```

## 15.2. Classification categories

| Category | Auto-reply allowed by default |
|---|---:|
| `auto_reply` | conditional |
| `acknowledgment` | yes |
| `recruiter_outreach` | conditional |
| `clarifying_question` | conditional |
| `request_for_details` | conditional |
| `request_for_salary_expectation` | yes, if fact policy allows |
| `request_for_location` | yes, if fact policy allows |
| `request_for_notice_period` | yes, if fact policy allows |
| `test_assignment` | no by default |
| `rejection` | no reply or polite ack |
| `interview_invitation` | conditional |
| `scheduling_request` | yes, with calendar policy |
| `spam_irrelevant` | no |
| `unknown` | no |

## 15.3. Message classification output schema

```json
{
  "category": "scheduling_request",
  "confidence": 0.91,
  "requires_reply": true,
  "deadline": null,
  "contains_interview_link": false,
  "proposed_slots": [
    {
      "date": "2026-05-20",
      "time": "14:00",
      "timezone": "Europe/Vienna"
    }
  ],
  "sensitive_data_requested": false,
  "allowed_auto_reply": true,
  "reasons": [
    "Recruiter asks to choose a time slot",
    "No sensitive data requested"
  ]
}
```

## 15.4. Safe auto-reply categories

Разрешенный автоматический контур:

- confirmation of interest;
- acknowledgment;
- short intro;
- salary range reply, если разрешено;
- location reply, если разрешено;
- notice period reply, если разрешено;
- remote preference reply;
- stack summary;
- CV already sent;
- interview interest;
- scheduling reply;
- ask for details;
- ask for interview format;
- polite follow-up;
- polite decline.

## 15.5. Outbound validation

Перед отправкой сообщения:

- no unsupported facts;
- no sensitive/legal facts outside policy;
- no salary conflict;
- no contradiction with thread memory;
- no commitment outside user profile;
- length <= template limit;
- language matches thread;
- tone matches communication policy;
- category allowed;
- confidence >= threshold;
- idempotency key not used.

# 16. Calendar coordination

## 16.1. Availability rules

```yaml
availability:
  timezone: Europe/Vienna
  default_windows:
    monday:
      - 10:00-13:00
      - 15:00-18:00
    tuesday:
      - 10:00-13:00
      - 15:00-18:00
    wednesday:
      - 10:00-13:00
    thursday:
      - 15:00-18:00
    friday:
      - 10:00-13:00
  buffer_minutes_before: 15
  buffer_minutes_after: 15
  max_interviews_per_day: 2
  min_notice_hours: 24
```

## 16.2. Scheduling decisions

| Scenario | Bot action |
|---|---|
| Recruiter gives one valid slot | Confirm if policy allows |
| Recruiter gives multiple slots | Pick best slot by availability rules |
| No proposed slots | Propose 2-3 available slots |
| Proposed slots unavailable | Propose alternatives |
| Timezone unclear | Ask clarification |
| Link missing after confirmation | Ask for link/invite |
| Calendar conflict | Manual review or alternative proposal |

## 16.3. Interview event schema

```json
{
  "interview_id": "int_123",
  "job_id": "job_123",
  "company_id": "company_456",
  "conversation_id": "conv_789",
  "date_time": "2026-05-20T14:00:00+02:00",
  "timezone": "Europe/Vienna",
  "format": "video_call",
  "link": "stored_or_redacted",
  "recruiter_name": "...",
  "status": "scheduled",
  "summary_pack_id": "summary_123"
}
```

## 16.4. Interview card

Telegram interview card содержит:

- компания;
- роль;
- дата/время/timezone;
- формат;
- ссылка;
- рекрутер;
- краткое summary вакансии;
- summary компании;
- история переписки;
- что уже сказано/обещано;
- возможные риски;
- подготовительные notes.

# 17. Telegram control plane

## 17.1. Commands

| Command | Назначение |
|---|---|
| `/start` | Инициализация |
| `/status` | Текущее состояние системы |
| `/pause` | Пауза irreversible actions |
| `/resume_bot` | Возобновление |
| `/mode` | Просмотр или смена mode |
| `/jobs_applied` | Список откликнутых вакансий |
| `/jobs_applied_today` | Отклики за день |
| `/jobs_applied_week` | Отклики за неделю |
| `/job <id>` | Карточка вакансии и timeline |
| `/responses` | Новые входящие ответы |
| `/interviews` | Назначенные интервью |
| `/pipeline` | Воронка |
| `/sources` | Статус provider-ов |
| `/profiles` | Профили поиска |
| `/set_profile <name>` | Переключить профиль |
| `/blacklist_company <name>` | Добавить blacklist |
| `/whitelist_company <name>` | Добавить whitelist |
| `/retry_provider <provider>` | Перезапустить provider task |
| `/manual_review` | Список ручных задач |
| `/digest_now` | Сгенерировать дайджест |
| `/logs <entity_id>` | Timeline и audit |

## 17.2. Digest rules

Digest не должен перечислять все вакансии, на которые бот откликнулся. Для этого есть отдельные команды.

Digest включает:

- новые ответы работодателей;
- требующие внимания диалоги;
- назначенные интервью;
- запросы уточнений;
- ошибки provider-ов;
- технические проблемы;
- pipeline stats;
- critical system events.

## 17.3. Telegram cards

Каждая card должна иметь:

- короткий заголовок;
- статус;
- primary fields;
- action buttons, если нужны;
- ссылку на `/job <id>` или `/logs <id>`;
- reason summary;
- next action.

Пример application card:

```text
Applied: Backend Node.js Developer
Company: Example GmbH
Provider: hh
Score: 84 / 100
Resume: backend_node_en_v4
Status: applied
Proof: available
Next: waiting for recruiter response
```

# 18. Data model

## 18.1. Core entities

| Entity | Назначение |
|---|---|
| `users` | Пользователи системы |
| `candidate_profiles` | Профили поиска |
| `search_profiles` | Search strategies/configs |
| `resumes` | Версии резюме |
| `fact_registry` | Допустимые факты |
| `source_providers` | Provider definitions |
| `source_accounts` | Аккаунты на provider-ах |
| `raw_jobs` | Raw payloads |
| `normalized_jobs` | Нормализованные вакансии |
| `dedup_jobs` | Dedup groups |
| `job_scores` | Scores and reasons |
| `applications` | Отклики |
| `application_artifacts` | Proof artifacts |
| `conversations` | Диалоги |
| `inbound_messages` | Входящие сообщения |
| `outbound_messages` | Исходящие сообщения |
| `message_classifications` | Результаты классификации |
| `interview_events` | Интервью |
| `digest_history` | История дайджестов |
| `audit_logs` | Audit timeline |
| `system_config` | Конфигурация |

## 18.2. Provider automation entities

| Entity | Назначение |
|---|---|
| `provider_modules` | Registered modules |
| `provider_capabilities` | Capabilities matrix |
| `provider_flow_definitions` | Flow state machines |
| `provider_flow_versions` | Flow versions |
| `provider_flow_runs` | Execution instances |
| `provider_flow_steps` | Step-level logs |
| `provider_flow_errors` | Error taxonomy mapping |
| `provider_health_checks` | Healthcheck results |
| `provider_canary_runs` | Canary history |
| `selector_packs` | Versioned selectors |
| `selector_usage_logs` | Used selectors |
| `page_fingerprints` | Page identity checks |
| `browser_sessions` | Browser sessions |
| `browser_artifacts` | Screenshots, traces, DOM |
| `automation_replay_reports` | Replay diagnostics |

## 18.3. Policy entities

| Entity | Назначение |
|---|---|
| `policy_versions` | Versioned policies |
| `policy_checks` | Check results |
| `outbound_validation_results` | Reply validation |
| `approval_requests` | User approvals |
| `manual_review_items` | Manual queue |
| `external_snippet_registry` | Reused snippets |
| `external_snippet_reviews` | License/security reviews |

## 18.4. Example table definitions

### applications

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| job_id | uuid | FK normalized_jobs |
| provider_id | text | Provider |
| external_job_id | text | Provider job id |
| candidate_profile_id | uuid | FK |
| resume_id | uuid | FK |
| cover_letter_id | uuid | FK |
| status | text | application status |
| idempotency_key | text | unique |
| dedup_key | text | indexed |
| flow_run_id | uuid | FK |
| submitted_at | timestamptz | nullable |
| failure_code | text | nullable |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### provider_flow_runs

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| provider_id | text | indexed |
| flow_id | text | |
| flow_version | text | |
| selector_pack_version | text | |
| entity_type | text | job/application/message |
| entity_id | uuid | |
| status | text | running/succeeded/failed |
| started_at | timestamptz | |
| completed_at | timestamptz | nullable |
| error_code | text | nullable |
| replay_available | boolean | |

### manual_review_items

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| entity_type | text | job/message/provider |
| entity_id | uuid | |
| reason_code | text | |
| severity | text | low/medium/high/critical |
| recommended_action | text | |
| status | text | open/resolved/ignored |
| created_at | timestamptz | |
| resolved_at | timestamptz | nullable |

# 19. Queues and workers

## 19.1. Queues

| Queue | Purpose |
|---|---|
| `source_poll_queue` | Provider polling |
| `telegram_channel_ingest_queue` | Telegram channel posts |
| `parsing_queue` | Raw -> normalized |
| `dedup_queue` | Deduplication |
| `scoring_queue` | Relevance and interview-likelihood |
| `resume_selection_queue` | Resume routing |
| `application_generation_queue` | Cover letter/draft |
| `auto_apply_queue` | Browser/API apply |
| `inbox_sync_queue` | Recruiter messages |
| `message_classification_queue` | Message classification |
| `reply_generation_queue` | Reply draft |
| `reply_dispatch_queue` | Send replies |
| `interview_coordination_queue` | Scheduling |
| `digest_queue` | Telegram digest |
| `canary_queue` | Provider canaries |
| `retry_queue` | Controlled retries |
| `dead_letter_queue` | Unrecoverable tasks |

## 19.2. Queue requirements

Каждая queue:

- durable;
- idempotent;
- имеет retry policy;
- имеет concurrency limit;
- имеет deduplication key;
- пишет audit event;
- пишет metrics;
- не теряет task при рестарте;
- не держит long-running state только в memory.

## 19.3. Retry policy

```yaml
retry_policy:
  default:
    max_attempts: 3
    backoff: exponential
    initial_delay_seconds: 30
    max_delay_minutes: 30
  browser_flow:
    max_attempts: 2
    retry_on:
      - navigation_timeout
      - network_error
      - transient_provider_unavailable
    no_retry_on:
      - captcha_required
      - selector_missing
      - page_fingerprint_mismatch
      - job_already_applied
  reply_dispatch:
    max_attempts: 3
    no_retry_on:
      - policy_failed
      - thread_context_conflict
```

# 20. Error taxonomy

## 20.1. Browser/navigation errors

- `page_fingerprint_mismatch`;
- `selector_missing`;
- `selector_ambiguous`;
- `unexpected_modal`;
- `navigation_timeout`;
- `form_schema_changed`;
- `confirmation_missing`;
- `page_locale_changed`;
- `javascript_error_detected`;
- `network_error`;
- `session_expired`.

## 20.2. Provider/account errors

- `login_required`;
- `auth_expired`;
- `account_locked`;
- `provider_rate_limited`;
- `provider_unavailable`;
- `provider_terms_block`;
- `captcha_required`;
- `anti_automation_detected`.

## 20.3. Business logic errors

- `job_already_applied`;
- `job_closed`;
- `job_not_matching_policy`;
- `resume_not_available`;
- `cover_letter_policy_failed`;
- `salary_policy_conflict`;
- `location_policy_conflict`;
- `facts_matrix_violation`;
- `duplicate_company_thread_detected`.

## 20.4. Error outcome rule

Ни один flow не должен зависать. Любая ошибка завершается одним из outcome:

- `retry_scheduled`;
- `manual_review_required`;
- `provider_disabled`;
- `apply_failed`;
- `read_only_fallback`;
- `dead_lettered`.

# 21. Policy engine

## 21.1. Policy inputs

Policy engine принимает:

- user mode;
- candidate profile;
- fact registry;
- provider status;
- rate limits;
- job score;
- dedup result;
- message classification;
- calendar availability;
- previous thread context;
- risk flags.

## 21.2. Policy output

```json
{
  "decision": "allow",
  "action": "send_application",
  "policy_version": "2026-05-16-v1",
  "checks": [
    { "name": "dedup", "result": "passed" },
    { "name": "rate_limit", "result": "passed" },
    { "name": "provider_status", "result": "passed" }
  ],
  "requires_user_approval": false,
  "reasons": []
}
```

Possible decisions:

- `allow`;
- `deny`;
- `requires_user_approval`;
- `requires_ops_review`;
- `defer`.

## 21.3. Policy categories

- apply policy;
- outbound reply policy;
- scheduling policy;
- fact disclosure policy;
- provider execution policy;
- rate limit policy;
- risk policy.

# 22. LLM gateway

## 22.1. LLM allowed uses

- extracting requirements from vacancy descriptions;
- language detection;
- summarizing vacancy/thread/company context;
- classifying inbound messages;
- extracting time slots;
- generating cover letters;
- adapting approved templates;
- explaining score/rejection reasons;
- diagnosing failed flow artifacts without executing actions.

## 22.2. LLM disallowed uses

LLM не может самостоятельно:

- решать, отправлять ли отклик без scoring/policy;
- нажимать submit;
- выбирать новые UI actions в production;
- менять salary expectations;
- добавлять неподтвержденные facts;
- подтверждать интервью вне calendar policy;
- обходить CAPTCHA/blocking;
- отправлять сообщения без validation.

## 22.3. Structured outputs

Все LLM outputs должны быть JSON-schema validated. Если validation failed, результат не используется.

## 22.4. Prompt injection controls

Scraped content и recruiter messages считаются untrusted input.

Controls:

- разделять system/developer/policy instructions и external text;
- не выполнять инструкции из вакансии или сообщения;
- не раскрывать secrets;
- не использовать scraped text как tool instruction;
- логировать prompt/input hashes;
- валидировать output schema;
- использовать allowlisted tools only;
- не давать LLM direct browser/send capabilities.

# 23. Monitoring, metrics и alerts

## 23.1. Core metrics

- jobs discovered by provider;
- jobs normalized;
- jobs rejected;
- jobs shortlisted;
- applications prepared;
- applications submitted;
- application success rate;
- duplicate prevention count;
- recruiter replies;
- auto replies sent;
- interviews scheduled;
- conversion: discovered -> applied;
- conversion: applied -> recruiter replied;
- conversion: recruiter replied -> interview scheduled;
- provider failure rate;
- selector failure rate;
- parsing confidence;
- average score;
- reply latency;
- queue depth;
- DLQ count;
- LLM cost and latency.

## 23.2. Alerts

Critical alerts:

- duplicate application attempted;
- irreversible action without proof pack;
- provider flow stuck beyond timeout;
- provider failure rate > threshold;
- auth expired on critical provider;
- CAPTCHA/blocking detected;
- policy engine unavailable;
- queue backlog above threshold;
- database write failure;
- object storage artifact failure;
- LLM schema validation failure spike.

## 23.3. Canary checks

Each provider:

- auth canary;
- search results canary;
- job page canary;
- apply form canary without submit;
- inbox canary;
- reply form canary without submit.

Canary запускается:

- по расписанию;
- после deploy;
- после изменения selector pack;
- после provider incident resolution.

# 24. Security and privacy

## 24.1. Data classification

| Data | Class | Controls |
|---|---|---|
| Resume files | Sensitive personal | Encryption, access logs, storage policy |
| Provider credentials | Secret | Secrets manager, no plaintext logs |
| Browser cookies | Secret | Encrypted, per account |
| Recruiter messages | Personal/business | Access control, retention |
| Screenshots/DOM | Sensitive | Object storage ACL, retention |
| Audit logs | Operational sensitive | Immutable write, no secrets |
| LLM prompts | Sensitive | Redaction, hashing, retention policy |

## 24.2. Credential rules

- no credentials in ENV dumps;
- no credentials in logs;
- encrypt at rest;
- rotate provider credentials manually or by policy;
- browser cookies stored per provider account;
- session export/import allowed only for ops with audit;
- failed login does not trigger infinite retries.

## 24.3. Object storage retention

Suggested defaults:

| Artifact | Retention |
|---|---:|
| Raw job payload | 180 days |
| Application proof screenshot | 365 days |
| DOM snapshots | 90 days |
| Browser traces | 30 days |
| Failed flow artifacts | 180 days |
| Recruiter messages | 365 days or user policy |
| LLM prompts/outputs | 90 days, redacted if possible |

## 24.4. Compliance and provider policy

Система должна уважать ограничения сайтов и не пытаться технически обходить защиту. При сигнале CAPTCHA, rate limiting, explicit block или нарушении provider terms automation переводится в safe mode/manual review.

# 25. Configuration

## 25.1. Main config schema

```yaml
app:
  mode: controlled_auto_apply
  timezone: Europe/Vienna
  environment: production

providers:
  hh:
    enabled: true
    status: stable
    mode: controlled_auto_apply
    rate_limits:
      applications_per_day: 40
      applications_per_hour: 6
      search_runs_per_hour: 4
  robota:
    enabled: true
    status: read_only
    mode: read_only
  telegram:
    enabled: true
    channels:
      - channel_id_1
      - channel_id_2

scoring:
  strategy: balanced
  thresholds:
    aggressive: 60
    balanced: 72
    selective: 84

applications:
  require_review_first_n: 20
  max_per_day: 80
  max_per_hour: 10
  max_per_company_per_day: 1
  max_per_company_per_week: 3

conversation:
  auto_reply_enabled: true
  min_classification_confidence: 0.82
  unknown_category_requires_review: true

calendar:
  timezone: Europe/Vienna
  min_notice_hours: 24
  max_interviews_per_day: 2

digest:
  schedule: "0 9,18 * * *"
  include_applied_jobs: false
```

## 25.2. Rate limits

```yaml
rate_limits:
  global:
    applications_per_day: 80
    applications_per_hour: 10
  per_provider:
    hh:
      applications_per_day: 40
      applications_per_hour: 6
      search_runs_per_hour: 4
    robota:
      applications_per_day: 30
      applications_per_hour: 5
  per_company:
    applications_per_day: 1
    applications_per_week: 3
  per_job_clone_group:
    applications_per_week: 1
```

# 26. Testing strategy

## 26.1. Test pyramid

| Layer | Tests |
|---|---|
| Unit | scoring, policies, parser helpers, dedup keys |
| Contract | provider module interface, LLM schemas, Telegram rendering |
| Fixture regression | parser/selectors/fingerprints on stored HTML/API fixtures |
| Integration | queues, DB, object storage, Telegram webhook |
| Browser E2E dry-run | provider flows to submit boundary |
| Replay | failed flow replay without live provider |
| Canary | live provider health without irreversible actions |
| Soak | 7-day continuous run |

## 26.2. Provider fixtures

Each provider needs fixtures:

- search page;
- job page;
- application form;
- confirmation page;
- already applied page;
- archived job;
- salary missing;
- remote/hybrid ambiguous;
- multi-language vacancy;
- recruiter message;
- scheduling message;
- rejection message;
- CAPTCHA/blocking page, if observed.

## 26.3. Acceptance test examples

### Duplicate prevention

Given a vacancy already applied by `provider + external_id`, when it is discovered again, then system must not prepare or send another application and must create `duplicate_prevented` audit event.

### Policy validation

Given recruiter asks for citizenship and fact registry forbids disclosure, when message is classified, then system must create manual review item and not send auto-reply.

### Browser fingerprint mismatch

Given provider page no longer matches expected fingerprint, when auto-apply flow runs, then flow stops with `page_fingerprint_mismatch`, saves artifacts, and provider status becomes `needs_review` or `degraded`.

# 27. Deployment and operations

## 27.1. Environments

| Environment | Purpose |
|---|---|
| `local` | Developer sandbox |
| `dev` | Shared integration |
| `staging` | Production-like provider tests, dry-run only |
| `production` | Live system |

## 27.2. Deployment requirements

- Dockerized services;
- migration command;
- healthchecks;
- graceful shutdown;
- queue draining;
- browser worker isolation;
- per-environment config;
- secrets not baked into images;
- rollback plan;
- canary run after deploy.

## 27.3. Runbooks

Must-have runbooks:

- provider selector update;
- provider auth expired;
- CAPTCHA detected;
- duplicate application incident;
- DLQ triage;
- stuck queue;
- LLM schema validation spike;
- Telegram webhook failure;
- object storage artifact failure;
- database migration rollback.

# 28. Rollout plan

## 28.1. Phase 0 - Architecture hardening

Deliverables:

- final ADR for purpose-built core;
- repository layout;
- DB schema v0;
- provider module contract;
- policy engine interface;
- LLM gateway interface;
- Telegram command skeleton.

Exit criteria:

- core service boots;
- migrations run;
- Telegram `/status` works;
- provider registry loads config;
- no irreversible actions available yet.

## 28.2. Phase 1 - Read-only ingest

Deliverables:

- hh/robota read-only discovery;
- Telegram channel ingest;
- raw payload storage;
- normalization;
- dedup;
- scoring;
- `/jobs_discovered` or `/pipeline`;
- digest without applied job list.

Exit criteria:

- 10,000 jobs processed without state loss;
- parsing confidence tracked;
- rejection reasons stored;
- no duplicate normalized entries above allowed tolerance.

## 28.3. Phase 2 - Apply dry-run

Deliverables:

- browser runtime;
- selector packs;
- fingerprints;
- dry-run apply flow;
- proof pack without submit;
- canary checks;
- replay reports.

Exit criteria:

- dry-run success rate >= 95% on test set;
- no irreversible actions;
- failed flows produce actionable diagnostics.

## 28.4. Phase 3 - Controlled auto-apply

Deliverables:

- submit enabled for one stable provider;
- review-first mode for first N applications;
- application proof pack;
- rate limits;
- duplicate prevention;
- failure alerts.

Exit criteria:

- 0 duplicate applications;
- 100% applied status has proof pack;
- 7-day controlled run;
- provider failure rate below threshold.

## 28.5. Phase 4 - Conversation automation

Deliverables:

- inbox sync;
- message classification;
- template engine;
- fact registry validation;
- outbound reply proof;
- manual review queue.

Exit criteria:

- safe auto-replies only;
- unknown/sensitive cases go to review;
- no unsupported facts in outbound messages.

## 28.6. Phase 5 - Interview coordination

Deliverables:

- calendar rules;
- slot extraction;
- slot proposal;
- interview confirmation;
- final interview card;
- summary pack.

Exit criteria:

- system can schedule interviews inside availability windows;
- no confirmation outside policy;
- user receives complete interview card.

## 28.7. Phase 6 - Optimization

Deliverables:

- interview-likelihood model;
- follow-up automation;
- provider reliability scoring;
- analytics dashboard;
- template A/B testing.

# 29. Acceptance criteria

## 29.1. System acceptance

System accepted if:

- works continuously for at least 7 days;
- collects jobs from hh, robota and configured Telegram channels;
- automatically scores and filters jobs;
- prepares applications with correct resume and cover letter;
- auto-applies only through stable provider flows;
- prevents duplicate applications;
- does not show all applied jobs in digest;
- shows applied jobs through Telegram commands;
- receives and classifies recruiter responses;
- sends only allowed auto-replies;
- coordinates interviews using calendar rules;
- sends final interview card;
- stores full audit timeline;
- all irreversible actions have proof records;
- failed provider flows do not hang.

## 29.2. Technical acceptance

- 100% irreversible actions have policy check, validation result and audit event;
- 100% application submits have proof pack;
- no application can be sent without idempotency key;
- all LLM outputs use schema validation;
- provider-flow errors map to taxonomy;
- selector packs are versioned;
- canary is implemented for production providers;
- replay mode works for failed browser flows;
- queue tasks are idempotent;
- DLQ is monitored;
- secrets are not logged;
- provider blocking/CAPTCHA does not trigger bypass attempts.

## 29.3. Performance acceptance

| Operation | Target |
|---|---:|
| New job processing without browser | <= 10 sec |
| Message classification | <= 5 sec |
| Digest generation | <= 30 sec |
| Search run per provider | Configurable, no stuck runs |
| Browser dry-run | Provider-specific SLO |
| Telegram command response | <= 3 sec for normal commands |

# 30. Risk register

| Risk | Severity | Mitigation |
|---|---:|---|
| Provider layout changes | High | Fingerprints, canary, selector packs, replay |
| Duplicate applications | Critical | Dedup keys, idempotency, submit guard |
| LLM hallucinated facts | Critical | Fact registry, schema validation, policy checks |
| CAPTCHA/blocking | High | Stop, manual review, no bypass |
| Credential leakage | Critical | Secrets manager, encryption, log redaction |
| Queue state loss | High | Durable queues, DB state, idempotency |
| Wrong recruiter reply | High | Classification thresholds, manual review, validation |
| Interview scheduled outside availability | High | Calendar policy, min notice, buffers |
| Open-source snippet risk | Medium | Snippet registry, license/security review |
| Provider ToS violation | High | Read policy, stop on block, manual review |

# 31. External snippet reuse policy

## 31.1. Snippet registry

Каждый заимствованный фрагмент должен иметь запись:

| Field | Description |
|---|---|
| source_project | OpenClaw/Hermes/other |
| repository | Source repository |
| commit_hash | Exact source commit |
| license | License |
| copied_files | Files/functions copied |
| purpose | Why needed |
| owner | Engineer responsible |
| dependency_impact | Dependencies introduced |
| security_review | pending/passed/failed |
| test_coverage | Tests added |
| modifications | Local changes |
| update_policy | How updates are handled |

## 31.2. Safe reuse categories

Наиболее безопасно переносить:

- browser snapshot parsing patterns;
- selector helpers;
- session abstractions;
- retry primitives;
- structured tool schemas;
- artifact capture;
- diagnostics/replay utilities;
- cron/task scheduling patterns.

## 31.3. Review required

Нельзя переносить без review:

- shell/process execution;
- plugin loading;
- dynamic code execution;
- credential handling;
- messaging dispatch;
- browser tools with broad access;
- calendar/email sending;
- file-system access;
- skills/plugins from community sources.

# 32. Development backlog

## 32.1. Epic A - Core platform

Tasks:

- create monorepo;
- implement config loader;
- implement DB migrations;
- implement audit log service;
- implement object storage adapter;
- implement queue abstraction;
- implement Telegram bot skeleton;
- implement `/status`, `/pause`, `/resume_bot`.

## 32.2. Epic B - Candidate profile and policies

Tasks:

- candidate profile schema;
- resume registry;
- fact registry;
- communication policy;
- rate limit policy;
- policy engine interface;
- policy check persistence;
- Telegram profile commands.

## 32.3. Epic C - Job ingest and scoring

Tasks:

- provider registry;
- hh read-only provider;
- robota read-only provider;
- Telegram channel provider;
- raw job persistence;
- normalization;
- dedup;
- relevance scoring;
- interview-likelihood placeholder;
- `/pipeline` view.

## 32.4. Epic D - Browser automation core

Tasks:

- Playwright runtime;
- browser session store;
- selector registry;
- page fingerprint engine;
- flow state machine runner;
- artifact capture;
- dry-run mode;
- replay reports;
- canary runner.

## 32.5. Epic E - Auto-apply

Tasks:

- resume router;
- cover letter generator;
- cover letter validation;
- application draft;
- submit guards;
- idempotency;
- proof pack;
- provider-specific apply flow;
- `/jobs_applied` commands.

## 32.6. Epic F - Conversation automation

Tasks:

- inbox sync provider contract;
- conversation linking;
- message classification;
- template engine;
- outbound validation;
- reply dispatch;
- manual review queue;
- `/responses` command.

## 32.7. Epic G - Interview coordination

Tasks:

- availability rules;
- slot extraction;
- slot proposal;
- slot confirmation;
- interview event persistence;
- interview card;
- `/interviews` command;
- summary pack.

## 32.8. Epic H - Observability and ops

Tasks:

- metrics;
- dashboards;
- alerts;
- DLQ viewer;
- provider health view;
- runbooks;
- security logs;
- deployment scripts.

# 33. Definition of Done

## 33.1. Feature DoD

Feature считается готовой, если:

- implemented;
- unit tests passed;
- integration tests passed where relevant;
- audit events added;
- metrics added;
- error handling mapped;
- docs/runbook updated;
- Telegram UX verified;
- no secret/PII logging;
- acceptance criteria covered.

## 33.2. Provider DoD

Provider ready for production if:

- read-only ingest stable;
- normalization confidence acceptable;
- selector pack versioned;
- fingerprints versioned;
- dry-run passes;
- canary passes;
- failure modes mapped;
- proof pack works;
- rate limits configured;
- manual fallback exists;
- no CAPTCHA/blocking workaround exists.

## 33.3. Auto-reply DoD

Auto-reply ready if:

- category schema validated;
- template exists;
- fact registry mapping exists;
- validation prevents unsupported facts;
- confidence thresholds configured;
- manual review fallback works;
- thread contradiction check implemented;
- outbound proof stored.

# 34. Open questions for product/engineering

Эти вопросы не блокируют MVP, но должны быть закрыты до full auto-apply:

1. Какие provider-ы включаются первыми в auto-apply, а какие остаются read-only?
2. Нужен ли Google Calendar/Outlook integration или достаточно internal availability rules на MVP?
3. Какие факты пользователь разрешает раскрывать автоматически?
4. Какие зарплатные диапазоны считать hard minimum и preferred target?
5. Нужен ли assistant-mediated voice или direct-person voice по умолчанию?
6. Какой лимит откликов считать безопасным для каждого provider-а?
7. Какие Telegram-каналы считаются доверенными?
8. Нужно ли сохранять все LLM prompts или только redacted versions?
9. Нужен ли web dashboard после Telegram MVP?
10. Какие критерии low-quality вакансий пользователь считает критичными?

# 35. Appendix A - Status model

## 35.1. Job statuses

- `discovered`;
- `raw_persisted`;
- `parsed`;
- `normalized`;
- `deduplicated`;
- `rejected`;
- `shortlisted`;
- `application_prepared`;
- `apply_queued`;
- `applied`;
- `apply_failed`;
- `archived`.

## 35.2. Conversation statuses

- `no_response`;
- `recruiter_replied`;
- `awaiting_bot_reply`;
- `replied_by_bot`;
- `awaiting_recruiter`;
- `interview_requested`;
- `interview_slot_proposed`;
- `interview_scheduled`;
- `closed_rejected`;
- `closed_inactive`.

## 35.3. Provider statuses

- `stable`;
- `degraded`;
- `read_only`;
- `apply_disabled`;
- `blocked`;
- `needs_review`;
- `deprecated`.

# 36. Appendix B - Example audit event

```json
{
  "event_id": "audit_123",
  "entity_type": "application",
  "entity_id": "app_456",
  "event_type": "application_submitted",
  "actor": "worker-apply",
  "policy_version": "2026-05-16-v1",
  "timestamp": "2026-05-16T12:00:00Z",
  "payload": {
    "provider": "hh",
    "job_id": "job_123",
    "resume_id": "resume_backend_node_en_v4",
    "proof_pack_id": "proof_789"
  }
}
```

# 37. Appendix C - Example manual review item

```json
{
  "id": "review_123",
  "entity_type": "inbound_message",
  "entity_id": "msg_456",
  "reason_code": "sensitive_data_requested",
  "severity": "high",
  "summary": "Recruiter asks about citizenship. Fact registry forbids auto-disclosure.",
  "recommended_action": "Ask user to approve or reject disclosure.",
  "status": "open"
}
```

# 38. Appendix D - Minimal MVP cut

Если нужно максимально быстро начать, минимальный production-safe MVP:

1. Telegram bot with `/status`, `/pause`, `/resume_bot`, `/pipeline`.
2. Candidate profile + resume registry + fact registry.
3. Read-only ingest for one job board and Telegram channels.
4. Normalization, dedup, scoring, rejection reasons.
5. Application draft generation without submit.
6. Dry-run browser automation to submit boundary.
7. Manual approval for first N applications.
8. Proof capture and audit log.
9. Inbox sync for one provider or manual imported messages.
10. Safe auto-reply drafts, but dispatch behind approval.

После этого можно включать controlled auto-apply для одного provider-а.

# 39. Appendix E - ADR summary

## ADR-001: Purpose-built core over generic agent runtime

Decision: build a specialized Job Search Automation Core. Use OpenClaw/Hermes only as reference/snippet sources.

Rationale:

- job application requires deterministic behavior;
- irreversible actions need guardrails;
- provider automation must be testable;
- browser flows need replay and proof;
- LLM agentic clicking is too unstable for production;
- smaller code surface reduces security and maintenance risk.

Consequence:

- more upfront engineering;
- less generic flexibility;
- higher stability, testability and compliance;
- easier provider-specific hardening.

## ADR-002: Deterministic provider flows

Decision: provider automation is implemented as state machines with selectors, fingerprints and guards.

Rationale:

- provider pages change;
- failures must be diagnosable;
- retries must be controlled;
- proof pack must be reliable.

## ADR-003: LLM as assistant, not executor

Decision: LLM produces structured suggestions, classifications and text, but cannot execute irreversible actions.

Rationale:

- prevents hallucinated facts;
- isolates untrusted content;
- makes compliance auditable;
- allows deterministic validation.

# 40. Final implementation principle

The system should optimize for stable automation, not maximal autonomy.

Correct behavior is not: "the agent figures it out".

Correct behavior is:

```text
Provider module defines the flow.
Flow runner executes deterministic steps.
Policy engine decides whether action is allowed.
LLM supplies structured interpretation or text.
Validation rejects unsafe output.
Proof layer records what happened.
Telegram informs the user only when needed.
```

This is the operating model required to build a job-search automation product that can run unattended without becoming opaque, brittle or unsafe.
