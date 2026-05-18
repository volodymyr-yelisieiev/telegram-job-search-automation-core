CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  telegram_user_id text UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candidate_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  display_name text NOT NULL,
  active boolean NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_profiles (
  id text PRIMARY KEY,
  candidate_profile_id text NOT NULL REFERENCES candidate_profiles(id),
  strategy text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resumes (
  id text PRIMARY KEY,
  candidate_profile_id text NOT NULL REFERENCES candidate_profiles(id),
  filename text NOT NULL,
  language text NOT NULL,
  object_storage_key text NOT NULL,
  checksum text NOT NULL,
  active boolean NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_registry (
  candidate_profile_id text NOT NULL REFERENCES candidate_profiles(id),
  fact_key text NOT NULL,
  disclosure text NOT NULL,
  categories text[] NOT NULL,
  value jsonb,
  PRIMARY KEY (candidate_profile_id, fact_key)
);

CREATE TABLE IF NOT EXISTS source_providers (
  provider_id text PRIMARY KEY,
  status text NOT NULL,
  capabilities jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_accounts (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES source_providers(provider_id),
  user_id text NOT NULL,
  status text NOT NULL,
  encrypted_auth_state_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_jobs (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  external_id text NOT NULL,
  canonical_url text,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  UNIQUE (provider_id, external_id)
);

CREATE TABLE IF NOT EXISTS search_runs (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  search_profile_id text NOT NULL DEFAULT 'default-search-profile',
  query text NOT NULL DEFAULT '',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_count integer NOT NULL,
  normalized_count integer NOT NULL,
  rejected_count integer NOT NULL,
  shortlisted_count integer NOT NULL,
  stop_condition text NOT NULL,
  errors jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS normalized_jobs (
  id text PRIMARY KEY,
  source_provider text NOT NULL,
  external_id text NOT NULL,
  canonical_url text,
  title text NOT NULL,
  company_name text,
  company_external_id text,
  location text,
  work_format text NOT NULL,
  compensation_min integer,
  compensation_max integer,
  compensation_currency text,
  compensation_period text NOT NULL,
  seniority text,
  employment_type text,
  description text NOT NULL,
  requirements jsonb NOT NULL,
  responsibilities jsonb NOT NULL,
  nice_to_have jsonb NOT NULL,
  language text NOT NULL,
  contact_method text,
  publication_date text,
  availability_status text NOT NULL DEFAULT 'open',
  already_applied boolean NOT NULL DEFAULT false,
  quality_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_payload_id text NOT NULL,
  extraction_confidence integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (source_provider, external_id)
);

CREATE TABLE IF NOT EXISTS dedup_jobs (
  id uuid PRIMARY KEY,
  job_id text NOT NULL REFERENCES normalized_jobs(id),
  provider_job_key text NOT NULL,
  canonical_url_key text,
  content_hash_key text NOT NULL,
  company_role_key text NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dedup_jobs_provider_job_key_uidx
  ON dedup_jobs (provider_job_key);

CREATE UNIQUE INDEX IF NOT EXISTS dedup_jobs_canonical_url_key_uidx
  ON dedup_jobs (canonical_url_key)
  WHERE canonical_url_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS dedup_jobs_content_hash_key_idx
  ON dedup_jobs (content_hash_key);

CREATE INDEX IF NOT EXISTS dedup_jobs_company_role_key_idx
  ON dedup_jobs (company_role_key);

CREATE TABLE IF NOT EXISTS job_scores (
  job_id text PRIMARY KEY REFERENCES normalized_jobs(id),
  relevance_score integer NOT NULL,
  interview_likelihood_score integer NOT NULL,
  decision text NOT NULL,
  score_strategy text NOT NULL DEFAULT 'balanced',
  score_profile_version text NOT NULL DEFAULT 'unknown',
  factor_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons jsonb NOT NULL,
  risks jsonb NOT NULL,
  hard_rejections jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  job_id text NOT NULL REFERENCES normalized_jobs(id),
  provider_id text NOT NULL,
  external_job_id text NOT NULL,
  candidate_profile_id text NOT NULL REFERENCES candidate_profiles(id),
  resume_id text NOT NULL,
  cover_letter_id text NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  dedup_key text NOT NULL,
  flow_run_id uuid,
  submitted_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS applications_idempotency_key_uidx
  ON applications (idempotency_key);

CREATE INDEX IF NOT EXISTS applications_dedup_key_idx
  ON applications (dedup_key);

CREATE TABLE IF NOT EXISTS application_artifacts (
  id uuid PRIMARY KEY,
  application_id uuid REFERENCES applications(id),
  proof_pack_id text NOT NULL,
  proof_pack jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  external_conversation_id text NOT NULL,
  job_id text REFERENCES normalized_jobs(id),
  company_name text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_conversation_id)
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id),
  provider_id text NOT NULL,
  account_id text NOT NULL,
  external_message_id text NOT NULL,
  sender_name text,
  text text NOT NULL,
  received_at timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_provider_account_external_uidx
  ON inbound_messages (provider_id, account_id, external_message_id);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id),
  inbound_message_id uuid REFERENCES inbound_messages(id),
  category text NOT NULL,
  text text NOT NULL,
  facts_used jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_classifications (
  inbound_message_id uuid PRIMARY KEY REFERENCES inbound_messages(id),
  classification jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interview_events (
  id text PRIMARY KEY,
  job_id text REFERENCES normalized_jobs(id),
  company_id text,
  conversation_id uuid REFERENCES conversations(id),
  date_time timestamptz NOT NULL,
  timezone text NOT NULL,
  format text NOT NULL,
  link text,
  recruiter_name text,
  status text NOT NULL,
  summary_pack_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_history (
  id uuid PRIMARY KEY,
  generated_at timestamptz NOT NULL,
  summary jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  event_id text PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  policy_version text,
  timestamp timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_modules (
  provider_id text PRIMARY KEY,
  module_version text NOT NULL,
  status text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider_id text PRIMARY KEY REFERENCES provider_modules(provider_id),
  capabilities jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_flow_definitions (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  flow jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_flow_versions (
  id uuid PRIMARY KEY,
  flow_id text NOT NULL REFERENCES provider_flow_definitions(id),
  version text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_flow_runs (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  flow_id text NOT NULL,
  flow_version text NOT NULL,
  selector_pack_version text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  error_code text,
  replay_available boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS provider_flow_steps (
  id uuid PRIMARY KEY,
  flow_run_id uuid REFERENCES provider_flow_runs(id),
  state_id text NOT NULL,
  status text NOT NULL,
  used_selector text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS provider_flow_errors (
  id uuid PRIMARY KEY,
  flow_run_id uuid REFERENCES provider_flow_runs(id),
  error_code text NOT NULL,
  outcome text NOT NULL,
  details jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_health_checks (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  status text NOT NULL,
  checked_at timestamptz NOT NULL,
  latency_ms integer NOT NULL,
  message text NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_canary_runs (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  canary_type text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS selector_packs (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  version text NOT NULL,
  selectors jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS selector_usage_logs (
  id uuid PRIMARY KEY,
  selector_pack_id text REFERENCES selector_packs(id),
  selector_key text NOT NULL,
  used_selector text NOT NULL,
  flow_run_id uuid REFERENCES provider_flow_runs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS page_fingerprints (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  version text NOT NULL,
  fingerprint jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  encrypted_state_key text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS browser_artifacts (
  id uuid PRIMARY KEY,
  flow_run_id uuid REFERENCES provider_flow_runs(id),
  artifact_type text NOT NULL,
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_replay_reports (
  flow_run_id text PRIMARY KEY,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_versions (
  version text PRIMARY KEY,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_checks (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  policy_version text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_validation_results (
  id uuid PRIMARY KEY,
  outbound_message_id uuid,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  requested_action text NOT NULL DEFAULT 'send_application',
  status text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  policy_decision_id text,
  draft_hash text,
  manual_review_id uuid
);

CREATE TABLE IF NOT EXISTS manual_review_items (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  reason_code text NOT NULL,
  severity text NOT NULL,
  recommended_action text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS external_snippet_registry (
  id uuid PRIMARY KEY,
  source_project text NOT NULL,
  repository text NOT NULL,
  commit_hash text NOT NULL,
  license text NOT NULL,
  copied_files jsonb NOT NULL,
  purpose text NOT NULL,
  owner text NOT NULL,
  dependency_impact text NOT NULL,
  update_policy text NOT NULL
);

CREATE TABLE IF NOT EXISTS external_snippet_reviews (
  id uuid PRIMARY KEY,
  snippet_id uuid REFERENCES external_snippet_registry(id),
  security_review text NOT NULL,
  test_coverage text NOT NULL,
  modifications text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
