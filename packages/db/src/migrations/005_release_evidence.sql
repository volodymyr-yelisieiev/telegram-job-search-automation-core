CREATE TABLE IF NOT EXISTS release_evidence (
  evidence_id text PRIMARY KEY,
  evidence_type text NOT NULL,
  provider_id text,
  status text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz,
  source text NOT NULL,
  metadata jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS release_evidence_type_status_idx
  ON release_evidence (evidence_type, status, observed_at);

CREATE INDEX IF NOT EXISTS release_evidence_provider_idx
  ON release_evidence (provider_id, evidence_type)
  WHERE provider_id IS NOT NULL;
