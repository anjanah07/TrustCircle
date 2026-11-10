import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";

// Exercise the real PayPal branch, replacing transport and database only.
// Never load configured credentials or contact external services in this test.
process.env.PAYMENT_MODE = "paypal";
process.env.DATABASE_URL = "postgresql://unused:unused@localhost/unused";
process.env.PAYPAL_CLIENT_ID = "contract-test";
process.env.PAYPAL_CLIENT_SECRET = "contract-test";
process.env.PAYPAL_WEBHOOK_ID = "contract-webhook";
process.env.APP_URL = "https://example.test";
(globalThis as any).trustCircleDatabase = {
  embedded: new PGlite("memory://"),
  pool: null,
  queue: Promise.resolve(),
};
const { migrate, tx, closeDB } = await import("../server/db.js");
const { createCircle, register, join } = await import("../server/circles.js");
const { createOrder, prepareOrder, captureOrder, reconcileOrders } =
  await import("../server/paypal.js");
const { balance } = await import("../server/ledger.js");
const { webhook } = await import("../server/webhook.js");
const require = createRequire(import.meta.url);
const axios = createRequire(require.resolve("@paypal/agent-toolkit/openai"))("axios");
const originalAdapter = axios.defaults.adapter;
const originalFetch = globalThis.fetch;
let status = "CREATED",
  captureStatus = "PENDING",
  buyer = "member@example.test",
  amount = "1500.00";
let captured = false,
  captureCalls = 0;
let signature = "SUCCESS";
const requests: any[] = [];
axios.defaults.adapter = async (config: any) => {
  requests.push(config);
  let data: any;
  if (config.url.endsWith("/oauth2/token")) data = { access_token: "test-token" };
  else {
    if (config.url.endsWith("/capture")) {
      captured = true;
      captureCalls++;
    }
    data = {
      id: "ORDER123456789",
      status,
      payer: { email_address: buyer },
      purchase_units: [
        {
          amount: { currency_code: "USD", value: amount },
          ...(captured
            ? {
                payments: {
                  captures: [
                    {
                      id: "CAPTURE123",
                      status: captureStatus,
                      amount: { currency_code: "USD", value: amount },
                    },
                  ],
                },
              }
            : {}),
        },
      ],
      links: [
        {
          rel: "approve",
          href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123456789",
        },
      ],
    };
  }
  return { data, status: 200, statusText: "OK", headers: {}, config };
};
globalThis.fetch = async (input) => {
  const url = String(input);
  assert.ok(url.startsWith("https://api-m.sandbox.paypal.com/"));
  if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "test-token" });
  assert.ok(url.endsWith("/verify-webhook-signature"));
  return Response.json({ verification_status: signature });
};
await migrate();
after(async () => {
  axios.defaults.adapter = originalAdapter;
  globalThis.fetch = originalFetch;
  await closeDB();
});

test("PayPal order lifecycle validates ownership, pending captures and webhook recovery", async () => {
  const member = await tx(async (c) => {
    const circle = await createCircle(c, { name: "Provider contract" });
    const user = await register(c, "Member", buyer);
    return join(c, circle.id, user.id);
  });
  const order = await tx((c) =>
    createOrder(c, member.id, "collateral", crypto.randomUUID()),
  );
  // An old unconfirmed proposal must still be able to start its first checkout.
  await tx((c) =>
    c.query("UPDATE payment_orders SET created_at=now()-interval '1 day' WHERE id=$1", [
      order.id,
    ]),
  );
  const reused = await tx((c) =>
    createOrder(c, member.id, "collateral", crypto.randomUUID()),
  );
  assert.equal(reused.id, order.id);
  const { confirmDeposit } = await import("../server/deposit.js");
  const confirmed = await confirmDeposit(member.id, order.id, true);
  assert.equal(confirmed.status, "awaiting_buyer_approval");
  assert.match(confirmed.approval_url!, /sandbox.paypal.com/);
  assert.equal(captureCalls, 0);
  assert.equal(await tx((c) => balance(c, `collateral:${member.id}`)), 0);
  const prepared = await prepareOrder(order.id);
  assert.equal(prepared.paypal_id, "ORDER123456789");
  const create = requests.find((r) => r.url.endsWith("/checkout/orders"));
  assert.equal(create.headers["PayPal-Request-Id"], order.id);
  const payload = JSON.parse(create.data);
  assert.equal(payload.purchase_units[0].amount.currency_code, "USD");
  assert.ok(JSON.stringify(payload).includes(`https://example.test/?order=${order.id}`));
  assert.equal((await captureOrder(order.id)).status, "awaiting_buyer_approval");
  assert.equal(captureCalls, 0);
  status = "APPROVED";
  buyer = "wrong@example.test";
  await assert.rejects(captureOrder(order.id), /registered PayPal/);
  buyer = "member@example.test";
  amount = "1.00";
  await assert.rejects(captureOrder(order.id), /amount\/currency mismatch/);
  amount = "1500.00";
  await webhook(
    {},
    {
      id: "APPROVAL123",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: { id: prepared.paypal_id },
    },
  );
  assert.equal((await captureOrder(order.id)).status, "pending");
  assert.equal(captureCalls, 1);
  assert.equal(await tx((c) => balance(c, `collateral:${member.id}`)), 0);
  const event = {
    id: "EVENT123",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { supplementary_data: { related_ids: { order_id: prepared.paypal_id } } },
  };
  signature = "FAILURE";
  await assert.rejects(webhook({}, event), /signature/);
  assert.equal(await tx((c) => balance(c, `collateral:${member.id}`)), 0);
  signature = "SUCCESS";
  status = "COMPLETED";
  captureStatus = "COMPLETED";
  buyer = "wrong@example.test";
  await assert.rejects(webhook({}, event), /registered PayPal/);
  buyer = "member@example.test";
  await webhook({}, event);
  await webhook({}, event);
  await reconcileOrders();
  assert.equal(await tx((c) => balance(c, `collateral:${member.id}`)), 150000);
  assert.equal(captureCalls, 1);
  const stored = await tx(
    async (c) =>
      (await c.query("SELECT * FROM payment_orders WHERE id=$1", [order.id])).rows[0],
  );
  assert.equal(stored.status, "completed");
  assert.equal(stored.capture_id, "CAPTURE123");
});
