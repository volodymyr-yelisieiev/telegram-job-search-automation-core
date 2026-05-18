# R3 Dry-Run Automation Release Evidence

Date: 2026-05-18

## Scope

R3 local-safe evidence covers deterministic dry-run flows for hh and robota, selector/fingerprint checks, submit-boundary stopping, canary metadata, replay diagnostics, and proof metadata.

## Evidence

- hh dry-run fixture reaches submit boundary.
- robota dry-run fixture reaches submit boundary.
- selector/fingerprint mismatch tests map to taxonomy errors.
- CAPTCHA/guard failures stop execution.
- replay diagnostics exist for direct error and artifact-manifest paths.
- accelerated soak runs canary and dry-run checks through `pnpm soak:fixture`.
- explicit-confirm `pnpm canary:live-smoke` can produce `live_canary_passed` evidence for provider HTTP targets and Telegram `getMe` without storing raw URLs, tokens, page bodies, or text anchors.
- explicit hh/robota search -> job -> form -> submit-boundary -> dry-run-complete flow states.
- Playwright runtime production headed/debug guard and fixture artifact capture exist.

## Deferred External Evidence

- real Playwright browser sessions;
- encrypted live auth-state storage;
- executed live provider canary evidence;
- scheduled post-deploy canaries;
- live 95%+ suite across provider-owned staging pages.

No live submit is enabled by R3.
