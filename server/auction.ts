import { demo } from "./db";
import type { DB } from "./db";
import { money, requireThat } from "./policy";
export async function bid(c: DB, memberId: string, discount: number) {
  money(discount);
  const m = (
    await c.query(
      "SELECT m.*,c.mode,c.current_cycle,c.contribution,c.n_members,c.rules_json,c.clock_at,c.timer_paused_at,c.status AS circle_status FROM members m JOIN circles c ON c.id=m.circle_id WHERE m.id=$1",
      [memberId],
    )
  ).rows[0];
  requireThat(
    (m?.mode === "auction" || m?.rules_json?.request_window_seconds) &&
      m.circle_status === "active" &&
      m.status === "active" &&
      !m.timer_paused_at &&
      !m.has_won,
    "Not eligible to bid",
  );
  const cycle = (
    await c.query("SELECT * FROM cycles WHERE circle_id=$1 AND n=$2", [
      m.circle_id,
      m.current_cycle,
    ])
  ).rows[0];
  requireThat(
    cycle && cycle.status !== "closed" && discount < Number(m.contribution) * m.n_members,
    "Invalid bid",
  );
  if (m.rules_json?.request_window_seconds) {
    const now = demo && m.clock_at ? new Date(m.clock_at) : new Date();
    requireThat(
      cycle.request_opened_at &&
        now >= new Date(cycle.request_opened_at) &&
        now < new Date(cycle.request_closes_at),
      "The payout request window is not open",
    );
  }
  return (
    await c.query(
      "INSERT INTO bids(cycle_id,member_id,discount) VALUES($1,$2,$3) ON CONFLICT(cycle_id,member_id) DO UPDATE SET discount=$3,created_at=now() RETURNING *",
      [cycle.id, memberId, discount],
    )
  ).rows[0];
}
export async function winner(c: DB, circle: any, cycle: any) {
  if (circle.mode === "auction" || circle.rules_json?.request_window_seconds) {
    const b = (
      await c.query(
        "SELECT m.*,b.discount FROM bids b JOIN members m ON m.id=b.member_id WHERE b.cycle_id=$1 AND m.status='active' AND NOT m.has_won ORDER BY b.discount DESC,b.created_at,m.slot LIMIT 1",
        [cycle.id],
      )
    ).rows[0];
    if (b) return b;
    requireThat(
      circle.rules_json?.request_window_seconds,
      "Auction needs an eligible bid",
    );
  }
  const m = (
    await c.query(
      "SELECT * FROM members WHERE circle_id=$1 AND status='active' AND NOT has_won ORDER BY slot LIMIT 1",
      [circle.id],
    )
  ).rows[0];
  requireThat(m, "No eligible winner");
  return { ...m, discount: 0 };
}
export function dividends(discount: number, ids: string[]) {
  const each = Math.floor(discount / ids.length),
    remainder = discount % ids.length;
  return ids.map((id, i) => ({ id, amount: each + (i < remainder ? 1 : 0) }));
}
