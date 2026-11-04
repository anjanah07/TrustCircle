import "dotenv/config";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "";
process.env.PAYMENT_MODE = "demo";
process.env.DEMO_DB_PATH = "memory://";
assert.ok(
  process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL,
  "Configure model and key",
);
const { migrate, tx, closeDB } = await import("../server/db.js");
const { createCircle } = await import("../server/circles.js");
const { explainDecisions } = await import("../server/autonomous.js");
try {
  await migrate();
  const ci = await tx(async (c) => {
    const ci = await createCircle(c, {
      name: "Synthetic autonomous explanation",
      n_members: 5,
    });
    await c.query(
      "INSERT INTO agent_actions(circle_id,tool,args,decision,result) VALUES($1,$2,$3,$4,$5)",
      [
        ci.id,
        "cycle_decision",
        "{}",
        "policy_approved",
        JSON.stringify({
          winner: "synthetic-member-1",
          reason:
            "Slot 1 is the earliest active member who has not received a pot. All five contributions are funded.",
          pot: 250000,
          payout: 200000,
          retained: 50000,
        }),
      ],
    );
    return ci;
  });
  await explainDecisions();
  const result = await tx(
    async (c) =>
      (
        await c.query(
          "SELECT result FROM agent_actions WHERE circle_id=$1 AND tool='agent_explanation'",
          [ci.id],
        )
      ).rows[0],
  );
  assert.ok(result?.result.explanation);
  assert.equal(
    result.result.source,
    "openai",
    "Model request fell back to policy explanation",
  );
  console.log(
    JSON.stringify({
      passed: true,
      trigger: "automatic decision feed, no chat prompt",
      ...result.result,
    }),
  );
} finally {
  await closeDB();
}
