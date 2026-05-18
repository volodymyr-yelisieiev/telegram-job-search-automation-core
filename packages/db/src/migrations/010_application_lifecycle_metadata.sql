ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS draft_variant_key text,
  ADD COLUMN IF NOT EXISTS proof_pack_id text,
  ADD COLUMN IF NOT EXISTS policy_decision text,
  ADD COLUMN IF NOT EXISTS policy_version text;

CREATE INDEX IF NOT EXISTS applications_proof_pack_id_idx
  ON applications (proof_pack_id)
  WHERE proof_pack_id IS NOT NULL;
