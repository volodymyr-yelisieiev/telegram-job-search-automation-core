# hh Provider Playbook

## Current Scope

`hh` is implemented as a fixture-backed provider with read-only discovery, normalization, inbox sync, dry-run apply boundary, selector pack metadata, page fingerprints, canary checks, replay, and proof pack metadata.

## Safe Modes

- `read_only`: discovery, fetch, normalize, dedup, score.
- `dry_run_apply`: reaches submit boundary and records proof without submit.
- `review_first`: may prepare applications and require explicit approval.
- `controlled_auto_apply`: blocked until live credentials, canaries, proof, rate limits, and 7-day soak evidence pass release gates.

## Operational Checks

- Verify `/providers/readiness` reports `hh.readyForControlledAutoApply=true` before considering live enablement.
- Verify selector pack version and fingerprints are current.
- Run `pnpm acceptance:package` and check `releaseGate.blockers`.
- Keep per-provider and per-company limits below the signed rollout plan.
- Disable provider immediately if CAPTCHA, account lock, selector mismatch, or confirmation ambiguity appears.

## Live Enablement Evidence

- live credential reference in approved secrets backend;
- dated live canary pass;
- dry-run submit-boundary proof on current pages;
- review-first live submit batch with zero duplicates;
- confirmation proof for every applied status;
- rollback drill to `review_first` or `read_only`.
