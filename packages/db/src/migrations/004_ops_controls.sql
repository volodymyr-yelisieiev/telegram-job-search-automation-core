ALTER TABLE dead_letter_tasks
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS resolved_by text,
  ADD COLUMN IF NOT EXISTS resolution_note text;

CREATE TABLE IF NOT EXISTS secret_references (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  purpose text NOT NULL,
  backend text NOT NULL,
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS retention_policies (
  artifact_type text PRIMARY KEY,
  retention_days integer NOT NULL,
  hard_delete boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retention_runs (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  decisions jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_dispatch_proofs (
  proof_id text PRIMARY KEY,
  outbound_message_id text NOT NULL,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  transport text NOT NULL,
  status text NOT NULL,
  text_hash text NOT NULL,
  validation_hash text NOT NULL,
  policy_decision text NOT NULL,
  created_at timestamptz NOT NULL,
  delivered_at timestamptz
);
