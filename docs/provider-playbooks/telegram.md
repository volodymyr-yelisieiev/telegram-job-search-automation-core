# Telegram Source Playbook

## Current Scope

`telegram` is a read-only vacancy source and control-plane UI. Fixture ingest parses unstructured posts, assigns extraction confidence, deduplicates by channel/post/text/company-role signals, and keeps applications manual unless a later channel policy allows otherwise.

## Safety Boundaries

- Control bot access requires configured allowed users when live token is present.
- Source channels are separate from the control bot authorization model.
- Telegram-derived jobs do not enter auto-apply without explicit provider/channel policy.
- Low-confidence, scam-like, agency, contact-only, or unsupported posts route to review.

## Operational Checks

- Verify `/sources` and `/providers/readiness` before enabling channel polling.
- Monitor extraction confidence and duplicate-like rates.
- Keep channel allowlists and ownership notes outside code.
- Do not auto-reply to Telegram contacts unless outbound dispatch proof and policy support the channel.

## Live Enablement Evidence

- live bot/channel credentials in approved secrets backend;
- allowed user IDs configured;
- channel allowlist and provider policy reviewed;
- parser regression fixtures for representative channel posts;
- live canary for channel polling and message visibility.
