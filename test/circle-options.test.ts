import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, tx, closeDB } from "../server/db.js";
import { createCircle, register, join, snapshot } from "../server/circles.js";
import { getPublicCircles, getCirclePreview, getCirclesId } from "../server/api.js";
import { createOrder, applyCapture } from "../server/paypal.js";
import { tick, closeCycle } from "../server/cycleEngine.js";
import { barMember, runDefaultReview } from "../server/defaultAgent.js";
import { balance } from "../server/ledger.js";
import { bid } from "../server/auction.js";
before(migrate);
after(closeDB);
const context = (user: any, id = "", token = "") => ({
  user,
  params: { id },
  body: {},
  headers: { "x-circle-invite": token },
});
async function user() {
  return tx((c) => register(c, "Test", `${randomUUID()}@example.test`));
}
async function payment(memberId: string, kind: string) {
  return tx(async (c) => {
    const order = await createOrder(c, memberId, kind, randomUUID());
    await applyCapture(c, order, {
      id: randomUUID(),
      status: "COMPLETED",
      amount: { currency_code: "INR", value: (Number(order.amount) / 100).toFixed(2) },
    });
    return order;
  });
}

test("custom payout and collateral, private invitation authorization and token privacy", async () => {
  const owner = await user(),
    guest = await user(),
    outsider = await user();
  const circle = await tx((c) =>
    createCircle(c, {
      creator_id: owner.id,
      monthly_payout: 240000,
      n_members: 3,
      collateral_amount: 100000,
    }),
  );
  assert.equal(Number(circle.contribution), 80000);
  const first = await tx((c) => join(c, circle.id, owner.id));
  assert.equal(Number(first.required_collateral), 100000);
  await assert.rejects(
    tx((c) => join(c, circle.id, guest.id)),
    /invite/,
  );
  await assert.rejects(
    getCirclePreview(context(guest, circle.id, "wrong")),
    /unavailable/,
  );
  assert.equal(
    (await getCirclePreview(context(guest, circle.id, circle.invite_token))).status,
    200,
  );
  await tx((c) => join(c, circle.id, guest.id, circle.invite_token));
  await tx((c) =>
    c.query(
      "INSERT INTO payouts(idempotency_key,member_id,receiver,amount,purpose,status) VALUES($1,$2,$3,50000,'winner','succeeded')",
      [randomUUID(), first.id, "private-recipient@example.test"],
    ),
  );
  const state = await (await getCirclesId(context(guest, circle.id))).json();
  assert.equal(state.payouts[0].receiver, undefined);
  assert.equal(state.circle.invite_token, undefined);
  const own = await (await getCirclesId(context(owner, circle.id))).json();
  assert.equal(own.circle.invite_token, circle.invite_token);
  assert.equal(own.payouts[0].receiver, "private-recipient@example.test");
  await assert.rejects(getCirclesId(context(outsider, circle.id)), /access/);
  await assert.rejects(
    tx((c) => createCircle(c, { monthly_payout: 10000, n_members: 3 })),
    /divide equally/,
  );
  await assert.rejects(
    tx((c) =>
      createCircle(c, { monthly_payout: 30000, n_members: 3, collateral_amount: 9999 }),
    ),
    /at least/,
  );
});

test("public circle score gate cannot be bypassed and full circles disappear", async () => {
  const owner = await user(),
    guest = await user();
  await tx((c) => c.query("UPDATE users SET trust_score=70 WHERE id=$1", [owner.id]));
  const circle = await tx((c) =>
    createCircle(c, {
      creator_id: owner.id,
      visibility: "public",
      min_trust_score: 60,
      n_members: 2,
    }),
  );
  await tx((c) => join(c, circle.id, owner.id));
  let available = await (await getPublicCircles(context(guest))).json();
  assert.ok(available.some((row: any) => row.id === circle.id));
  assert.ok(available.every((row: any) => !row.invite_token && !row.creator_id));
  await assert.rejects(
    tx((c) => join(c, circle.id, guest.id, circle.invite_token)),
    /trust score/,
  );
  await tx((c) => c.query("UPDATE users SET trust_score=60 WHERE id=$1", [guest.id]));
  await tx((c) => join(c, circle.id, guest.id));
  available = await (await getPublicCircles(context(guest))).json();
  assert.ok(!available.some((row: any) => row.id === circle.id));
  const extra = await user();
  await tx((c) => c.query("UPDATE users SET trust_score=60 WHERE id=$1", [extra.id]));
  await assert.rejects(
    tx((c) => join(c, circle.id, extra.id)),
    /full/,
  );
});

test("two distinct defaults trigger a guarded model tool, preserve balance, pause the circle and cannot be undone by late capture", async () => {
  const circle = await tx((c) =>
    createCircle(c, { n_members: 3, collateral_amount: 150000 }),
  );
  const members = [];
  for (let i = 0; i < 3; i++) {
    const u = await user();
    members.push(await tx((c) => join(c, circle.id, u.id)));
  }
  for (const m of members) await payment(m.id, "collateral");
  const defaulter = members[2];
  await assert.rejects(
    tx((c) => barMember(c, defaulter.id, "test")),
    /Two verified/,
  );
  let delayedOrder: any;
  for (let round = 0; round < 2; round++) {
    await payment(members[0].id, "contribution");
    await payment(members[1].id, "contribution");
    if (round === 1)
      delayedOrder = await tx((c) =>
        createOrder(c, defaulter.id, "contribution", randomUUID()),
      );
    await tx(async (c) => {
      await c.query(
        "UPDATE circles SET clock_at=(SELECT grace_end_at+interval '1 second' FROM cycles WHERE circle_id=$1 ORDER BY n DESC LIMIT 1) WHERE id=$1",
        [circle.id],
      );
      await tick(c, circle.id);
    });
    if (round === 0) {
      await tx((c) => tick(c, circle.id));
      assert.equal((await tx((c) => snapshot(c, circle.id))).members[2].default_count, 1);
      await assert.rejects(
        tx((c) => barMember(c, defaulter.id, "test")),
        /Two verified/,
      );
      await tx((c) => closeCycle(c, circle.id));
    }
  }
  const before = await tx((c) => balance(c, `collateral:${defaulter.id}`));
  assert.equal(before, 40000);
  let called = false;
  const fake: any = {
    responses: {
      create: async (request: any) => {
        called = true;
        assert.match(request.instructions, /Two distinct contributions/);
        return {
          output: [
            {
              type: "function_call",
              name: "bar_member",
              arguments: JSON.stringify({ member_id: defaulter.id }),
            },
          ],
        };
      },
    },
  };
  await runDefaultReview({ id: defaulter.id, default_count: 2 }, fake);
  assert.equal(called, true);
  await runDefaultReview({ id: defaulter.id, default_count: 2 }, fake);
  const state = await tx((c) => snapshot(c, circle.id));
  assert.equal(state.circle.status, "paused");
  assert.ok(state.members[2].barred_at);
  assert.equal(state.members[2].default_count, 2);
  assert.equal(await tx((c) => balance(c, `collateral:${defaulter.id}`)), before);
  assert.equal(state.decisions.filter((row: any) => row.tool === "bar_member").length, 1);
  assert.equal(
    state.decisions.find((row: any) => row.tool === "bar_member").result.source,
    "openai_tool_call",
  );
  await assert.rejects(
    tx((c) => createOrder(c, defaulter.id, "topup", randomUUID())),
    /two defaults/,
  );
  await assert.rejects(
    tx((c) => bid(c, defaulter.id, 0)),
    /eligible/,
  );
  await assert.rejects(
    tx((c) => join(c, circle.id, defaulter.user_id)),
    /barred/,
  );
  await tx((c) =>
    applyCapture(c, delayedOrder, {
      id: randomUUID(),
      status: "COMPLETED",
      amount: { currency_code: "INR", value: "500.00" },
    }),
  );
  const afterCapture = await tx((c) => snapshot(c, circle.id));
  assert.equal(afterCapture.members[2].status, "suspended");
  assert.ok(afterCapture.members[2].barred_at);
  assert.equal(afterCapture.members[2].collateral, 90000);
});
