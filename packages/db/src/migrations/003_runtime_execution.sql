CREATE TABLE IF NOT EXISTS task_runs (
  id text PRIMARY KEY,
  queue_name text NOT NULL,
  idempotency_key text NOT NULL,
  deduplication_key text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_heartbeat_at timestamptz,
  error_code text,
  error_message text
);

CREATE INDEX IF NOT EXISTS task_runs_queue_status_idx
  ON task_runs (queue_name, status, created_at);

CREATE INDEX IF NOT EXISTS task_runs_idempotency_key_idx
  ON task_runs (idempotency_key);

CREATE TABLE IF NOT EXISTS dead_letter_tasks (
  id text PRIMARY KEY,
  task_run_id text REFERENCES task_runs(id),
  queue_name text NOT NULL,
  payload jsonb NOT NULL,
  error_code text NOT NULL,
  error_message text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS dead_letter_tasks_status_idx
  ON dead_letter_tasks (status, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  status text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text
);
