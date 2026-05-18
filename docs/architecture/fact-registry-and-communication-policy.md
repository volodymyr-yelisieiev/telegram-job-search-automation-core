# Fact Registry And Communication Policy

## Purpose

The candidate profile is the source of truth for facts used in applications, recruiter replies, and scheduling messages. Free text from vacancies or recruiters is untrusted and cannot become an outbound fact without validation.

## Disclosure Modes

- `allowed`: can be used automatically when policy and template allow it.
- `range_only`: can be disclosed only as an approved range, never as a hidden target.
- `approval_required`: routes to manual review before outbound use.
- `forbidden`: cannot be included in cover letters, replies, or scheduling messages.

## Enforcement

- Cover letters and replies pass fact validation before dispatch.
- Sensitive data requests route to manual review.
- Thread contradictions block auto-reply.
- Unsupported facts create validation risk flags and cannot be sent automatically.
- Audit events retain hashes and policy outcomes, not raw secrets.
