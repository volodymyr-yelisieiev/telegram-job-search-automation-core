# Interview Coordination

Interview coordination is policy-bound and review-first by default.

## Slot Selection

`InterviewCoordinator.chooseSlot` checks:

- slot timezone equals profile availability timezone;
- min notice;
- slot is inside configured weekday windows;
- max interviews per day is not exceeded.
- existing interview/calendar busy windows do not overlap the slot plus configured buffers.

Calendar evidence can come from local interview events, manual blocks, read-only ICS exports through `IcsCalendarAdapter`, or the explicit-confirm `pnpm google-calendar:smoke` release check. The Google smoke path requires OAuth credentials and `GOOGLE_CALENDAR_SMOKE_CONFIRM_LIVE=true`, creates a temporary event, verifies conflict detection with freeBusy, deletes the event, and records only hashed identifiers in release evidence.

`SchedulingDecisionEngine` returns one of:

- `confirm_slot` when a proposed slot satisfies policy;
- `propose_alternatives` when a proposed slot is concrete but unavailable;
- `ask_clarification` when no concrete slot can be used;
- `manual_review` when the timezone or policy proof is unsafe.

The API surface is `/availability` and `/schedule/decide`.

## Event Creation

`createEvent` creates a structured interview event with:

- job id;
- company id;
- conversation id;
- date/time/timezone;
- format;
- link;
- recruiter name;
- summary pack id.

## Safety

No interview is confirmed outside policy. Live calendar writes are limited to the explicit-confirm smoke path until calendar provider credentials, release evidence, and rollout approval exist.
