import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const axios = createRequire(require.resolve("@paypal/agent-toolkit/openai"))("axios");
import { makeToolkit, paypalAgentTools } from "../server/paypalToolkit.js";
import { runPayPalAgentTool } from "../server/paypalAgent.js";
import { migrate, tx, closeDB } from "../server/db.js";
import { createCircle, register, join } from "../server/circles.js";
before(migrate);
after(closeDB);
test("toolkit exposes only the three orders tools; model cannot choose amounts", () => {
  const tools = paypalAgentTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["create_order", "get_order", "pay_order"],
  );
  assert.deepEqual(Object.keys(tools[0]!.parameters.properties), ["kind"]);
  assert.equal(tools[0]!.parameters.additionalProperties, false);
});
test("actual toolkit adapter produces sandbox requests and capture response", async () => {
  const toolkit = makeToolkit("saved-request-id");
  // Replace transport only, so no credentials or network are used.
  toolkit.client.getHeaders = async () => ({ "PayPal-Request-Id": "saved-request-id" });
  const original = axios.defaults.adapter;
  const requests: any[] = [];
  axios.defaults.adapter = async (config: any) => {
    requests.push(config);
    return {
      data: {
        id: "TESTORDER123456789",
        status: config.url?.endsWith("/capture") ? "COMPLETED" : "CREATED",
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  try {
    for (const [name, args] of [
      [
        "create_order",
        {
          currencyCode: "USD",
          items: [
            {
              name: "Collateral",
              quantity: 1,
              itemCost: 15,
              itemTotal: 15,
              taxPercent: 0,
            },
          ],
        },
      ],
      ["get_order", { id: "TESTORDER123456789" }],
      ["pay_order", { id: "TESTORDER123456789" }],
    ] as const) {
      const output = await toolkit.handleToolCall({
        id: "test",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
      const data = JSON.parse(String(output.content));
      assert.ok(!data.error, JSON.stringify(data));
    }
    assert.equal(requests.length, 3);
    assert.ok(requests.every((r) => r.url.startsWith("https://api.sandbox.paypal.com/")));
    assert.equal(JSON.parse(requests[0].data).purchase_units[0].amount.value, "15");
    assert.equal(requests[2].headers["PayPal-Request-Id"], "saved-request-id");
  } finally {
    axios.defaults.adapter = original;
  }
});
test("agent enforces ownership, rejects arbitrary prices, and never invents demo approval", async () => {
  const members = await tx(async (c) => {
    const ci = await createCircle(c, { name: "Toolkit test", n_members: 2 });
    const ms = [];
    for (let i = 0; i < 2; i++) {
      const u = await register(c, `Test ${i}`, `toolkit-${i}@example.com`);
      ms.push(await join(c, ci.id, u.id));
    }
    return ms;
  });
  const order = await runPayPalAgentTool(
    "create_order",
    { kind: "collateral" },
    members[0].id,
  );
  assert.equal(order.amount, 150000);
  assert.equal(order.simulated, true);
  const again = await runPayPalAgentTool(
    "create_order",
    { kind: "collateral" },
    members[0].id,
  );
  assert.equal(order.id, again.id);
  await assert.rejects(
    runPayPalAgentTool("get_order", { id: order.id }, members[1].id),
    /does not belong/,
  );
  await assert.rejects(
    runPayPalAgentTool("pay_order", { id: order.id }, members[0].id),
    /no PayPal approval/,
  );
  await assert.rejects(
    runPayPalAgentTool("create_order", { kind: "collateral", amount: 1 }, members[0].id),
  );
});
