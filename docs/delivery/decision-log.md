# Decision Log

| Date | Decision | Reason | Follow-up |
|---|---|---|---|
| 2026-05-18 | Keep local-safe defaults while implementing production gates | The repo has no live provider credentials, Telegram tokens, browser sessions, or calendar access. Unsafe behavior must stay disabled by default. | Add production adapters behind explicit config and per-provider gates. |
| 2026-05-18 | Treat `pnpm verify` as the baseline release gate | Roadmap Sprint 0 requires a working verification path before later sprint evidence is meaningful. | Any future change must keep lint, typecheck, tests, coverage, and build green. |
| 2026-05-18 | Use deterministic state-machine browser flows, not generic agent clicking | Roadmap and PRD require proof-bearing, replayable provider automation. | Expand Playwright implementation under the same deterministic flow contract. |
| 2026-05-18 | Mark live-provider, live-submit, live-reply, calendar, and seven-day soak work as external-blocked until real infrastructure exists | These cannot be honestly completed with repository code alone. | Provide harnesses, gates, runbooks, and templates; execute when credentials/environment are available. |
