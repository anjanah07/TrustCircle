import { type DB, tx, demo } from "./db";
import { balance, post } from "./ledger";
import { newCycle } from "./circles";
import { requireThat, holdback } from "./policy";
import { trust } from "./trust";
import { winner, dividends } from "./auction";
import { enqueuePayout } from "./paypal";
import { settle } from "./settlement";
export const nowFor = (circle: any) =>
  demo && circle.clock_at ? new Date(circle.clock_at) : new Date();
export async function message(
  c: DB,
  circle: string,
  member: string | null,
  kind: string,
  text: string,
  key: string,
) {
  await c.query(
    "INSERT INTO messages(circle_id,member_id,kind,text,dedupe_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING",
    [circle, member, kind, text, key],
  );
}
export async function tick(c: DB, id: string) {
  const circle = (await c.query("SELECT * FROM circles WHERE id=$1", [id])).rows[0];
  if (circle?.status !== "active" || circle.timer_paused_at) return;
  const now = nowFor(circle);
  const cycle = (
    await c.query(
      "SELECT * FROM cycles WHERE circle_id=$1 AND n=$2 AND status<>'closed'",
      [id, circle.current_cycle],
    )
  ).rows[0];
  if (!cycle) return;
  if (now > new Date(cycle.due_at))
    await c.query("UPDATE cycles SET status='grace' WHERE id=$1", [cycle.id]);
  const dues = (
    await c.query(
      "SELECT co.*,m.user_id,m.status AS member_status,u.name,u.locale FROM contributions co JOIN members m ON m.id=co.member_id JOIN users u ON u.id=m.user_id WHERE co.cycle_id=$1 AND co.status='pending' ORDER BY m.slot",
      [cycle.id],
    )
  ).rows;
  for (const due of dues) {
    const stage =
      now > new Date(cycle.grace_end_at)
        ? "overdue"
        : now.toISOString().slice(0, 10) ===
            new Date(cycle.due_at).toISOString().slice(0, 10)
          ? "due-today"
          : now > new Date(cycle.due_at)
            ? "grace"
            : +new Date(cycle.due_at) - +now <= 3 * 86400000
              ? "due-soon"
              : null;
    if (stage) {
      const text =
        due.locale === "hi"
          ? `${due.name}, आपकी किस्त ${Number(due.amount) / 100} ${circle.currency} बाकी है। स्थिति: ${stage}।`
          : `${due.name}, your ${circle.currency} ${(Number(due.amount) / 100).toFixed(2)} contribution is ${stage}. Grace ends ${new Date(cycle.grace_end_at).toISOString()}.`;
      await message(
        c,
        id,
        due.member_id,
        "reminder",
        text,
        `${cycle.id}:${due.member_id}:${stage}`,
      );
    }
    if (now <= new Date(cycle.grace_end_at)) continue;
    // Never invent money: only the available collateral can be credited to the pot.
    const remaining = Number(due.amount) - Number(due.funded);
    const available = await balance(c, `collateral:${due.member_id}`),
      covered = Math.min(remaining, available);
    await post(
      c,
      id,
      due.member_id,
      `collateral:${due.member_id}`,
      `pot:${cycle.id}`,
      covered,
      "default_coverage",
      `default:${due.id}:${due.funded}`,
      "Unpaid after grace period; contribution covered from collateral",
    );
    if (!due.default_processed) {
      const fee = Math.min(Number(circle.late_fee), available - covered);
      await post(
        c,
        id,
        due.member_id,
        `collateral:${due.member_id}`,
        "fees",
        fee,
        "late_fee",
        `late:${due.id}`,
        "Late fee after grace",
      );
      await message(
        c,
        id,
        due.member_id,
        "deduction",
        `Late payment: ${circle.currency} ${(covered / 100).toFixed(2)} contribution and ${(fee / 100).toFixed(2)} late fee were deducted from your deposit held by the Treasurer.`,
        `deduction:${due.id}`,
      );
      await c.query("UPDATE members SET fee_due=fee_due+$2 WHERE id=$1", [
        due.member_id,
        Number(circle.late_fee) - fee,
      ]);
      await trust(c, due.user_id, "deduction", -10, cycle.id);
      const member = (
        await c.query(
          "UPDATE members SET default_count=default_count+1 WHERE id=$1 RETURNING default_count",
          [due.member_id],
        )
      ).rows[0];
      if (member.default_count >= 2) {
        // Immediate eligibility guard while the autonomous Treasurer reviews the event.
        await c.query(
          "UPDATE members SET status='suspended',topup_deadline=NULL WHERE id=$1",
          [due.member_id],
        );
        await c.query("UPDATE circles SET status='paused',pause_reason=$2 WHERE id=$1", [
          id,
          "Second payment default: Treasurer review and funding reconciliation required.",
        ]);
      }
    }
    const retainedCoverage = Math.min(
      remaining - covered,
      await balance(c, `retention:${due.member_id}`),
    );
    await post(
      c,
      id,
      due.member_id,
      `retention:${due.member_id}`,
      `pot:${cycle.id}`,
      retainedCoverage,
      "retention_coverage",
      `retention-default:${due.id}:${due.funded}`,
      "Retained winner funds backstop unpaid principal",
    );
    const funded = Number(due.funded) + covered + retainedCoverage;
    await c.query(
      "UPDATE contributions SET funded=$2,default_processed=true,status=CASE WHEN $2=amount THEN 'covered' ELSE 'pending' END WHERE id=$1",
      [due.id, funded],
    );
    const updatedMember = (
      await c.query("SELECT default_count FROM members WHERE id=$1", [due.member_id])
    ).rows[0];
    if (
      updatedMember.default_count < 2 &&
      (await balance(c, `collateral:${due.member_id}`)) < Number(circle.contribution)
    ) {
      await c.query(
        "UPDATE members SET topup_deadline=COALESCE(topup_deadline,$2) WHERE id=$1",
        [due.member_id, new Date(+now + 3 * 86400000)],
      );
      await message(
        c,
        id,
        due.member_id,
        "topup",
        "Collateral is below one contribution. Top up within 3 days to retain payout eligibility.",
        `topup:${cycle.id}:${due.member_id}`,
      );
    }
  }
  const suspensions = (
    await c.query(
      "SELECT * FROM members WHERE circle_id=$1 AND topup_deadline<$2 AND status='active'",
      [id, now],
    )
  ).rows;
  for (const m of suspensions) {
    if ((await balance(c, `collateral:${m.id}`)) >= Number(circle.contribution)) continue;
    await c.query("UPDATE members SET status='suspended' WHERE id=$1", [m.id]);
    await trust(c, m.user_id, "suspension", -8, cycle.id);
  }
  const missing = (
    await c.query(
      "SELECT COALESCE(SUM(amount-funded),0) AS amount FROM contributions WHERE cycle_id=$1",
      [cycle.id],
    )
  ).rows[0];
  await c.query("UPDATE cycles SET shortfall=$2 WHERE id=$1", [
    cycle.id,
    Number(missing.amount),
  ]);
}
// Opens only after verified collections (or collateral coverage) fund the entire pot.
export async function openRequestWindow(c: DB, id: string): Promise<boolean> {
  const circle = (await c.query("SELECT * FROM circles WHERE id=$1", [id])).rows[0];
  if (
    circle?.status !== "active" ||
    circle.timer_paused_at ||
    !circle.rules_json?.request_window_seconds
  )
    return false;
  const cycle = (
    await c.query(
      "SELECT * FROM cycles WHERE circle_id=$1 AND n=$2 AND status<>'closed'",
      [id, circle.current_cycle],
    )
  ).rows[0];
  if (!cycle) return false;
  const pending = (
    await c.query("SELECT id FROM contributions WHERE cycle_id=$1 AND status='pending'", [
      cycle.id,
    ])
  ).rows;
  if (
    pending.length ||
    (await balance(c, `pot:${cycle.id}`)) !==
      Number(circle.contribution) * circle.n_members
  )
    return false;
  const now = nowFor(circle);
  if (!cycle.request_opened_at) {
    const closes = new Date(
      +now + Number(circle.rules_json.request_window_seconds) * 1000,
    );
    await c.query(
      "UPDATE cycles SET request_opened_at=$2,request_closes_at=$3 WHERE id=$1 AND request_opened_at IS NULL",
      [cycle.id, now, closes],
    );
    await message(
      c,
      id,
      null,
      "payout_requests",
      `The pot is funded. Request this payout or offer a discount before ${closes.toISOString()}. Previous winners cannot request again.`,
      `requests:${cycle.id}`,
    );
    return false;
  }
  return now >= new Date(cycle.request_closes_at);
}
export async function closeCycle(c: DB, id: string) {
  await tick(c, id);
  const circle = (await c.query("SELECT * FROM circles WHERE id=$1", [id])).rows[0];
  requireThat(circle?.status === "active", "Circle is not active");
  requireThat(!circle.timer_paused_at, "Circle timer is paused");
  const cycle = (
    await c.query("SELECT * FROM cycles WHERE circle_id=$1 AND n=$2", [
      id,
      circle.current_cycle,
    ])
  ).rows[0];
  const unpaid = (
    await c.query("SELECT * FROM contributions WHERE cycle_id=$1 AND status='pending'", [
      cycle.id,
    ])
  ).rows;
  requireThat(unpaid.length === 0, "Unfunded contributions: payout blocked");
  const pot = await balance(c, `pot:${cycle.id}`);
  requireThat(pot === Number(circle.contribution) * circle.n_members, "Pot is not whole");
  if (circle.rules_json?.request_window_seconds) {
    requireThat(
      cycle.request_closes_at && nowFor(circle) >= new Date(cycle.request_closes_at),
      "Payout request window must finish before settlement",
    );
  }
  const win = await winner(c, circle, cycle);
  const discount = Number(win.discount);
  const members = (
    await c.query("SELECT * FROM members WHERE circle_id=$1 ORDER BY slot", [id])
  ).rows;
  if (discount)
    for (const d of dividends(
      discount,
      members.filter((m) => m.id !== win.id).map((m) => m.id),
    )) {
      await post(
        c,
        id,
        d.id,
        `pot:${cycle.id}`,
        `dividend:${d.id}`,
        d.amount,
        "dividend",
        `dividend:${cycle.id}:${d.id}`,
      );
      if (circle.rules_json?.request_window_seconds) {
        const recipient = members.find((member) => member.id === d.id);
        await enqueuePayout(
          c,
          recipient,
          d.amount,
          "dividend",
          `dividend-payout:${cycle.id}:${d.id}`,
          `dividend:${d.id}`,
        );
      }
    }
  const retain = holdback(
    pot - discount,
    (circle.n_members - cycle.n) * Number(circle.contribution),
    await balance(c, `collateral:${win.id}`),
  );
  await post(
    c,
    id,
    win.id,
    `pot:${cycle.id}`,
    `retention:${win.id}`,
    retain,
    "holdback",
    `holdback:${cycle.id}`,
    "Retention covers future exposure beyond collateral",
  );
  const reason =
    !circle.rules_json?.request_window_seconds && circle.mode === "rotation"
      ? `Member in slot ${win.slot} is the earliest active member who has not received the pot. All ${circle.n_members} contributions are funded. Retain ${retain} minor units to cover future exposure; release ${pot - discount - retain}.`
      : `Eligible requests ranked by discount (${discount}); earliest bid breaks ties. With no requests, earliest eligible rotation slot wins. Discount is shared among the other members. All contributions are funded. Retain ${retain} minor units; release ${pot - discount - retain}.`;
  await c.query(
    "INSERT INTO agent_actions(circle_id,tool,args,decision,result) VALUES($1,$2,$3,$4,$5)",
    [
      id,
      "cycle_decision",
      JSON.stringify({ cycle_id: cycle.id }),
      "policy_approved",
      JSON.stringify({
        currency: circle.currency,
        winner: win.id,
        reason,
        pot,
        payout: pot - discount - retain,
        retained: retain,
      }),
    ],
  );
  await enqueuePayout(
    c,
    win,
    pot - discount - retain,
    "winner",
    `winner:${cycle.id}`,
    `pot:${cycle.id}`,
  );
  await c.query("UPDATE members SET has_won=true WHERE id=$1", [win.id]);
  await c.query(
    "UPDATE cycles SET status='closed',winner_member_id=$2,discount=$3 WHERE id=$1",
    [cycle.id, win.id, discount],
  );
  // Release only retention in excess of remaining principal obligations.
  for (const m of members.filter((m) => m.has_won)) {
    const held = await balance(c, `retention:${m.id}`);
    const needed = Math.max(
      0,
      (circle.n_members - cycle.n) * Number(circle.contribution) -
        (await balance(c, `collateral:${m.id}`)),
    );
    await enqueuePayout(
      c,
      m,
      Math.max(0, held - needed),
      "retention_release",
      `release:${cycle.id}:${m.id}`,
      `retention:${m.id}`,
    );
  }
  if (cycle.n === circle.n_members) {
    await c.query("UPDATE circles SET status='completed' WHERE id=$1", [id]);
    for (const m of members) {
      await trust(c, m.user_id, "completed", 10, id);
      if ((await balance(c, `collateral:${m.id}`)) >= Number(m.required_collateral))
        await trust(c, m.user_id, "untouched", 5, id);
      await settle(c, m.id);
    }
  } else
    await newCycle(
      c,
      circle,
      cycle.n + 1,
      circle.rules_json?.demo_cycle_seconds ? new Date() : new Date(cycle.due_at),
    );
  return {
    winner: win.id,
    pot,
    discount,
    retained: retain,
    payout: pot - discount - retain,
  };
}
export async function scheduler() {
  const circles = await tx(
    async (c) =>
      (
        await c.query(
          "SELECT id FROM circles WHERE status='active' AND timer_paused_at IS NULL",
        )
      ).rows,
  );
  for (const circle of circles) {
    await tx((c) => tick(c, circle.id));
    const rules = await tx(
      async (c) =>
        (await c.query("SELECT rules_json FROM circles WHERE id=$1", [circle.id])).rows[0]
          .rules_json,
    );
    if (rules?.request_window_seconds) {
      const ready = await tx((c) => openRequestWindow(c, circle.id));
      if (ready) await tx((c) => closeCycle(c, circle.id));
      continue;
    }
    // Demo closes explicitly for stage control. Sandbox closes automatically after grace.
    if (
      !demo ||
      (
        await tx(
          async (c) =>
            (await c.query("SELECT rules_json FROM circles WHERE id=$1", [circle.id]))
              .rows[0],
        )
      ).rules_json?.demo_cycle_seconds
    ) {
      const ready = await tx(
        async (c) =>
          (
            await c.query(
              "SELECT cy.id FROM cycles cy JOIN circles ci ON ci.id=cy.circle_id WHERE ci.id=$1 AND cy.n=ci.current_cycle AND cy.status<>'closed' AND cy.grace_end_at<now() AND NOT EXISTS(SELECT 1 FROM contributions co WHERE co.cycle_id=cy.id AND co.status='pending')",
              [circle.id],
            )
          ).rows.length > 0,
      );
      if (ready)
        try {
          await tx((c) => closeCycle(c, circle.id));
        } catch (e) {
          console.warn("Cycle close deferred:", String(e));
        }
    }
  }
}
