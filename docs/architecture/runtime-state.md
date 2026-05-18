# Runtime State

## Configuration

`STATE_BACKEND` controls runtime persistence:

| Value | Behavior |
|---|---|
| `memory` | Uses `InMemoryDatabase`; fastest local-safe path and test default |
| `postgres` | Uses `PostgresRuntimeDatabase`; applies migrations, hydrates state, persists writes |

## Durable Write Path

The Postgres runtime adapter mirrors the in-memory contract used by API, Telegram, and workers. Methods still update the process-local maps immediately for rendering and testability, then enqueue Postgres writes. Worker entrypoints and the local pipeline call `flushPersistence()` before returning or shutting down so durable state is available after restart.

Persisted runtime surfaces currently include:

- normalized jobs;
- job scores;
- dedup decisions;
- applications;
- manual review items;
- provider health checks;
- proof packs;
- policy checks;
- search runs;
- inbound messages and conversations;
- message classifications;
- interview events;
- canary runs;
- replay reports;
- audit logs.

## Restart Semantics

When `STATE_BACKEND=postgres` is used, startup hydrates active profile/search profile, jobs, scores, applications, manual review items, and audit logs from Postgres before serving API requests or running workers. Additional hydrated surfaces should be expanded as related roadmap sprints close.

## Current Limits

This adapter is a production-shaped runtime path, not a live-provider enablement flag. It does not by itself enable real submit, real replies, calendar writes, or CAPTCHA bypass. Those remain gated by mode, policy, provider readiness, proof, and external credentials.
