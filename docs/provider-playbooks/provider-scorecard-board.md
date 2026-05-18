# Provider Scorecard Board

Provider scorecards rank providers for maintenance, rollout, and deprecation decisions. The current rows are local-safe fixture preflight values from the provider readiness gates and accelerated soak; live scorecards must replace them after dated provider evidence is recorded.

| Provider | Job volume | Avg confidence | Response rate | Canary success | Flow failure | Automation risk | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| hh | 2 fixture jobs | 100% | 100% fixture inbox classification | 100% fixture metadata canary + `canary:live-smoke` path | 0 in fixture dry-run | Low locally; live evidence required | Stable candidate after live credentials, canaries and 7-day soak |
| robota | 1 fixture job | 100% | 100% fixture inbox classification | 100% fixture metadata canary + `canary:live-smoke` path | 0 in fixture dry-run | Low locally; live evidence required | Second-provider candidate after live credentials, canaries and 7-day soak |
| telegram | 1 fixture post | 90% | N/A read-only source | 100% parser/readiness preflight + Telegram `getMe` live canary path | N/A no submit flow | High for auto-apply; source-only | Read-only source |

## Thresholds

- `stable`: reliability score >= 85 and no live blockers.
- `read_only`: score >= 65 or apply channel unsupported.
- `apply_disabled`: score >= 45 but submit/reply risk is too high.
- `needs_review`: score < 45 or active incident.

## Next Provider Backlog

| Candidate | Type | Priority rationale | Current decision |
|---|---|---|---|
| LinkedIn jobs | Job board | High volume, high policy/automation risk | Research only |
| Djinni | Job board | Regional tech market relevance | Backlog candidate |
| Work.ua | Job board | Ukraine market coverage | Backlog candidate |
| Curated Telegram channels | Source | Fast discovery, unstructured data risk | Add through source policy |

All new providers start with `pnpm provider:scaffold <provider-id>` and must pass onboarding gates before stability changes.
