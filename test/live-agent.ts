// Opt-in live API smoke test: synthetic data, in-memory DB, simulated payments.
import "dotenv/config";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "";
process.env.PAYMENT_MODE = "demo";
process.env.DEMO_DB_PATH = "memory://";
assert.ok(
  process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL,
  "Configure OPENAI_API_KEY and OPENAI_MODEL",
);
const { migrate, tx, closeDB } = await import("../server/db.js");
const { createCircle, register, join } = await import("../server/circles.js");
const { createOrder, applyCapture } = await import("../server/paypal.js");
const { computeSettlement } = await import("../server/settlement.js");
const { treasurer } = await import("../server/treasurer.js");
try {
  await migrate();
  const members = await tx(async (c) => {
    const circle = await createCircle(c, {
      name: "Synthetic AI smoke test",
      n_members: 2,
    });
    const ms = [];
    for (let i = 0; i < 2; i++) {
      const u = await register(c, `Test Member ${i}`, `test-${i}@example.com`);
      const m = await join(c, circle.id, u.id);
      ms.push(m);
      const o = await createOrder(c, m.id, "collateral", `test-collateral-${i}`);
      await applyCapture(c, o, {
        id: `synthetic-${i}`,
        status: "COMPLETED",
        amount: { currency_code: "INR", value: "1500.00" },
      });
    }
    return ms;
  });
  const m = members[0];
  const expected = await tx((c) => computeSettlement(c, m.id));
  const before = await tx(
    async (c) => (await c.query("SELECT COUNT(*) AS n FROM ledger")).rows[0].n,
  );
  const response = await treasurer(
    m.id,
    "Use compute_settlement to tell me exactly how much I would receive if I leave now. Explain each deduction and the currency. This is a dry run; do not execute any action.",
  );
  const actions = await tx(
    async (c) =>
      (await c.query("SELECT tool,result FROM agent_actions ORDER BY id")).rows,
  );
  assert.equal(response.mode, "OpenAI tool-calling");
  const settlementCall = actions.find((a) => a.tool === "compute_settlement");
  assert.ok(settlementCall, "Model did not invoke settlement tool");
  assert.equal(settlementCall.result.refund, expected.refund);
  assert.equal(settlementCall.result.currency, "INR");
  assert.equal(
    await tx(async (c) => (await c.query("SELECT COUNT(*) AS n FROM ledger")).rows[0].n),
    before,
    "Dry run changed ledger",
  );
  assert.ok(response.answer?.length, "Model returned no explanation");
  console.log(
    JSON.stringify(
      {
        passed: true,
        mode: response.mode,
        toolsCalled: actions.map((a) => a.tool),
        expectedRefund: expected.refund / 100,
        currency: "INR",
        ledgerUnchanged: true,
        answer: response.answer,
      },
      null,
      2,
    ),
  );
} catch (e: any) {
  console.error(
    JSON.stringify({
      passed: false,
      status: e.status ?? null,
      type: e.name,
      message: String(e.message).replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]"),
    }),
  );
  process.exitCode = 1;
} finally {
  await closeDB();
}
