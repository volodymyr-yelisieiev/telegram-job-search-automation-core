# ADR-002: Deterministic Provider Flows

## Decision

Provider automation is implemented as deterministic state machines with versioned selectors, page fingerprints, guard checks, bounded retries, and replayable artifacts.

## Rationale

Provider pages change without notice. The system must identify page drift, stop before unsafe actions, and produce enough evidence for an operator to repair the flow without guessing. Generic browser autonomy is not acceptable for submit, reply, or scheduling actions.

## Consequences

- Each provider owns explicit flow states and transition guards.
- Selector packs and page fingerprints are versioned release inputs.
- Canary failures degrade or disable the provider before live actions.
- Replay runs from stored artifacts and cannot submit, send, or confirm.
- New providers must pass onboarding, dry-run, canary, and proof checks before controlled automation.
