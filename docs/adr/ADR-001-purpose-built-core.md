# ADR-001: Purpose-Built Core Over Generic Agent Runtime

## Decision

Build a specialized Job Search Automation Core. OpenClaw, Hermes, or similar projects may be used only as reference or reviewed snippets.

## Rationale

Job applications and recruiter replies are irreversible business actions. The production path must be deterministic, auditable, policy-gated, and replayable.

## Consequences

- Provider flows are state machines with selectors, fingerprints, guards, proof, and replay.
- LLM output is structured and schema-validated.
- Generic agentic clicking is excluded from production execution.
