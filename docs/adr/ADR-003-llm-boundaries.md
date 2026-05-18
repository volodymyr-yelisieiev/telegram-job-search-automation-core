# ADR-003: LLM As Assistant, Not Executor

## Decision

The LLM produces structured suggestions, classifications, summaries, and text drafts. It never controls browser automation, sends messages, submits applications, confirms interviews, or bypasses policy.

## Rationale

Recruiter communication and applications can affect the candidate's reputation. LLM output can be wrong, injected by untrusted vacancy text, or inconsistent with the profile. The production boundary must keep execution deterministic and require schema validation, fact validation, policy checks, and audit.

## Consequences

- LLM responses are schema-validated and redacted before persistence.
- Prompt-injection text is treated as untrusted input.
- Outbound text must pass fact and policy validation before dispatch.
- Model/provider configuration is replaceable without changing execution semantics.
- Any low-confidence or unsafe LLM output routes to manual review.
