# Delivery Risk Register

| ID | Risk | Impact | Mitigation | Status |
|---|---|---|---|---|
| RISK-001 | Runtime state defaults to memory-first unless `STATE_BACKEND=postgres` is configured | Misconfigured production could lose runtime state on restart | Use `STATE_BACKEND=postgres`, migration checks, runtime-state docs, and Postgres hydration coverage before live rollout | Mitigated locally |
| RISK-002 | Providers are fixture-backed | Cannot claim live hh/robota/Telegram acceptance without real accounts and policy review | Keep live irreversible actions disabled, add provider readiness gates, mark live rollout as external-blocked until credentials exist | Open |
| RISK-003 | LLM gateway defaults to mock unless a live `openai-compatible` transport and smoke evidence are configured | Generation and classification quality cannot be validated against production model behavior without live credentials and dated smoke results | Keep schema boundary, redaction, prompt/version logging, eval fixtures, and `pnpm llm:smoke`; mark live model acceptance external-blocked until production credentials and evidence exist | Open |
| RISK-004 | Browser automation uses synthetic snapshots for local-safe tests | Dry-run proof is not equivalent to a real browser trace | Deterministic flow, artifact manifest replay, and canary/readiness gates exist; bind to real Playwright traces before live rollout | Open |
| RISK-005 | Irreversible action enablement could be misconfigured | Real submit/reply/confirm may occur without enough evidence | Default `IRREVERSIBLE_ACTIONS_ENABLED=false`, require mode, policy, idempotency, proof, fresh canary, and per-provider enable flags | Mitigated locally |
| RISK-006 | Queue semantics are partially local-safe | Duplicate or lost tasks are possible in production if workers crash mid-task | Task runs, DLQ state, idempotency lifecycle, heartbeat, Postgres task-run store, and DLQ assign/resolve/discard/retry controls exist; production restart tests still required | Mitigated locally |
| RISK-007 | Seven-day soak cannot be completed inside a unit test | GA acceptance needs time and live/staging environment | Accelerated fixture soak command, report template, and `/release-evidence` ledger exist; do not mark GA complete until dated run evidence exists | Open |

## Blocking Production Debts

- Production restart tests for idempotent task-run and DLQ persistence using real Postgres/Redis.
- Real browser artifact storage and replay.
- Provider account/session/external secrets-manager provisioning.
- Live provider and Telegram compliance review.
- Live calendar integration or explicit approved replacement.
- Seven-day continuous acceptance evidence.
