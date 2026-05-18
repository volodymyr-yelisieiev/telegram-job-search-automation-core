ALTER TABLE normalized_jobs
  ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS already_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quality_signals jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE outbound_dispatch_proofs
  ADD COLUMN IF NOT EXISTS message jsonb,
  ADD COLUMN IF NOT EXISTS errors jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE application_artifacts
  ADD COLUMN IF NOT EXISTS proof_pack_id text,
  ADD COLUMN IF NOT EXISTS proof_pack jsonb;
