CREATE TABLE engine_lock (id int PRIMARY KEY);
INSERT INTO engine_lock VALUES (1);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, email text UNIQUE NOT NULL,
  paypal_email text NOT NULL, locale text DEFAULT 'en',
  trust_score int DEFAULT 50, created_at timestamptz DEFAULT now()
);

CREATE TABLE circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contribution bigint NOT NULL,            -- C in minor units
  n_members int NOT NULL CHECK (n_members BETWEEN 2 AND 10),
  collateral_multiplier numeric DEFAULT 3,
  mode text NOT NULL CHECK (mode IN ('rotation','auction')),
  grace_days int DEFAULT 3,
  late_fee bigint DEFAULT 5000,
  exit_penalty_pct int DEFAULT 10,
  holdback_pct int DEFAULT 20,
  platform_fee_pct int DEFAULT 1,
  rules_json jsonb DEFAULT '{}',
  status text DEFAULT 'forming'
    CHECK (status IN ('forming','active','completed','paused')),
  current_cycle int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid REFERENCES circles(id),
  user_id uuid REFERENCES users(id),
  slot int NOT NULL,
  required_collateral bigint NOT NULL,
  status text DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','exited')),
  has_won boolean DEFAULT false,
  topup_deadline timestamptz,
  UNIQUE (circle_id, user_id), UNIQUE (circle_id, slot)
);

CREATE TABLE cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid REFERENCES circles(id),
  n int NOT NULL,
  due_at timestamptz NOT NULL, grace_end_at timestamptz NOT NULL,
  status text DEFAULT 'open'
    CHECK (status IN ('open','grace','closed')),
  winner_member_id uuid REFERENCES members(id),
  discount bigint DEFAULT 0,
  reminders_sent jsonb DEFAULT '[]',
  UNIQUE (circle_id, n)
);

CREATE TABLE contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid REFERENCES cycles(id),
  member_id uuid REFERENCES members(id),
  amount bigint NOT NULL,
  status text DEFAULT 'pending'
    CHECK (status IN ('pending','paid','covered')),
  paypal_order_id text, paid_at timestamptz,
  UNIQUE (cycle_id, member_id)
);

CREATE TABLE bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid REFERENCES cycles(id),
  member_id uuid REFERENCES members(id),
  discount bigint NOT NULL CHECK (discount >= 0),
  created_at timestamptz DEFAULT now(),
  UNIQUE (cycle_id, member_id)
);

-- Append-only, double-entry, hash-chained
CREATE TABLE ledger (
  seq bigserial PRIMARY KEY,
  circle_id uuid, member_id uuid,
  debit_account text NOT NULL, credit_account text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  kind text NOT NULL, memo text,
  idempotency_key text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  prev_hash text NOT NULL, hash text NOT NULL
);
CREATE OR REPLACE FUNCTION ledger_no_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_no_mutation();

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid REFERENCES members(id),
  reason text, breakdown jsonb NOT NULL, refund bigint NOT NULL,
  status text DEFAULT 'pending', created_at timestamptz DEFAULT now()
);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE NOT NULL,
  member_id uuid REFERENCES members(id),
  receiver text NOT NULL, amount bigint NOT NULL, purpose text,
  status text DEFAULT 'pending'
    CHECK (status IN ('pending','sent','succeeded','failed')),
  batch_id text, item_id text, attempts int DEFAULT 0,
  next_retry_at timestamptz DEFAULT now(), last_error text
);

CREATE TABLE trust_events (
  id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id),
  kind text NOT NULL, delta int NOT NULL, ref text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE webhook_events (
  event_id text PRIMARY KEY, type text, payload jsonb,
  received_at timestamptz DEFAULT now()
);

CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_seq bigint REFERENCES ledger(seq), member_id uuid,
  reason text, status text DEFAULT 'open', resolution text
);

CREATE TABLE agent_actions (
  id bigserial PRIMARY KEY, circle_id uuid, tool text, args jsonb,
  decision text, result jsonb, created_at timestamptz DEFAULT now()
);
ALTER TABLE circles ADD COLUMN currency text NOT NULL DEFAULT 'INR';
ALTER TABLE circles ADD COLUMN clock_at timestamptz;
ALTER TABLE members ADD COLUMN debt bigint NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN fee_due bigint NOT NULL DEFAULT 0;
ALTER TABLE cycles ADD COLUMN shortfall bigint NOT NULL DEFAULT 0;
ALTER TABLE contributions ADD COLUMN funded bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN token_hash text UNIQUE;
ALTER TABLE trust_events ADD CONSTRAINT trust_event_once UNIQUE (user_id,kind,ref);
ALTER TABLE settlements ADD CONSTRAINT settlement_once UNIQUE (member_id);
CREATE TABLE payment_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid REFERENCES members(id),
 cycle_id uuid REFERENCES cycles(id), kind text NOT NULL, amount bigint NOT NULL,
 currency text NOT NULL, request_key text UNIQUE NOT NULL, paypal_id text UNIQUE,
 capture_id text UNIQUE, status text NOT NULL DEFAULT 'created', approval_url text
);
CREATE UNIQUE INDEX one_contribution_order ON payment_orders(member_id,cycle_id) WHERE kind='contribution';
CREATE TABLE messages (
 id bigserial PRIMARY KEY, circle_id uuid REFERENCES circles(id), member_id uuid REFERENCES members(id),
 kind text NOT NULL, text text NOT NULL, dedupe_key text UNIQUE, created_at timestamptz DEFAULT now()
);
ALTER TABLE contributions ADD COLUMN default_processed boolean NOT NULL DEFAULT false;
ALTER TABLE payment_orders ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payouts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
