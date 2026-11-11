import { createHash, randomBytes } from "node:crypto";
import type { DB } from "./db";
import { demo } from "./db";
import { balance } from "./ledger";
import { requireThat, money } from "./policy";
export const tokenHash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function register(c: DB, name: string, email: string, locale = "en") {
  const token = randomBytes(32).toString("hex");
  const user = (
    await c.query(
      "INSERT INTO users(name,email,paypal_email,locale,token_hash) VALUES($1,$2,$2,$3,$4) RETURNING id,name",
      [name, email, locale, tokenHash(token)],
    )
  ).rows[0];
  return { ...user, token };
}
export async function createCircle(c: DB, input: any) {
  const n = Number(input.n_members ?? 5);
  const payout = input.monthly_payout == null ? null : money(input.monthly_payout);
  requireThat(
    payout === null || payout % n === 0,
    "Monthly payout must divide equally among members in whole cents",
  );
  const amount = money(payout === null ? (input.contribution ?? 50000) : payout / n);
  const collateral = money(input.collateral_amount ?? amount * 3);
  requireThat(
    collateral >= amount,
    "Collateral must cover at least one monthly contribution",
  );
  const visibility = input.visibility ?? "private";
  requireThat(["public", "private"].includes(visibility), "Invalid circle visibility");
  const minimum = input.min_trust_score ?? 50;
  requireThat(
    Number.isInteger(minimum) && minimum >= 50 && minimum <= 100,
    "Minimum trust score must be 50–100",
  );
  requireThat(amount > 0, "Contribution must be positive");
  requireThat(Number.isInteger(n) && n >= 2 && n <= 10, "Circle size must be 2–10");
  requireThat(
    ["rotation", "auction"].includes(input.mode ?? "rotation"),
    "Invalid circle mode",
  );
  return (
    await c.query(
      "INSERT INTO circles(name,contribution,n_members,mode,currency,late_fee,rules_json,creator_id,visibility,min_trust_score,collateral_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [
        input.name || "The Friday Circle",
        amount,
        n,
        input.mode || "rotation",
        demo ? "INR" : "USD",
        Math.round(amount / 10),
        JSON.stringify({
          ...(process.env.DEMO_CYCLE_SECONDS === "115"
            ? { demo_cycle_seconds: 115 }
            : {}),
          ...(input.request_window_seconds
            ? { request_window_seconds: input.request_window_seconds }
            : {}),
        }),
        input.creator_id ?? null,
        visibility,
        minimum,
        collateral,
      ],
    )
  ).rows[0];
}
export async function join(
  c: DB,
  circleId: string,
  userId: string,
  inviteToken?: string,
) {
  const circle = (await c.query("SELECT * FROM circles WHERE id=$1", [circleId])).rows[0];
  requireThat(circle, "Circle not found");
  const members = (await c.query("SELECT * FROM members WHERE circle_id=$1", [circleId]))
    .rows;
  const old = members.find((m) => m.user_id === userId);
  if (old) {
    requireThat(
      !old.barred_at,
      "You are barred from this circle after two payment defaults",
    );
    return old;
  }
  if (circle.visibility === "public") {
    const user = (await c.query("SELECT trust_score FROM users WHERE id=$1", [userId]))
      .rows[0];
    requireThat(
      user && user.trust_score >= circle.min_trust_score,
      `This public circle requires a trust score of ${circle.min_trust_score}`,
    );
  } else if (circle.creator_id && circle.creator_id !== userId) {
    requireThat(
      inviteToken && tokenHash(inviteToken) === tokenHash(circle.invite_token),
      "A valid private circle invite link is required",
    );
  }
  requireThat(circle.status === "forming", "Circle is not accepting members");
  requireThat(members.length < circle.n_members, "Circle is full");
  return (
    await c.query(
      "INSERT INTO members(circle_id,user_id,slot,required_collateral) VALUES($1,$2,$3,$4) RETURNING *",
      [
        circleId,
        userId,
        members.length + 1,
        Number(circle.collateral_amount ?? Number(circle.contribution) * 3),
      ],
    )
  ).rows[0];
}
export async function newCycle(c: DB, circle: any, n: number, now: Date) {
  const due = new Date(now);
  const day = due.getUTCDate();
  due.setUTCDate(1);
  due.setUTCMonth(due.getUTCMonth() + 1);
  const fast = Number(circle.rules_json?.demo_cycle_seconds || 0);
  const lastDay = new Date(
    Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0),
  ).getUTCDate();
  due.setUTCDate(Math.min(day, lastDay));
  if (fast) due.setTime(+now + Math.max(1, fast - 30) * 1000);
  const grace = fast
    ? new Date(+now + fast * 1000)
    : new Date(+due + circle.grace_days * 86400000);
  const cycle = (
    await c.query(
      "INSERT INTO cycles(circle_id,n,due_at,grace_end_at) VALUES($1,$2,$3,$4) RETURNING *",
      [circle.id, n, due, grace],
    )
  ).rows[0];
  await c.query(
    "INSERT INTO contributions(cycle_id,member_id,amount) SELECT $1,id,$2 FROM members WHERE circle_id=$3 AND status<>'exited'",
    [cycle.id, circle.contribution, circle.id],
  );
  await c.query("UPDATE circles SET current_cycle=$2 WHERE id=$1", [circle.id, n]);
  return cycle;
}
export async function activate(c: DB, id: string) {
  const circle = (await c.query("SELECT * FROM circles WHERE id=$1", [id])).rows[0];
  if (circle.status !== "forming") return;
  const ms = (await c.query("SELECT * FROM members WHERE circle_id=$1", [id])).rows;
  if (ms.length !== circle.n_members) return;
  for (const m of ms)
    if ((await balance(c, `collateral:${m.id}`)) < Number(m.required_collateral)) return;
  await c.query("UPDATE members SET status='active' WHERE circle_id=$1", [id]);
  await c.query("UPDATE circles SET status='active' WHERE id=$1", [id]);
  await newCycle(c, circle, 1, new Date());
}
export async function snapshot(c: DB, id: string) {
  const circle = (await c.query("SELECT * FROM circles WHERE id=$1", [id])).rows[0];
  requireThat(circle, "Circle not found");
  const members = (
    await c.query(
      "SELECT m.*,u.name,u.locale,u.trust_score FROM members m JOIN users u ON u.id=m.user_id WHERE circle_id=$1 ORDER BY slot",
      [id],
    )
  ).rows;
  // Aggregate the complete ledger once; the 200-row activity feed below is
  // deliberately not used for balances.
  const entries = (
    await c.query(
      `SELECT account, SUM(amount) AS balance FROM (
        SELECT credit_account AS account, amount FROM ledger WHERE circle_id=$1
        UNION ALL
        SELECT debit_account AS account, -amount FROM ledger WHERE circle_id=$1
      ) entries GROUP BY account`,
      [id],
    )
  ).rows;
  const balances = new Map(
    entries.map((entry) => [entry.account, Number(entry.balance)]),
  );
  for (const m of members) {
    m.collateral = balances.get(`collateral:${m.id}`) ?? 0;
    m.retention = balances.get(`retention:${m.id}`) ?? 0;
    m.dividend = balances.get(`dividend:${m.id}`) ?? 0;
  }
  const cycles = (
    await c.query("SELECT * FROM cycles WHERE circle_id=$1 ORDER BY n", [id])
  ).rows;
  const contributions = (
    await c.query(
      "SELECT co.* FROM contributions co JOIN cycles cy ON cy.id=co.cycle_id WHERE cy.circle_id=$1",
      [id],
    )
  ).rows;
  const bids = (
    await c.query(
      "SELECT b.* FROM bids b JOIN cycles cy ON cy.id=b.cycle_id WHERE cy.circle_id=$1 ORDER BY b.discount DESC,b.created_at",
      [id],
    )
  ).rows;
  for (const cy of cycles) {
    cy.pot = balances.get(`pot:${cy.id}`) ?? 0;
    cy.contributions = contributions.filter((entry) => entry.cycle_id === cy.id);
    cy.bids = bids.filter((entry) => entry.cycle_id === cy.id);
  }
  return {
    circle,
    members,
    cycles,
    decisions: (
      await c.query(
        "SELECT id,tool,decision,result,created_at FROM agent_actions WHERE circle_id=$1 AND tool IN ('cycle_decision','agent_explanation','bar_member') ORDER BY id DESC LIMIT 30",
        [id],
      )
    ).rows,
    ledger: (
      await c.query(
        "SELECT * FROM ledger WHERE circle_id=$1 ORDER BY seq DESC LIMIT 200",
        [id],
      )
    ).rows,
    payouts: (
      await c.query(
        "SELECT p.* FROM payouts p JOIN members m ON m.id=p.member_id WHERE m.circle_id=$1 ORDER BY p.id",
        [id],
      )
    ).rows,
    messages: (
      await c.query(
        "SELECT * FROM messages WHERE circle_id=$1 ORDER BY id DESC LIMIT 50",
        [id],
      )
    ).rows,
    settlements: (
      await c.query(
        "SELECT s.* FROM settlements s JOIN members m ON m.id=s.member_id WHERE m.circle_id=$1",
        [id],
      )
    ).rows,
  };
}
