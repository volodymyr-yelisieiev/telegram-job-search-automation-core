# Read-Only Ingest

Read-only ingest discovers, fetches, normalizes, deduplicates, scores, and explains jobs without submitting applications or sending messages.

## Provider Coverage

Current local-safe providers:

- `hh`
- `robota`
- `telegram`

Provider modules expose search plan compilation, discovery, fetch, normalization, healthcheck, dry-run boundaries, inbox sync where supported, selector packs, fingerprints, and replay hooks.

API and worker ingest paths both persist `search_runs` with provider id, search profile, query, filters, raw/normalized/rejected/shortlisted counts, stop condition, and per-provider errors. Blocked or deprecated providers record a skipped run instead of polling.

## Telegram Parsing

`parseTelegramVacancyPost` converts unstructured Telegram channel text into a raw job payload when the post looks like a vacancy. Non-vacancy noise returns `null`.

Telegram-origin jobs are read-only/manual-contact by policy. No automatic Telegram DM apply is enabled.

## Data Quality

`DataQualityService` reports:

- total jobs;
- average extraction confidence;
- low-confidence job ids;
- duplicate-like job ids;
- shortlisted/rejected counts;
- provider-level confidence breakdown.

API surface: `GET /data-quality`.

## Scoring Profiles

`scoreWeightProfiles` records strategy versions and thresholds for `aggressive`, `balanced`, and `selective` strategies. The existing scoring engine remains deterministic and explainable; future work should persist score version with each score row.
