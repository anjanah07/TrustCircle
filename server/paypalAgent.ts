import { z } from "zod";
import { tx, demo } from "./db";
import { createOrder, prepareOrder, captureOrder } from "./paypal";
import { executePayPalTool } from "./paypalToolkit";
import { requireThat } from "./policy";
export async function runPayPalAgentTool(name: string, args: unknown, memberId: string) {
  let result: any;
  if (name === "create_order") {
    const { kind } = z
      .object({ kind: z.enum(["collateral", "contribution", "topup"]) })
      .strict()
      .parse(args);
    // Stable within a payment purpose/cycle. Repeated agent calls reuse uncompleted intents.
    const order = await tx(async (c) => {
      const member = (await c.query("SELECT * FROM members WHERE id=$1", [memberId]))
        .rows[0];
      requireThat(member && member.status !== "exited", "Member unavailable");
      const pending = (
        await c.query(
          "SELECT * FROM payment_orders WHERE member_id=$1 AND kind=$2 AND status='created' ORDER BY created_at DESC LIMIT 1",
          [memberId, kind],
        )
      ).rows[0];
      return pending || (await createOrder(c, memberId, kind, crypto.randomUUID()));
    });
    const prepared = await prepareOrder(order.id);
    result = {
      id: order.id,
      amount: Number(order.amount),
      currency: order.currency,
      approval_url: prepared.approval_url || null,
      status: "awaiting_buyer_approval",
      simulated: demo,
    };
  } else {
    requireThat(name === "get_order" || name === "pay_order", "Unknown PayPal tool");
    const { id } = z.object({ id: z.uuid() }).strict().parse(args);
    const order = await tx(
      async (c) =>
        (
          await c.query("SELECT * FROM payment_orders WHERE id=$1 AND member_id=$2", [
            id,
            memberId,
          ])
        ).rows[0],
    );
    requireThat(order, "Order does not belong to this member");
    if (name === "pay_order") {
      requireThat(
        !demo,
        "Simulated payments must use the demo payment button; no PayPal approval exists",
      );
      result = await captureOrder(id);
    } else if (demo) result = { id, status: order.status, simulated: true };
    else {
      requireThat(order.paypal_id, "Order not yet created at PayPal");
      const provider = await executePayPalTool("get_order", { id: order.paypal_id });
      result = {
        id,
        status: provider.status,
        amount: Number(order.amount),
        currency: order.currency,
      };
    }
  }
  await tx(async (c) => {
    const m = (await c.query("SELECT circle_id FROM members WHERE id=$1", [memberId]))
      .rows[0];
    await c.query(
      "INSERT INTO agent_actions(circle_id,tool,args,decision,result) VALUES($1,$2,$3,$4,$5)",
      [m.circle_id, name, JSON.stringify(args), "policy_checked", JSON.stringify(result)],
    );
  });
  return result;
}
