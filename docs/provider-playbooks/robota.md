# Robota Provider Playbook

## Current Scope

`robota` is implemented as a fixture-backed provider with read-only discovery, normalization, inbox sync, dry-run apply boundary, selector pack metadata, page fingerprints, canary checks, replay, and proof pack metadata.

## Safe Modes

- `read_only`: discovery, fetch, normalize, dedup, score.
- `dry_run_apply`: reaches submit boundary and records proof without submit.
- `review_first`: may prepare applications and require explicit approval.
- `controlled_auto_apply`: blocked until provider-specific live evidence passes release gates.

## Operational Checks

- Compare `robota` stability against `hh` before selecting it for first or second live submit.
- Confirm currency, location, work format, and language normalization against the fixture corpus.
- Verify cross-provider dedup for similar vacancies before live submits.
- Disable provider on selector drift, provider rate limit, auth expiry, CAPTCHA, or ambiguous confirmation.

## Live Enablement Evidence

- approved secrets reference for live session/API credentials;
- current live canary pass;
- dry-run submit-boundary proof on current pages;
- review-first batch with zero duplicates and 100% proof coverage;
- provider incident notes and rollback drill attached to R4/R8 evidence.
