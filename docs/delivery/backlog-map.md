# Delivery Backlog Map

Source roadmap: [Telegram Job Search Automation Roadmap v1.0](../roadmap/Telegram%20Job%20Search%20Automation%20Roadmap%20v1.0.md).

## Taxonomy

Delivery items use this hierarchy:

| Level | Meaning | Required fields |
|---|---|---|
| EPIC | Product capability from the roadmap or PRD | phase, release gate, owner role, priority, risk |
| Capability | A durable product slice that can be released behind mode gates | mode impact, irreversible action impact, dependencies |
| Feature | Implementable user or system behavior | typed inputs/outputs, policy/audit/metrics impact |
| Story | Testable acceptance unit | acceptance criteria, rollback behavior, test evidence |
| Task | Engineering work item | changed files, migration impact, verification command |
| Test evidence | Proof that the story is done | unit, contract, integration, fixture, browser, canary, soak |

## Epic Map

| Epic | Roadmap sprints | Primary owner role | Acceptance anchor |
|---|---:|---|---|
| Core delivery foundation | 0-3 | Tech lead | R0 release evidence, durable state, queue idempotency, mode safety |
| Profile and policy | 4-7 | Backend engineer | Machine-valid profile, centralized policy decisions, review-first UX |
| Read-only providers and scoring | 8-14 | Provider engineer | Stable discovery, normalization, dedup, scoring, R2 data-quality report |
| Browser automation dry-run | 15-20 | Provider automation engineer | Deterministic flows stop at submit boundary with artifacts and replay |
| Application generation and apply gates | 21-25 | Backend and provider engineers | Resume routing, cover letters, proof packs, review-first submit, controlled mode gates |
| Conversation automation | 26-30 | LLM/prompt engineer | Inbox linking, classification, safe drafts, review-first dispatch, controlled replies |
| Interview coordination | 31-33 | Backend engineer | Availability policy, slot extraction, final interview card |
| Production readiness | 34-38 | DevOps/Ops and security reviewer | Observability, security, deployment, rollback, 7-day soak |
| Provider scaling | 39 | Provider automation engineer | Onboarding factory and maintenance SLOs |

## Labels

| Label | Use |
|---|---|
| `gate:R0` through `gate:R8` | Release gate the item supports |
| `mode:read_only` | Discovery and read-only state only |
| `mode:dry_run_apply` | Browser flow can run but must stop before submit |
| `mode:review_first` | User approval is required before irreversible action |
| `mode:controlled_auto_apply` | Strict auto-submit eligibility can be evaluated |
| `mode:conversation_only` | Reply/classification surface without application submit |
| `safety:irreversible` | Requires policy, validation, idempotency, audit, proof |
| `provider:hh`, `provider:robota`, `provider:telegram` | Provider-specific scope |
| `evidence:required` | Cannot close without test or operation evidence |
| `blocked:external` | Needs real credentials/accounts/provider/calendar infrastructure |

## Definition of Ready

A story is ready only when business goal, entity/state transitions, typed inputs/outputs, mode impact, irreversible-action impact, policy interaction, audit/metric expectations, tests, acceptance criteria, and rollback behavior are explicit.

## Definition of Done

A story is done only when implementation is complete, relevant tests pass, TypeScript and lint pass, coverage does not regress, migrations are tested when schema changes, queue behavior is idempotent when execution changes, policy and audit are present for irreversible actions, sensitive data is not logged, docs/runbooks are updated when operations change, and release notes capture risk and rollback for production behavior.
