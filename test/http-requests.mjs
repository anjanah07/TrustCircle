import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3001/api";
async function api(path, body, token) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.ok(response.ok, data.error);
  return data;
}
assert.equal(
  (await api("/config")).demo,
  true,
  "Run against an isolated simulated app only",
);
const users = [];
for (let index = 0; index < 3; index++)
  users.push(
    await api("/register", {
      name: `Request test ${index}`,
      email: `${crypto.randomUUID()}@example.com`,
    }),
  );
const circle = await api(
  "/circles",
  {
    name: "Request integration",
    contribution: 10000,
    n_members: 3,
    mode: "auction",
    request_window_seconds: 15,
  },
  users[0].token,
);
for (const user of users.slice(1))
  await api(`/circles/${circle.id}/join`, {}, user.token);
let state = await api(`/circles/${circle.id}`, undefined, users[0].token);
const members = users.map((user) => ({
  ...user,
  member: state.members.find((member) => member.user_id === user.id),
}));
for (const user of members) {
  const proposal = await api(
    `/members/${user.member.id}/deposit-proposal`,
    {},
    user.token,
  );
  assert.equal(proposal.amount, 30000);
  const result = await api(
    `/members/${user.member.id}/deposit-confirmation`,
    { order_id: proposal.id, confirmed: true },
    user.token,
  );
  assert.equal(result.status, "completed");
}
for (const user of members) {
  const order = await api(
    `/members/${user.member.id}/orders`,
    { kind: "contribution", key: crypto.randomUUID() },
    user.token,
  );
  await api(`/orders/${order.id}/capture`, {}, user.token);
}
const started = Date.now();
while (Date.now() - started < 10000) {
  state = await api(`/circles/${circle.id}`, undefined, users[0].token);
  if (state.cycles[0].request_opened_at) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(state.cycles[0].request_closes_at);
assert.equal(state.payouts.length, 0, "No payout before the request window closes");
await api(`/members/${members[0].member.id}/bid`, { discount: 1001 }, users[0].token);
await api(`/members/${members[1].member.id}/bid`, { discount: 2001 }, users[1].token);
while (Date.now() - started < 25000) {
  state = await api(`/circles/${circle.id}`, undefined, users[0].token);
  if (state.payouts.filter((payout) => payout.status === "succeeded").length === 3) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(state.cycles[0].winner_member_id, members[1].member.id);
const shares = state.payouts.filter((payout) => payout.purpose === "dividend");
assert.equal(shares.length, 2);
assert.equal(
  shares.reduce((sum, payout) => sum + Number(payout.amount), 0),
  2001,
);
assert.ok(state.payouts.every((payout) => payout.status === "succeeded"));
console.log(
  "Passed: button-confirmed deposits, full-funding window, highest discount winner, automatic winner and equal-share payouts.",
);
await api(`/members/${members[2].member.id}/exit`, {}, users[2].token);
