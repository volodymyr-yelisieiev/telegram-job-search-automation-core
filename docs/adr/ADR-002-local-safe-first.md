# ADR-002: Local-Safe First Implementation

## Decision

The first implementation uses fixture provider adapters and local-safe defaults instead of live scraping or live submit.

## Rationale

The workspace does not contain provider accounts, Telegram tokens, browser sessions, or channel allowlists. A production-shaped mock runtime lets us validate contracts, policy gates, deduplication, dry-run boundaries, and Telegram UX without unsafe external actions.

## Consequences

- `IRREVERSIBLE_ACTIONS_ENABLED=false` remains the default.
- Submit paths return blocked results unless explicitly enabled in a future reviewed live adapter.
- hh/robota/Telegram are implemented with fixtures, normalization, scoring, dry-run, canary, and replay boundaries.
