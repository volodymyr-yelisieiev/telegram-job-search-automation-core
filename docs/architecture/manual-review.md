# Manual Review

Manual review is the fallback path for review-first, low-confidence, unsafe, provider-degraded, and policy-blocked work.

## Statuses

- `open`
- `resolved`
- `ignored`

## Resolutions

| Resolution | Resulting status | Meaning |
|---|---|---|
| `approved` | `resolved` | User/operator approved the reviewed item |
| `rejected` | `ignored` | User/operator rejected the item |
| `deferred` | unchanged | Keep open, record audit event |

## API

- `GET /manual-review`
- `POST /manual-review/:id/resolve`

Request body:

```json
{
  "resolution": "approved",
  "reason": "reviewed by user"
}
```

## Telegram

- `/manual_review`
- `/approve <manual_review_id>`
- `/reject <manual_review_id>`
- `/defer <manual_review_id>`

`/manual_review` includes the review id, entity type/id, reason, severity, and recommended action so the operator can copy the exact id into the resolution command.

The same `/approve` and `/reject` commands also resolve matching approval-request ids. Application approvals enqueue the approved-submit task only when irreversible actions are enabled and the immutable draft hash still matches; otherwise the command reports why submit was not queued.

Every resolution writes an audit event. Approval does not by itself execute an irreversible action; submit/reply/confirm still needs queue, policy, validation, idempotency, provider, and proof gates.
