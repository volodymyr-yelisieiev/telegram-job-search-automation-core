# R0 Baseline Release Evidence

Date: 2026-05-18

## Scope

R0 establishes the delivery baseline, not production auto-apply. The repo remains local-safe by default while the roadmap is executed.

## Evidence

| Check | Result |
|---|---|
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | Passed, 13 files and 70 tests |
| `pnpm test:coverage` | Passed, global statements 99.14%, lines 99.35%, functions 98.39%, branches 90.13% |
| `pnpm build` | Passed |

## Baseline Fix

`vitest.config.ts` used stale absolute aliases pointing at `/Users/v.yelisieiev/Documents/Personal/job-search`. The aliases now resolve from the current repository root, which makes verification portable inside this workspace.

## Production Blockers

- Runtime state is memory-first for API and worker local paths.
- Providers are fixture-backed and do not use real accounts or live sessions.
- LLM gateway is mock-only.
- Browser automation uses synthetic snapshots instead of real Playwright traces.
- Queue, DLQ, and idempotency production persistence are incomplete.
- Live provider submit/reply/calendar flows require external credentials and policy approval.

## Gate Decision

R0 delivery baseline can proceed to Sprint 1 only with these blockers tracked as production-enablement work. No live irreversible behavior is enabled by this release.
