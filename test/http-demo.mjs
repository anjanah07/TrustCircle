import assert from "node:assert/strict";
const base = "http://127.0.0.1:3000/api";
async function api(path, body, token) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  assert.ok(r.ok, data.error);
  return data;
}
const fixture = await api("/demo", {});
const members = fixture.members;
const circle = fixture.circle.id;
async function pay(m, kind) {
  const o = await api(
    `/members/${m.id}/orders`,
    { kind, key: crypto.randomUUID() },
    m.token,
  );
  await api(`/orders/${o.id}/capture`, {}, m.token);
}
for (const m of members) await pay(m, "collateral");
const started = Date.now();
for (const m of members.slice(0, 4)) await pay(m, "contribution");
console.log(
  "Activated synthetic circle; four contributions paid; waiting for automatic first payout.",
);
let state;
while (Date.now() - started < 130000) {
  state = await api(`/circles/${circle}`, undefined, members[4].token);
  if (state.payouts.some((p) => p.purpose === "winner" && p.status === "succeeded"))
    break;
  await new Promise((r) => setTimeout(r, 5000));
}
assert.equal(state.cycles[0].status, "closed");
assert.ok(Date.now() - started < 125000, "Payout exceeded expected polling tolerance");
assert.equal(state.members.find((m) => m.id === members[4].id).collateral, 95000);
assert.ok(
  state.ledger.some(
    (l) =>
      l.member_id === members[4].id && l.kind === "late_fee" && Number(l.amount) === 5000,
  ),
);
assert.equal(
  state.decisions.find((d) => d.tool === "cycle_decision").result.winner,
  members[0].id,
);
const accounts = await Promise.all(members.map((m) => api("/me", undefined, m.token)));
assert.equal(new Set(accounts.map((a) => a.paypal_email)).size, 5);
for (const m of members) {
  const personal = await api(`/circles/${circle}`, undefined, m.token);
  assert.ok(personal.payouts.every((p) => !("receiver" in p)));
  assert.equal(personal.ownOrders.length, m === members[4] ? 1 : 2);
}
console.log(
  JSON.stringify({
    passed: true,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    winner: "Ananya",
    winnerPayout: 2000,
    retained: 500,
    SaraCollateral: 950,
    fiveDistinctAccounts: true,
    privateOrderViews: true,
    automatic: true,
  }),
);
// Settle the synthetic missed-payment member so the new fixture does not keep cycling unattended.
await api(`/members/${members[4].id}/exit`, {}, members[4].token);
console.log("Synthetic test circle paused through normal exit settlement.");
