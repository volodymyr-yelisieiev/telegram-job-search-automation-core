CREATE UNIQUE INDEX IF NOT EXISTS dedup_jobs_provider_job_key_uidx
  ON dedup_jobs (provider_job_key);

CREATE UNIQUE INDEX IF NOT EXISTS dedup_jobs_canonical_url_key_uidx
  ON dedup_jobs (canonical_url_key)
  WHERE canonical_url_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS dedup_jobs_content_hash_key_idx
  ON dedup_jobs (content_hash_key);

CREATE INDEX IF NOT EXISTS dedup_jobs_company_role_key_idx
  ON dedup_jobs (company_role_key);

CREATE UNIQUE INDEX IF NOT EXISTS applications_idempotency_key_uidx
  ON applications (idempotency_key);

CREATE INDEX IF NOT EXISTS applications_dedup_key_idx
  ON applications (dedup_key);

CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_provider_account_external_uidx
  ON inbound_messages (provider_id, account_id, external_message_id);
