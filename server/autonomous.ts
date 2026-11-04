import OpenAI from "openai";
import { tx } from "./db";
let running = false;
// Explanations are auditable summaries, not hidden chain-of-thought or permission to move money.
// Scheduler settlement never depends on LLM latency/availability.
export async function explainDecisions() {
  if (running || !process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return;
  running = true;
  try {
    const decisions = await tx(
      async (c) =>
        (
          await c.query(
            "SELECT a.* FROM agent_actions a WHERE a.tool='cycle_decision' AND NOT EXISTS(SELECT 1 FROM agent_actions b WHERE b.tool='agent_explanation' AND b.args->>'decision_id'=a.id::text) ORDER BY a.id LIMIT 3",
          )
        ).rows,
    );
    for (const d of decisions) {
      let explanation: string;
      let source = "openai";
      try {
        const reply = await new OpenAI({
          timeout: 45000,
          maxRetries: 0,
        }).responses.create({
          model: process.env.OPENAI_MODEL,
          instructions:
            "Explain this approved savings-circle payout decision in at most 3 short sentences. Use only the provided facts. Money amounts are integer minor units: divide monetary amounts by 100 and label them with the provided currency. Slot numbers are not money. This is an audit explanation, not permission to move money. Do not imply provider success, guaranteed safety, or invent member details.",
          input: JSON.stringify(d.result),
        });
        explanation = reply.output_text || d.result.reason;
      } catch {
        explanation = d.result.reason;
        source = "policy_fallback";
      }
      await tx(async (c) => {
        await c.query(
          "INSERT INTO agent_actions(circle_id,tool,args,decision,result) VALUES($1,$2,$3,$4,$5)",
          [
            d.circle_id,
            "agent_explanation",
            JSON.stringify({ decision_id: String(d.id) }),
            "explanation_only",
            JSON.stringify({ explanation, source }),
          ],
        );
      });
    }
  } finally {
    running = false;
  }
}
