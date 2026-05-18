# Outbound Reply Failure

Use this runbook when an outbound reply alert fires for unsupported facts, validation failures, thread contradictions, or delivery failures.

1. Pause reply dispatch and keep provider/application submit automation unchanged.
2. Inspect the related `outbound_message`, `inbound_message`, manual-review item, and audit trail.
3. If `unsupported_fact_attempted` fired, remove the fact from the draft/template and update the fact registry or disclosure policy before retry.
4. If `reply_validation_spike` or `thread_contradiction_detected` fired, route the thread to manual review and compare the draft against prior recruiter messages.
5. If `outbound_delivery_failure` fired, verify the transport credential, delivery receipt, idempotency key, and provider/channel status before retry.
6. Record the resolution in the manual-review item or incident notes, then run the relevant reply/API tests before re-enabling dispatch.
