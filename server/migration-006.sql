ALTER TABLE circles ADD COLUMN creator_id uuid REFERENCES users(id);
ALTER TABLE circles ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private'));
ALTER TABLE circles ADD COLUMN min_trust_score int NOT NULL DEFAULT 50 CHECK (min_trust_score BETWEEN 50 AND 100);
ALTER TABLE circles ADD COLUMN collateral_amount bigint;
ALTER TABLE circles ADD COLUMN invite_token text NOT NULL DEFAULT replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
ALTER TABLE circles ADD COLUMN pause_reason text;
ALTER TABLE members ADD COLUMN default_count int NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN barred_at timestamptz;
UPDATE circles SET collateral_amount=contribution*3;
UPDATE circles c SET creator_id=m.user_id FROM members m WHERE m.circle_id=c.id AND m.slot=1;
UPDATE members m SET default_count=(SELECT count(*) FROM contributions co WHERE co.member_id=m.id AND co.default_processed=true);

ALTER TABLE payment_orders ADD COLUMN creation_started_at timestamptz;
UPDATE payment_orders p SET creation_started_at=p.created_at
WHERE paypal_id IS NOT NULL OR last_error IS NOT NULL OR EXISTS (
  SELECT 1 FROM agent_actions a WHERE a.tool='confirm_deposit' AND a.args->>'order_id'=p.id::text
);
