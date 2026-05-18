ALTER TABLE outbound_dispatch_proofs
  ADD COLUMN IF NOT EXISTS delivery_id text;
