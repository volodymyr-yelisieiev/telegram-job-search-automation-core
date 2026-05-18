# Profile Readiness

`ProfileReadinessValidator` checks whether the active candidate profile can support a target mode.

## Checks

Always required:

- active profile;
- at least one target title;
- primary stack;
- positive rate limits;
- availability timezone and default windows.

Apply-capable modes require:

- active resume;
- active resume with at least one allowed provider.

Controlled/full automation additionally require:

- `userConsent.autoApply=true`.

Conversation automation requires:

- `userConsent.autoReply=true`;
- at least one allowed or range-only fact.

Full automation requires:

- `userConsent.interviewScheduling=true`.

## Surfaces

- `GET /profiles/readiness`
- Telegram `/profiles` card includes readiness text.

Readiness does not grant permission by itself. Policy, validation, idempotency, proof, provider status, and mode gates still decide each irreversible action.
