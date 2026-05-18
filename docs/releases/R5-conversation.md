# R5 Conversation Release Evidence

Date: 2026-05-18

## Scope

R5 local-safe evidence covers fixture inbox sync, conversation linking, message classification, low-confidence/sensitive review fallback, template-based reply drafting with fact validation, review-first dry-run dispatch, and conservative follow-up planning.

## Evidence

- inbox worker tests;
- message classification tests;
- prompt-injection tests;
- reply validation tests;
- `ReplyTemplateEngine` tests;
- manual review fallback tests.
- `/follow-ups/plan` stop/cap/idempotency tests.

## Deferred External Evidence

- real provider reply dispatch;
- approval hash lock for outbound text;
- delivery proof from provider/channel;
- controlled auto-reply rollout.
- live follow-up send proof and staged monitoring.

No live recruiter message is sent by local-safe R5.
