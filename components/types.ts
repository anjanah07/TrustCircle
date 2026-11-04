export interface Identity {
  id: string;
  name: string;
  token: string;
}
export interface Session {
  circleId: string;
  memberId: string;
  token: string;
  members?: Identity[];
}
export interface Member {
  id: string;
  name: string;
  slot: number;
  status: string;
  collateral: number;
  retention: number;
  trust_score: number;
  has_won: boolean;
  debt: string;
}
export interface Contribution {
  member_id: string;
  status: string;
  funded: string;
}
export interface Cycle {
  id: string;
  n: number;
  due_at: string;
  grace_end_at: string;
  status: string;
  pot: number;
  request_opened_at: string | null;
  request_closes_at: string | null;
  bids: { member_id: string; discount: string }[];
  winner_member_id: string;
  contributions: Contribution[];
}
export interface Ledger {
  seq: string;
  member_id: string;
  kind: string;
  amount: string;
  memo: string;
  hash: string;
  created_at: string;
}
export interface Payout {
  id: string;
  member_id: string;
  amount: string;
  purpose: string;
  status: string;
  batch_id: string | null;
  item_id: string | null;
  last_error: string | null;
}
export interface Decision {
  id: string;
  tool: string;
  decision: string;
  result: {
    winner?: string;
    reason?: string;
    explanation?: string;
    source?: string;
    pot?: number;
    payout?: number;
    retained?: number;
  };
  created_at: string;
}
export interface Snapshot {
  circle: {
    id: string;
    name: string;
    currency: string;
    contribution: string;
    n_members: number;
    status: string;
    current_cycle: number;
    mode: string;
    rules_json: { demo_cycle_seconds?: number; request_window_seconds?: number };
  };
  members: Member[];
  cycles: Cycle[];
  ledger: Ledger[];
  payouts: Payout[];
  decisions: Decision[];
}
export interface Config {
  setupPending?: boolean;
  demo: boolean;
  currency: string;
  ai: boolean;
  treasury: string;
}
export interface Account {
  id: string;
  name: string;
  paypal_email: string;
  demo: boolean;
}
