# Conversation Automation

Conversation automation is classification-first and template-first.

## Inbound Flow

1. Provider inbox sync records inbound messages.
2. Conversation linking uses provider/account/external ids.
3. `ConversationEngine` classifies messages.
4. `ResponsePriorityService` ranks classified messages for Telegram `/responses` into urgent, needs-reply, and FYI buckets with action labels.
5. Low-confidence, sensitive, or unsupported messages create manual review.

## Reply Drafting

`ReplyTemplateEngine` supports safe template drafts for:

- salary range;
- location/work format;
- notice period;
- acknowledgment.

Drafts include:

- template id;
- facts used;
- reply idempotency key;
- outbound validation result.

Unsupported categories return no draft and must go to manual review.

## Dispatch

`OutboundDispatchService` now records local-safe dispatch proof before any live send:

- outbound validation result hash;
- text hash instead of raw proof text;
- reply idempotency key;
- policy decision;
- provider/account/transport metadata;
- audit event through `recordOutboundDispatch`.

The API surface is `/outbound` and `/outbound/dispatch/review-first`. Local-safe API dispatch remains dry-run only by default. For a real Telegram channel smoke, `pnpm telegram:dispatch-smoke` requires `TELEGRAM_DISPATCH_CONFIRM_LIVE=true`, sends the approved text through the Telegram Bot API, and emits only hashed proof fields plus a Telegram message-id hash for `outbound_dispatch_proof_ready`.

Even when `liveSendEnabled=true` is passed by a future live transport, `OutboundDispatchService` blocks sending unless the transport is a non-fixture channel (`provider`, `telegram`, or `calendar`) and the caller supplies `transportReady=true`. This keeps local fixture proof generation from being accidentally promoted into a live send path.

## Follow-Ups

`/follow-ups/plan` runs a conservative local-safe follow-up planner. It does not send messages. It creates a `follow_up_due` manual review only when the thread is eligible, the planned follow-up time is due, no open follow-up review already exists, and per-thread/company caps are still available. Rejections, spam, closed/archived threads, and recruiter replies after the last follow-up stop scheduling.
