import { tx, demo } from "./db";
import { createOrder, prepareOrder, captureOrder } from "./paypal";
import { balance } from "./ledger";
import { requireThat } from "./policy";

// A confirmation always refers to one persisted amount and recipient, never a
// free-form instruction allowing the model to choose an account or price.
export async function proposeDeposit(memberId: string) {
  return tx(async (connection) => {
    const pending = (
      await connection.query(
        "SELECT * FROM payment_orders WHERE member_id=$1 AND kind='collateral' AND status='created' ORDER BY created_at DESC LIMIT 1",
        [memberId],
      )
    ).rows[0];
    const order =
      pending ||
      (await createOrder(connection, memberId, "collateral", crypto.randomUUID()));
    return {
      id: order.id,
      member_id: order.member_id,
      amount: Number(order.amount),
      currency: order.currency,
      recipient: "Circle Treasurer",
      simulated: demo,
    };
  });
}

export async function confirmDeposit(
  memberId: string,
  orderId: string,
  confirmed: boolean,
) {
  requireThat(confirmed === true, "Confirm this deposit to continue");
  const order = await tx(async (connection) => {
    const order = (
      await connection.query(
        "SELECT * FROM payment_orders WHERE id=$1 AND member_id=$2 AND kind='collateral'",
        [orderId, memberId],
      )
    ).rows[0];
    requireThat(order, "Deposit does not belong to this member");
    const member = (
      await connection.query("SELECT * FROM members WHERE id=$1", [memberId])
    ).rows[0];
    requireThat(member && member.status !== "exited", "Member unavailable");
    if (order.status !== "completed") {
      const remaining =
        Number(member.required_collateral) -
        (await balance(connection, `collateral:${memberId}`));
      requireThat(
        remaining === Number(order.amount),
        "Deposit amount changed; refresh the payment proposal",
      );
    }
    await connection.query(
      "INSERT INTO agent_actions(circle_id,tool,args,decision,result) VALUES($1,$2,$3,$4,$5)",
      [
        member.circle_id,
        "confirm_deposit",
        JSON.stringify({ order_id: orderId }),
        "member_confirmed",
        JSON.stringify({
          amount: Number(order.amount),
          currency: order.currency,
          simulated: demo,
        }),
      ],
    );
    return order;
  });
  if (order.status === "completed")
    return { id: order.id, status: "completed", simulated: demo };
  if (demo) {
    await captureOrder(order.id);
    return { id: order.id, status: "completed", simulated: true };
  }
  // prepareOrder calls the PayPal Agent Toolkit. Capture occurs only after the
  // buyer approves PayPal checkout and returns to the existing capture endpoint.
  const prepared = await prepareOrder(order.id);
  return {
    id: order.id,
    status: "awaiting_buyer_approval",
    approval_url: prepared.approval_url,
    simulated: false,
  };
}
