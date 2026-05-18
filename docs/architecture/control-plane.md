# Control Plane

## Modes

Supported modes:

- `read_only`
- `dry_run_apply`
- `review_first`
- `controlled_auto_apply`
- `full_auto_apply`
- `conversation_only`
- `paused`

The runtime mode is stored on the runtime database contract as `systemMode`. `STATE_BACKEND=postgres` additionally persists it in `system_config` and audits each transition.

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Unauthenticated healthcheck |
| `GET /status` | Current system state and mode |
| `GET /mode` | Current mode and supported modes |
| `POST /mode` | Change mode with audit event |
| `GET /pipeline` | Job/application/interview pipeline summary |
| `GET /sources` | Provider/source status alias |
| `GET /providers` | Provider health, capabilities, config overrides, runtime mode, and readiness summary |
| `GET /manual-review` | Open/manual review records |
| `GET /logs/:entityId` | Audit trail for one entity |
| `GET /queues` | Queue depth and policy |
| `GET /dlq` | Dead-letter task records |
| `POST /telegram/webhook` | Telegram command webhook guarded by Telegram secret-token header and sender allowlist |

All routes except `/health` require API token authorization. `/telegram/webhook` uses Telegram's `X-Telegram-Bot-Api-Secret-Token` header instead of the API token so Telegram can deliver updates without exposing the control-plane bearer token.

## Telegram Safety Shell

Provider readiness on API surfaces uses runtime evidence where available: recorded canary runs, replay reports, and configured provider disable overrides. Static selector/fingerprint metadata alone is no longer enough for API `/providers`, `/providers/readiness`, `/providers/onboarding`, or release-gate readiness.

Telegram commands `/pause`, `/resume_bot`, and `/mode` now call the same mode transition path and write audit events. Telegram state is still kept for handler rendering, but the runtime database is the source for auditable mode changes. `/jobs_applied_today` and `/jobs_applied_week` filter by creation window, `/sources` includes source health plus latest run/canary context, and `/manual_review` includes ids usable by `/approve`, `/reject`, and `/defer`. Telegram approval commands execute application-submit approval only; reply dispatch and interview-confirm approval requests remain API workflow actions so they can use their dedicated validation, exact hash, and scheduling gates. The API webhook ignores non-command messages, rejects missing/stale webhook secrets before command handling, and applies `TELEGRAM_ALLOWED_USER_IDS` before mutating state. The standalone polling bot also opens the configured runtime database, so `STATE_BACKEND=postgres` keeps polling-bot mode changes and approval-command effects on the same durable state path as the API.

## Irreversible Action Rule

Irreversible actions remain blocked unless all of the following are true:

- mode permits the action;
- `IRREVERSIBLE_ACTIONS_ENABLED=true`;
- policy allows the action;
- validation passes;
- idempotency key exists;
- proof capture is ready;
- provider status and rate limits allow the action.

Application and recruiter-reply rate limits are derived from stored runtime history, not a caller-supplied boolean: submit paths check application hourly/day/provider/company/clone windows, while reply paths check hourly/thread/company windows. Review-first approval can still create a pending review artifact, but approved submit/reply execution rechecks limits before crossing an irreversible boundary.

Interview confirmations use the same policy shell: API creation and approval require a `confirm_slot` scheduling decision with timezone, min-notice, availability-window, conflict, and max-per-day proof before an event can become `scheduled`.
