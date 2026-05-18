ALTER TABLE application_artifacts
  ADD COLUMN IF NOT EXISTS proof_pack_id text,
  ADD COLUMN IF NOT EXISTS proof_pack jsonb;
