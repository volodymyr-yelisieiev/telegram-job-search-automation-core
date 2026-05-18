# Policy Engine

`PolicyEngine` is the central allow/deny/review boundary for irreversible actions.

## Decisions

- `allow`
- `deny`
- `requires_user_approval`
- `requires_ops_review`
- `defer`

## Current Inputs

- action: application submit, recruiter reply, interview confirmation;
- mode;
- provider status;
- candidate profile and consent;
- score and dedup decision;
- classification for replies;
- idempotency key;
- proof readiness;
- validation result;
- global irreversible-action flag;
- rate-limit availability.

## Rate Limits

`RateLimitService` still exists for isolated local/runtime tests. Runtime entrypoints use history-backed assessments from the database state:

- application preparation and approved submit evaluate hourly, daily, provider-hourly, company-day/week, and clone-group day/week windows from stored applications and jobs;
- recruiter reply dispatch evaluates hourly, conversation-day, and company day/week windows from stored outbound messages and conversations;
- API/Telegram approval enqueue paths include the same submit-limit reasons when a job is available, and the worker rechecks the limits immediately before calling a provider submit implementation.

The active candidate profile owns the application/company caps. Reply caps intentionally reuse the conservative profile caps plus a one-reply-per-conversation-per-day default until a dedicated reply-limit profile section is introduced.

## Simulator

`POST /policy/simulate` evaluates a policy decision without performing work. It is intended for pre-rollout checks and operator diagnosis.

Example:

```json
{
  "mode": "controlled_auto_apply",
  "irreversibleActionsEnabled": true,
  "rateLimitAvailable": false
}
```

The simulator does not bypass policy and does not create applications, replies, interviews, or provider actions.
