import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, verify as verifySignature, createPublicKey } from "node:crypto";
import { migrate, tx, closeDB } from "../server/db.js";
import { createCircle, register, join, snapshot } from "../server/circles.js";
import { createOrder, applyCapture, processPayouts } from "../server/paypal.js";
import { closeCycle, tick } from "../server/cycleEngine.js";
import { balance, verify, post, digest } from "../server/ledger.js";
import { computeSettlement, settle } from "../server/settlement.js";
import { bid, dividends } from "../server/auction.js";
import { holdback, settlementMath } from "../server/policy.js";
import { badge } from "../server/trust.js";
import { tool } from "../server/treasurer.js";
before(migrate);
after(closeDB);
async function fixture(n = 5, mode = "rotation") {
  return tx(async (c) => {
    const circle = await createCircle(c, { name: "Test", n_members: n, mode });
    const members = [];
    for (let i = 0; i < n; i++) {
      const u = await register(c, `Member ${i}`, `${randomUUID()}@example.com`);
      members.push(await join(c, circle.id, u.id));
    }
    return { circle, members };
  });
}
async function payment(member: any, kind: string) {
  return tx(async (c) => {
    const o = await createOrder(c, member.id, kind, randomUUID());
    const capture = {
      id: randomUUID(),
      status: "COMPLETED",
      amount: { currency_code: "INR", value: (Number(o.amount) / 100).toFixed(2) },
    };
    await applyCapture(c, o, capture);
    return { o, capture };
  });
}
async function fund(f: any) {
  for (const m of f.members) await payment(m, "collateral");
}
async function advance(f: any) {
  await tx(async (c) => {
    await c.query(
      "UPDATE circles SET clock_at=(SELECT grace_end_at+interval '1 second' FROM cycles WHERE circle_id=$1 ORDER BY n DESC LIMIT 1) WHERE id=$1",
      [f.circle.id],
    );
    await tick(c, f.circle.id);
  });
}
test("integer settlement and full-exposure holdback math", () => {
  assert.deepEqual(settlementMath(95000, 0, 0, 500, 0, 5000), {
    collateral_balance: 95000,
    unpaid_contributions: 0,
    late_fees: 0,
    platform_fees: 500,
    outstanding_debt: 0,
    exit_penalty: 5000,
    refund: 89500,
    debt: 0,
  });
  assert.equal(holdback(250000, 200000, 150000), 50000);
  assert.equal(holdback(250000, 0, 150000), 0);
});
test("activation waits for every verified collateral deposit; duplicate capture credits once", async () => {
  const f = await fixture();
  for (const m of f.members.slice(0, 4)) await payment(m, "collateral");
  assert.equal((await tx((c) => snapshot(c, f.circle.id))).circle.status, "forming");
  const { o, capture } = await payment(f.members[4], "collateral");
  await tx((c) => applyCapture(c, o, capture));
  const s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.circle.status, "active");
  assert.equal(s.ledger.length, 5);
  assert.equal(s.cycles.length, 1);
});
test("wrong capture amount is rejected without changing ledger", async () => {
  const f = await fixture(2);
  await assert.rejects(
    tx(async (c) => {
      const o = await createOrder(c, f.members[0].id, "collateral", randomUUID());
      await applyCapture(c, o, {
        id: randomUUID(),
        status: "COMPLETED",
        amount: { currency_code: "INR", value: "1.00" },
      });
    }),
    /mismatch/,
  );
  assert.equal((await tx((c) => snapshot(c, f.circle.id))).ledger.length, 0);
});
test("hero demo: normal cycle, default coverage, whole pot, retention, refund, signed badge", async () => {
  const f = await fixture();
  await fund(f);
  for (const m of f.members) await payment(m, "contribution");
  const first = await tx((c) => closeCycle(c, f.circle.id));
  assert.equal(first.pot, 250000);
  assert.equal(first.retained, 50000);
  assert.equal(first.payout, 200000);
  await processPayouts();
  for (const m of f.members.filter((_: any, i: number) => i !== 4))
    await payment(m, "contribution");
  await advance(f);
  await advance(f); // Repeated scheduler must not charge twice.
  let s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.members[4].collateral, 95000);
  assert.equal(s.cycles[1].pot, 250000);
  assert.equal(s.ledger.filter((e) => e.kind === "late_fee").length, 1);
  const estimate = await tx((c) => computeSettlement(c, f.members[4].id));
  assert.equal(estimate.refund, 89500);
  // The next winner is paid before the defaulting, non-winning member exits.
  const second = await tx((c) => closeCycle(c, f.circle.id));
  assert.equal(second.pot, 250000);
  await processPayouts();
  const settlement = await tx((c) => settle(c, f.members[4].id));
  assert.equal(Number(settlement.refund), 89500);
  await tx((c) => settle(c, f.members[4].id));
  await processPayouts();
  s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.circle.status, "paused");
  assert.equal(s.payouts.filter((p) => p.purpose === "refund").length, 1);
  assert.equal(s.payouts.find((p) => p.purpose === "refund").status, "succeeded");
  assert.equal((await tx(verify)).valid, true);
  const user = await tx(
    async (c) =>
      (await c.query("SELECT * FROM users WHERE id=$1", [f.members[4].user_id])).rows[0],
  );
  const b = badge(user);
  assert.ok(
    verifySignature(
      null,
      Buffer.from(b.payload),
      createPublicKey(b.public_key),
      Buffer.from(b.signature, "base64"),
    ),
  );
});
test("default covered pot can pay next winner and release prior retention", async () => {
  const f = await fixture();
  await fund(f);
  for (const m of f.members) await payment(m, "contribution");
  await tx((c) => closeCycle(c, f.circle.id));
  for (const m of f.members.filter((_: any, i: number) => i !== 4))
    await payment(m, "contribution");
  await advance(f);
  const r = await tx((c) => closeCycle(c, f.circle.id));
  assert.equal(r.pot, 250000);
  const s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.members[0].retention, 0);
  assert.equal(s.payouts.filter((p) => p.purpose === "retention_release").length, 1);
});
test("simultaneous defaults and exhausted collateral never invent pot funds or repeat fees", async () => {
  const f = await fixture(2);
  await fund(f);
  await tx(async (c) => {
    for (const m of f.members)
      await post(
        c,
        f.circle.id,
        m.id,
        `collateral:${m.id}`,
        "fees",
        149000,
        "test_depletion",
        randomUUID(),
      );
  });
  await advance(f);
  let s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.cycles[0].pot, 2000);
  assert.equal(Number(s.cycles[0].shortfall), 98000);
  await advance(f);
  s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(Number(s.members[0].fee_due), 5000);
  await assert.rejects(
    tx((c) => closeCycle(c, f.circle.id)),
    /Unfunded/,
  );
});
test("zero-collateral repeated ticks charge fee once", async () => {
  const f = await fixture(2);
  await fund(f);
  await tx((c) =>
    post(
      c,
      f.circle.id,
      f.members[0].id,
      `collateral:${f.members[0].id}`,
      "fees",
      150000,
      "test_depletion",
      randomUUID(),
    ),
  );
  await advance(f);
  await advance(f);
  const s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(Number(s.members[0].fee_due), 5000);
});
test("concurrent duplicate captures are serialized", async () => {
  const f = await fixture(2);
  const o = await tx((c) => createOrder(c, f.members[0].id, "collateral", randomUUID()));
  const cap = {
    id: randomUUID(),
    status: "COMPLETED",
    amount: { currency_code: "INR", value: "1500.00" },
  };
  await Promise.all([
    tx((c) => applyCapture(c, o, cap)),
    tx((c) => applyCapture(c, o, cap)),
  ]);
  assert.equal(await tx((c) => balance(c, `collateral:${f.members[0].id}`)), 150000);
});
test("auction highest discount wins; dividends conserve every minor unit", async () => {
  const f = await fixture(3, "auction");
  await fund(f);
  for (const m of f.members) await payment(m, "contribution");
  await tx((c) => bid(c, f.members[1].id, 10001));
  await tx((c) => bid(c, f.members[2].id, 20001));
  const result = await tx((c) => closeCycle(c, f.circle.id));
  assert.equal(result.winner, f.members[2].id);
  assert.equal(result.discount, 20001);
  const s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(
    s.members.reduce((a, m) => a + m.dividend, 0),
    20001,
  );
  assert.equal(
    dividends(5, ["a", "b"]).reduce((a, m) => a + m.amount, 0),
    5,
  );
});
test("append-only trigger blocks tampering; canonical hash notices changed amount", async () => {
  await assert.rejects(
    tx((c) =>
      c.query("UPDATE ledger SET amount=1 WHERE seq=(SELECT min(seq) FROM ledger)"),
    ),
    /append-only/,
  );
  const row = await tx(
    async (c) => (await c.query("SELECT * FROM ledger ORDER BY seq LIMIT 1")).rows[0],
  );
  assert.equal(digest(row), row.hash);
  assert.notEqual(digest({ ...row, amount: Number(row.amount) + 1 }), row.hash);
  assert.equal((await tx(verify)).valid, true);
});
test("completion returns collateral and prevents extra cycles", async () => {
  const f = await fixture(2);
  await fund(f);
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const m of f.members) await payment(m, "contribution");
    await tx((c) => closeCycle(c, f.circle.id));
  }
  assert.equal((await tx((c) => snapshot(c, f.circle.id))).circle.status, "completed");
  const s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.settlements.length, 2);
  assert.equal(Number(s.settlements[0].refund), 149500);
  await assert.rejects(
    tx((c) => closeCycle(c, f.circle.id)),
    /not active/,
  );
});
test("Treasurer proposals cannot bypass grace or write arbitrary money", async () => {
  const f = await fixture(2);
  await fund(f);
  await tx((c) =>
    tool(c, "propose_collateral_deduction", { amount: 999999999 }, f.members[0].id),
  );
  assert.equal(await tx((c) => balance(c, `collateral:${f.members[0].id}`)), 150000);
  await assert.rejects(
    tx((c) => tool(c, "transfer_money", {}, f.members[0].id)),
    /whitelisted/,
  );
  const rule = await tx((c) =>
    tool(c, "parse_rule", { text: "late fee ₹50 after the 5th" }, f.members[0].id),
  );
  assert.equal(rule.applied, false);
  assert.equal(rule.proposal.late_fee_minor, 5000);
});

test("retained winner funds cover defaults after collateral is depleted", async () => {
  const f = await fixture();
  await fund(f);
  for (const m of f.members) await payment(m, "contribution");
  await tx((c) => closeCycle(c, f.circle.id));
  await tx((c) =>
    post(
      c,
      f.circle.id,
      f.members[0].id,
      `collateral:${f.members[0].id}`,
      "fees",
      150000,
      "test_depletion",
      randomUUID(),
    ),
  );
  for (const m of f.members.slice(1)) await payment(m, "contribution");
  await advance(f);
  const s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.cycles[1].pot, 250000);
  assert.equal(s.members[0].retention, 0);
  assert.equal(
    s.cycles[1].contributions.find((d: any) => d.member_id === f.members[0].id).status,
    "covered",
  );
});

test("accelerated demo automatically funds, selects, pays and audits once", async () => {
  const { scheduler } = await import("../server/cycleEngine.js");
  const f = await fixture();
  await tx((c) =>
    c.query("UPDATE circles SET rules_json=$2 WHERE id=$1", [
      f.circle.id,
      JSON.stringify({ demo_cycle_seconds: 115 }),
    ]),
  );
  await fund(f);
  let s = await tx((c) => snapshot(c, f.circle.id));
  const grace = +new Date(s.cycles[0].grace_end_at);
  const due = +new Date(s.cycles[0].due_at);
  assert.equal(grace - due, 30000);
  assert.ok(grace - Date.now() <= 115000);
  for (const m of f.members.slice(0, 4)) await payment(m, "contribution");
  await tx((c) =>
    c.query(
      "UPDATE cycles SET due_at=now()-interval '35 seconds',grace_end_at=now()-interval '1 second' WHERE id=$1",
      [s.cycles[0].id],
    ),
  );
  await scheduler();
  await processPayouts();
  s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.cycles[0].status, "closed");
  assert.equal(s.members[4].collateral, 95000);
  assert.equal(s.decisions[0].tool, "cycle_decision");
  assert.equal(s.decisions[0].result.winner, f.members[0].id);
  assert.equal(s.payouts.find((p) => p.purpose === "winner").status, "succeeded");
  await scheduler();
  s = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(s.payouts.filter((p) => p.purpose === "winner").length, 1);
});

test("existing member can re-enter an active circle; new members cannot join", async () => {
  const f = await fixture(2);
  await fund(f);
  const existing = await tx((c) => join(c, f.circle.id, f.members[0].user_id));
  assert.equal(existing.id, f.members[0].id);
  const outsider = await tx((c) =>
    register(c, "Outsider", `${randomUUID()}@example.com`),
  );
  await assert.rejects(
    tx((c) => join(c, f.circle.id, outsider.id)),
    /not accepting/,
  );
});

test("request window starts after funding, survives polling, and blocks early settlement", async () => {
  const f = await fixture(3);
  await tx((c) =>
    c.query("UPDATE circles SET rules_json=$2 WHERE id=$1", [
      f.circle.id,
      JSON.stringify({ request_window_seconds: 60 }),
    ]),
  );
  await fund(f);
  const { openRequestWindow } = await import("../server/cycleEngine.js");
  assert.equal(await tx((c) => openRequestWindow(c, f.circle.id)), false);
  await assert.rejects(
    tx((c) => bid(c, f.members[0].id, 0)),
    /not open/,
  );
  for (const m of f.members) await payment(m, "contribution");
  assert.equal(await tx((c) => openRequestWindow(c, f.circle.id)), false);
  const first = (await tx((c) => snapshot(c, f.circle.id))).cycles[0];
  assert.equal(
    +new Date(first.request_closes_at) - +new Date(first.request_opened_at),
    60000,
  );
  await tx((c) => openRequestWindow(c, f.circle.id));
  assert.equal(
    +new Date((await tx((c) => snapshot(c, f.circle.id))).cycles[0].request_closes_at),
    +new Date(first.request_closes_at),
  );
  await assert.rejects(
    tx((c) => closeCycle(c, f.circle.id)),
    /window must finish/,
  );
  await tx((c) => bid(c, f.members[0].id, 0));
  await tx((c) => bid(c, f.members[1].id, 10001));
  await tx((c) => bid(c, f.members[1].id, 20001));
  await tx((c) =>
    c.query("UPDATE circles SET clock_at=$2 WHERE id=$1", [
      f.circle.id,
      first.request_closes_at,
    ]),
  );
  await assert.rejects(
    tx((c) => bid(c, f.members[2].id, 30000)),
    /not open/,
  );
  const result = await tx((c) => closeCycle(c, f.circle.id));
  assert.equal(result.winner, f.members[1].id);
  assert.equal(result.discount, 20001);
  let state = await tx((c) => snapshot(c, f.circle.id));
  const shares = state.payouts.filter((p) => p.purpose === "dividend");
  assert.equal(shares.length, 2);
  assert.equal(
    shares.reduce((sum, p) => sum + Number(p.amount), 0),
    20001,
  );
  assert.ok(shares.every((p) => p.member_id !== result.winner));
  assert.equal(Math.abs(Number(shares[0].amount) - Number(shares[1].amount)), 1);
  assert.equal(
    state.members.reduce((sum, m) => sum + m.dividend, 0),
    0,
    "shares are reserved for actual payouts",
  );
  await processPayouts();
  state = await tx((c) => snapshot(c, f.circle.id));
  assert.ok(
    state.payouts
      .filter((p) => p.purpose === "dividend")
      .every((p) => p.status === "succeeded"),
  );
  for (const m of f.members) await payment(m, "contribution");
  await tx((c) => openRequestWindow(c, f.circle.id));
  await assert.rejects(
    tx((c) => bid(c, result.winner, 0)),
    /Not eligible/,
  );
});

test("expired request window automatically falls back to rotation and does not pay twice", async () => {
  const f = await fixture(2);
  await tx((c) =>
    c.query("UPDATE circles SET rules_json=$2 WHERE id=$1", [
      f.circle.id,
      JSON.stringify({ request_window_seconds: 60 }),
    ]),
  );
  await fund(f);
  for (const m of f.members) await payment(m, "contribution");
  const { scheduler } = await import("../server/cycleEngine.js");
  await scheduler();
  let state = await tx((c) => snapshot(c, f.circle.id));
  await tx((c) =>
    c.query("UPDATE circles SET clock_at=$2 WHERE id=$1", [
      f.circle.id,
      state.cycles[0].request_closes_at,
    ]),
  );
  await scheduler();
  await scheduler();
  state = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(state.cycles[0].winner_member_id, f.members[0].id);
  assert.equal(state.payouts.filter((p) => p.purpose === "winner").length, 1);
});

test("okay confirms only the member's specific deposit and repeated confirmation credits once", async () => {
  const f = await fixture(2);
  const { proposeDeposit, confirmDeposit } = await import("../server/deposit.js");
  const proposal = await proposeDeposit(f.members[0].id);
  assert.equal(proposal.amount, 150000);
  assert.equal((await proposeDeposit(f.members[0].id)).id, proposal.id);
  await assert.rejects(confirmDeposit(f.members[0].id, proposal.id, "maybe"), /okay/);
  await assert.rejects(confirmDeposit(f.members[1].id, proposal.id, "okay"), /belong/);
  await confirmDeposit(f.members[0].id, proposal.id, "Okay");
  await confirmDeposit(f.members[0].id, proposal.id, "okay");
  assert.equal(await tx((c) => balance(c, `collateral:${f.members[0].id}`)), 150000);
});
