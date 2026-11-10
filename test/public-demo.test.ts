import { test } from "node:test";
import assert from "node:assert/strict";
import { initialDemo, demoStep } from "../lib/demo.js";

test("public walkthrough covers defaults, highest discount, equal dividends and previous-winner exclusion", () => {
  let state = initialDemo();
  for (let member = 0; member < 5; member++)
    state = demoStep(state, { type: "deposit", member }, 0);
  assert.equal(state.phase, "collecting");
  for (let member = 0; member < 4; member++)
    state = demoStep(state, { type: "pay", member }, 1000);
  state = demoStep(state, { type: "tick" }, 55000);
  assert.equal(state.phase, "bidding");
  assert.equal(state.deadline, 115000);
  assert.equal(state.members[4].collateral, 95000);
  assert.match(state.members[4].notice, /late fee/);
  state = demoStep(state, { type: "bid", member: 0, discount: 10000 }, 56000);
  state = demoStep(state, { type: "bid", member: 1, discount: 20000 }, 57000);
  state = demoStep(state, { type: "tick" }, 115000);
  assert.equal(state.phase, "settled");
  assert.equal(state.members[1].won, true);
  assert.equal(state.members[1].received, 180000);
  assert.deepEqual(
    state.members.filter((_, i) => i !== 1).map((member) => member.received),
    [5000, 5000, 5000, 5000],
  );
  assert.equal(
    demoStep(state, { type: "tick" }, 120000).transactions.length,
    state.transactions.length,
  );
  state = demoStep(state, { type: "next" }, 120000);
  for (let member = 0; member < 5; member++)
    state = demoStep(state, { type: "pay", member }, 121000);
  state = demoStep(state, { type: "bid", member: 1, discount: 50000 }, 122000);
  assert.equal(state.members[1].discount, null);
  state = demoStep(state, { type: "tick" }, 181000);
  assert.equal(state.members[0].won, true);
  assert.equal(demoStep(state, { type: "next" }, 190000).round, 2);
  assert.equal(initialDemo().transactions.length, 0);
});

test("walkthrough bars a repeat defaulter and pauses with remaining collateral intact", () => {
  let state = initialDemo();
  for (let member = 0; member < 5; member++)
    state = demoStep(state, { type: "deposit", member }, 0);
  for (let round = 0; round < 2; round++) {
    const time = round * 200000;
    for (let member = 0; member < 4; member++)
      state = demoStep(state, { type: "pay", member }, time + 1000);
    state = demoStep(state, { type: "tick" }, time + 55000);
    if (round === 0) {
      state = demoStep(state, { type: "tick" }, 115000);
      state = demoStep(state, { type: "next" }, 200000);
    }
  }
  assert.equal(state.phase, "paused");
  assert.equal(state.members[4].barred, true);
  assert.equal(state.members[4].defaults, 2);
  assert.equal(state.members[4].collateral, 40000);
});
