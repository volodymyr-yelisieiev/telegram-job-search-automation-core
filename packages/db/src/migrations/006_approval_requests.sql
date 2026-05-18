ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS requested_action text NOT NULL DEFAULT 'send_application',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  ADD COLUMN IF NOT EXISTS policy_decision_id text,
  ADD COLUMN IF NOT EXISTS draft_hash text,
  ADD COLUMN IF NOT EXISTS manual_review_id uuid;

CREATE INDEX IF NOT EXISTS approval_requests_entity_status_idx
  ON approval_requests (entity_type, entity_id, status);

CREATE INDEX IF NOT EXISTS approval_requests_expires_at_idx
  ON approval_requests (expires_at)
  WHERE status = 'pending';
