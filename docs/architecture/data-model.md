# Data Model

The runtime data model is Postgres-first for production enablement and memory-first for fast local tests.

## Runtime Backends

| Backend | Config | Purpose |
|---|---|---|
| In-memory | `STATE_BACKEND=memory` | Default local-safe test and fixture runs |
| Postgres | `STATE_BACKEND=postgres` | Durable API and worker state for production-shaped runs |

The Postgres runtime path applies migrations, seeds the default candidate/search profile, hydrates persisted state at process start, and flushes write-through persistence before worker shutdown.

Proof/browser artifacts can use the in-memory object storage adapter for tests, the filesystem-backed adapter for durable local runs, or the S3-compatible adapter for production-shaped proof storage. The adapters support write/read/delete so runtime probes and retention cleanup can verify artifact durability without leaving temporary objects behind. Production irreversible actions require `OBJECT_STORAGE_BACKEND=s3_compatible` so raw payloads, screenshots, traces, DOM snapshots, and proof packs are not tied to a local node filesystem.

## Core Entities

| Entity | Table | Notes |
|---|---|---|
| Candidate profile | `candidate_profiles` | Active profile JSON plus display metadata |
| Search profile | `search_profiles` | Provider queries, filters, and strategy |
| Resume registry | `resumes` | Versioned resume metadata and object keys |
| Fact registry | `fact_registry` | Disclosure policy for outbound facts |
| Provider/source | `source_providers`, `source_accounts` | Provider status and account auth-state references |
| Raw and normalized jobs | `raw_jobs`, `normalized_jobs` | Provider payloads and canonical job records |
| Dedup | `dedup_jobs` | Provider, URL, content, and company-role keys |
| Scores | `job_scores` | Relevance and interview-likelihood results |
| Applications | `applications`, `application_artifacts` | Lifecycle, idempotency, proof metadata |
| Conversations | `conversations`, `inbound_messages`, `outbound_messages` | Recruiter thread state |
| Classification | `message_classifications` | Structured message category output |
| Interviews | `interview_events` | Scheduling state and summary pack id |
| Automation | `provider_flow_*`, `selector_packs`, `page_fingerprints`, `browser_artifacts` | Deterministic browser flow identity and replay |
| Operations | `task_runs`, `dead_letter_tasks`, `idempotency_keys` | Queue execution, DLQ lifecycle, duplicate prevention |
| Security operations | `secret_references`, `retention_policies`, `retention_runs`, `outbound_dispatch_proofs`, `release_evidence` | Secret reference metadata, purge decisions, local-safe outbound proof, and dated release-gate evidence |
| Control | `system_config`, `manual_review_items`, `approval_requests` | Mode/config and review workflow |
| Safety evidence | `policy_checks`, `audit_logs` | Immutable decision and event trail |

Application rows persist the approved draft hash (`draft_variant_key`), current `proof_pack_id`, policy decision, and policy version so Postgres-backed API and worker processes can restart without losing approval/hash or proof-linkage context. `application_artifacts` also stores the proof pack JSON and links application proof packs back to the owning application when the application id is known. Outbound dispatch proof rows persist `delivery_id` together with the sanitized outbound message, errors, hashes, and transport proof so sent-message evidence survives worker restarts.

Provider canary runs persist their check and failure lists, automation replay reports hydrate on runtime startup, and interview events hydrate back into the API/Telegram read model. Provider readiness and scheduling state therefore do not depend on process-local state after a Postgres-backed restart.

## Idempotency and Uniqueness

Critical unique indexes:

- `raw_jobs(provider_id, external_id)`
- `normalized_jobs(source_provider, external_id)`
- `dedup_jobs(provider_job_key)`
- `dedup_jobs(canonical_url_key)` when present
- `applications(idempotency_key)`
- `inbound_messages(provider_id, account_id, external_message_id)`
- `outbound_messages(idempotency_key)`

## Retention Draft

| Data class | Default policy |
|---|---|
| Audit logs | Append-only; retain for the full active account lifetime |
| Proof packs | Retain while application/conversation/interview is active plus incident window |
| Raw provider payloads | Retain until normalized and dedup evidence is stable; redact before long-term storage |
| Browser DOM/screenshots/traces | Store as object artifacts with explicit proof keys and purge by retention job |
| LLM prompts and outputs | Store only redacted structured inputs, model/prompt version, hashes, validation result, and costs |
| Credentials/auth state | Store only encrypted object-storage/secrets-manager keys, never raw cookies or tokens |

Rollback follows expand/contract migrations: add nullable columns/tables first, deploy readers/writers, backfill, then tighten constraints in a later migration.
