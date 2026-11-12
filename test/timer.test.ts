import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, tx, closeDB } from "../server/db";
import { createCircle, register, join, snapshot } from "../server/circles";
import { createOrder, applyCapture } from "../server/paypal";
import { controlTimer } from "../server/timer";
import { tick, openRequestWindow, closeCycle } from "../server/cycleEngine";
import { bid } from "../server/auction";

before(migrate);
after(closeDB);

async function fixture(fast = true) {
  return tx(async (c) => {
    const owner = await register(c, "Creator", `${randomUUID()}@example.test`);
    const guest = await register(c, "Guest", `${randomUUID()}@example.test`);
    const circle = await createCircle(c, {
      creator_id: owner.id,
      n_members: 2,
      request_window_seconds: 60,
      ...(fast ? { demo_cycle_seconds: 60 } : {}),
    });
    const members = [
      await join(c, circle.id, owner.id),
      await join(c, circle.id, guest.id, circle.invite_token),
    ];
    for (const m of members) {
      const order = await createOrder(c, m.id, "collateral", randomUUID());
      await applyCapture(c, order, {
        id: randomUUID(),
        status: "COMPLETED",
        amount: { currency_code: "INR", value: (Number(order.amount) / 100).toFixed(2) },
      });
    }
    return { owner, guest, circle, members };
  });
}

test("creator pause blocks defaults and resume preserves remaining time without duplicate shifts", async () => {
  const f = await fixture();
  const initial = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(
    +new Date(initial.cycles[0].grace_end_at) - +new Date(initial.cycles[0].due_at),
    30000,
  );
  await assert.rejects(
    tx((c) => controlTimer(c, f.circle.id, f.guest.id, "pause")),
    /creator/,
  );
  await tx((c) => controlTimer(c, f.circle.id, f.owner.id, "pause"));
  await tx(async (c) => {
    await c.query(
      "UPDATE circles SET timer_paused_at=timer_paused_at-interval '10 minutes' WHERE id=$1",
      [f.circle.id],
    );
    await c.query(
      "UPDATE cycles SET due_at=due_at-interval '10 minutes',grace_end_at=grace_end_at-interval '10 minutes' WHERE circle_id=$1",
      [f.circle.id],
    );
    await tick(c, f.circle.id);
    assert.equal(await openRequestWindow(c, f.circle.id), false);
  });
  const paused = await tx((c) => snapshot(c, f.circle.id));
  assert.ok(paused.members.every((m) => m.default_count === 0));
  await assert.rejects(
    tx((c) => closeCycle(c, f.circle.id)),
    /paused/,
  );
  await tx((c) => controlTimer(c, f.circle.id, f.owner.id, "resume"));
  const resumed = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(resumed.circle.timer_paused_at, null);
  assert.ok(+new Date(resumed.cycles[0].grace_end_at) > Date.now());
  await tx((c) => controlTimer(c, f.circle.id, f.owner.id, "resume"));
  assert.equal(
    +new Date((await tx((c) => snapshot(c, f.circle.id))).cycles[0].grace_end_at),
    +new Date(resumed.cycles[0].grace_end_at),
  );
});

test("existing circle opts into short timing paused; bidding stays frozen until resume", async () => {
  const f = await fixture(false);
  await tx((c) => controlTimer(c, f.circle.id, f.owner.id, "enable_demo"));
  const changed = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(changed.circle.rules_json.demo_cycle_seconds, 60);
  assert.ok(changed.circle.timer_paused_at);
  await tx((c) => controlTimer(c, f.circle.id, f.owner.id, "resume"));
  await tx(async (c) => {
    for (const m of f.members) {
      const order = await createOrder(c, m.id, "contribution", randomUUID());
      await applyCapture(c, order, {
        id: randomUUID(),
        status: "COMPLETED",
        amount: { currency_code: "INR", value: (Number(order.amount) / 100).toFixed(2) },
      });
    }
    await openRequestWindow(c, f.circle.id);
  });
  await tx((c) => controlTimer(c, f.circle.id, f.owner.id, "pause"));
  await assert.rejects(
    tx((c) => bid(c, f.members[0].id, 0)),
    /eligible/,
  );
  await tx(async (c) => {
    await c.query(
      "UPDATE circles SET timer_paused_at=timer_paused_at-interval '2 minutes' WHERE id=$1",
      [f.circle.id],
    );
    await c.query(
      "UPDATE cycles SET request_opened_at=request_opened_at-interval '2 minutes',request_closes_at=request_closes_at-interval '2 minutes' WHERE circle_id=$1",
      [f.circle.id],
    );
    assert.equal(await openRequestWindow(c, f.circle.id), false);
  });
  await tx((c) => controlTimer(c, f.circle.id, f.owner.id, "resume"));
  await tx((c) => bid(c, f.members[0].id, 0));
  const state = await tx((c) => snapshot(c, f.circle.id));
  assert.equal(
    +new Date(state.cycles[0].request_closes_at) -
      +new Date(state.cycles[0].request_opened_at),
    60000,
  );
});
