import type { DB } from "./db";
import { balance, post } from "./ledger";
import { requireThat, settlementMath } from "./policy";
import { enqueuePayout } from "./paypal";
import { trust } from "./trust";
export async function computeSettlement(c: DB, member: string) {
  const m = (
    await c.query(
      "SELECT m.*,c.contribution,c.n_members,c.current_cycle,c.status AS circle_status,c.exit_penalty_pct,c.platform_fee_pct,c.clock_at FROM members m JOIN circles c ON c.id=m.circle_id WHERE m.id=$1",
      [member],
    )
  ).rows[0];
  requireThat(m, "Member not found");
  const collateral = await balance(c, `collateral:${member}`),
    retention = await balance(c, `retention:${member}`),
    dividend = await balance(c, `dividend:${member}`);
  const unpaid = Number(
    (
      await c.query(
        "SELECT COALESCE(SUM(co.amount-co.funded),0) AS total FROM contributions co JOIN cycles cy ON cy.id=co.cycle_id WHERE co.member_id=$1 AND co.status='pending' AND (cy.due_at<=$2 OR $3)",
        [member, m.clock_at || new Date(), m.has_won],
      )
    ).rows[0].total,
  );
  const future =
    m.has_won && m.circle_status !== "completed"
      ? Math.max(0, m.n_members - m.current_cycle) * Number(m.contribution)
      : 0;
  const penalty =
    m.circle_status === "active" && !m.has_won
      ? Math.floor((Number(m.contribution) * m.exit_penalty_pct) / 100)
      : 0;
  const platform = Math.floor((Number(m.contribution) * m.platform_fee_pct) / 100);
  const result = settlementMath(
    collateral + retention + dividend,
    unpaid + future,
    Number(m.fee_due),
    platform,
    Number(m.debt),
    penalty,
  );
  return {
    ...result,
    collateral_balance: collateral,
    retention,
    dividend,
    total_assets: collateral + retention + dividend,
    future_obligations: future,
    already_deducted:
      "Previously posted deductions are reflected in collateral_balance; never charged twice.",
    member: m,
  };
}
export async function settle(c: DB, member: string) {
  const existing = (
    await c.query("SELECT * FROM settlements WHERE member_id=$1", [member])
  ).rows[0];
  if (existing) return existing;
  const b = await computeSettlement(c, member),
    m = b.member;
  requireThat(m.status !== "exited", "Already exited");
  // Do not create an automatic full-circle guarantee after a seat exits.
  // Pause an incomplete circle until an operator resolves replacement/obligations.
  for (const kind of ["collateral", "retention", "dividend"])
    await post(
      c,
      m.circle_id,
      m.id,
      `${kind}:${m.id}`,
      `settlement:${m.id}`,
      await balance(c, `${kind}:${m.id}`),
      "settlement_assets",
      `assets:${m.id}:${kind}`,
    );
  const deductions = b.total_assets - b.refund;
  await post(
    c,
    m.circle_id,
    m.id,
    `settlement:${m.id}`,
    `exit_reserve:${m.circle_id}`,
    deductions,
    "settlement_deductions",
    `settle:${m.id}`,
    "Reserved obligations and fees; circle requires reconciliation before resuming",
  );
  const { member: _, ...breakdown } = b;
  const s = (
    await c.query(
      "INSERT INTO settlements(member_id,reason,breakdown,refund,status) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        m.id,
        m.circle_status === "completed" ? "completion" : "early_exit",
        JSON.stringify(breakdown),
        b.refund,
        b.refund ? "pending" : "succeeded",
      ],
    )
  ).rows[0];
  await enqueuePayout(c, m, b.refund, "refund", `refund:${s.id}`, `settlement:${m.id}`);
  await c.query("UPDATE members SET status='exited',debt=$2,fee_due=0 WHERE id=$1", [
    m.id,
    b.debt,
  ]);
  if (m.circle_status !== "completed")
    await c.query("UPDATE circles SET status='paused' WHERE id=$1", [m.circle_id]);
  if (b.debt) await trust(c, m.user_id, "debt", -25, s.id);
  return s;
}
