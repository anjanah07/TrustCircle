ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
