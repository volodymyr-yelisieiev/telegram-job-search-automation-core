CREATE TABLE IF NOT EXISTS search_runs (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  raw_count integer NOT NULL DEFAULT 0,
  normalized_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  shortlisted_count integer NOT NULL DEFAULT 0,
  stop_condition text NOT NULL DEFAULT 'completed',
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_scores (
  job_id text PRIMARY KEY,
  relevance_score integer NOT NULL DEFAULT 0,
  interview_likelihood_score integer NOT NULL DEFAULT 0,
  decision text NOT NULL DEFAULT 'rejected',
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  hard_rejections jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE search_runs
  ADD COLUMN IF NOT EXISTS search_profile_id text NOT NULL DEFAULT 'default-search-profile',
  ADD COLUMN IF NOT EXISTS query text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS filters jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE job_scores
  ADD COLUMN IF NOT EXISTS score_strategy text NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS score_profile_version text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS factor_weights jsonb NOT NULL DEFAULT '{}'::jsonb;
