ALTER TABLE cycles ADD COLUMN IF NOT EXISTS request_opened_at timestamptz;
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS request_closes_at timestamptz;
