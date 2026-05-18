# R2 Read-Only Release Evidence

Date: 2026-05-18

## Scope

R2 local-safe read-only evidence covers provider discovery through fixtures, deterministic normalization, dedup, scoring, Telegram post parsing, and data-quality visibility.

## Evidence

- `GET /data-quality`
- provider contract tests for hh, robota, and Telegram
- Telegram unstructured vacancy parser test
- scoring and dedup regression tests
- local pipeline smoke through `POST /ingest/run`
- accelerated local soak through `pnpm soak:fixture`
- 10,000 fixture-equivalent stress through `pnpm soak:read-only-stress`

## Deferred External Evidence

- live hh/robota read-only canaries;
- 1,000+ real job processing proof;
- provider account policy review.

These require live/staging provider accounts and are not enabled by local-safe code.
