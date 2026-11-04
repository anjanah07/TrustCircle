ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS provider_status text;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
