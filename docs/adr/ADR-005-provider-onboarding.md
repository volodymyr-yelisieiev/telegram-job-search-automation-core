# ADR-005: Provider Onboarding And Stability Model

## Decision

Providers are enabled through a staged stability model: read-only, dry-run, review-first submit, controlled automation, and full automation only after explicit evidence gates.

## Rationale

Each provider has different markup, rate limits, terms, CAPTCHA behavior, inbox behavior, and confirmation surfaces. A uniform provider contract is useful, but production enablement must be evidence-based per provider.

## Consequences

- Providers can be disabled independently.
- `readyForControlledAutoApply` requires fixtures, selector packs, fingerprints, canaries, dry-run boundary proof, replay, rate limits, manual fallback, and no CAPTCHA bypass.
- Telegram vacancy ingest remains read-only unless a later provider/channel policy explicitly allows actions.
- New provider work starts from the onboarding checklist and scaffold plan, not ad hoc code.
- Release gates consume provider readiness reports instead of manual claims.
