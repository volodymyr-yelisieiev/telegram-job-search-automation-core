ALTER TABLE provider_canary_runs
  ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS failures jsonb NOT NULL DEFAULT '[]'::jsonb;
