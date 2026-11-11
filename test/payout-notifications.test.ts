import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PayoutNotifications from "../components/PayoutNotifications";
import type { Payout } from "../components/types";

const payout: Payout = {
  id: "receipt",
  member_id: "recipient",
  amount: "50000",
  purpose: "winner",
  status: "succeeded",
  receiver: "recipient@example.test",
  batch_id: "batch",
  item_id: "item",
  last_error: null,
};
const render = (payouts: Payout[], simulated = false, memberId = "recipient") =>
  renderToStaticMarkup(
    createElement(PayoutNotifications, {
      payouts,
      memberId,
      currency: "USD",
      simulated,
    }),
  );

test("only confirmed payouts notify their recipient and sandbox links never promise withdrawal", () => {
  for (const status of ["pending", "sent", "failed"])
    assert.equal(render([{ ...payout, status }]), "");
  assert.equal(render([payout], false, "another-member"), "");
  const html = render([payout]);
  assert.match(html, /\$500\.00/);
  assert.match(html, /recipient@example.test/);
  assert.match(html, /https:\/\/www.sandbox.paypal.com\//);
  assert.match(html, /cannot be withdrawn to a real bank account/);
  assert.match(html, /PayPal confirmed delivery/);
  const demo = render([payout], true);
  assert.match(demo, /No money was transferred/);
  assert.doesNotMatch(demo, /href=|PayPal confirmed delivery/);
});
