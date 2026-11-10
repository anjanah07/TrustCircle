import { paypalSecret, appOrigin } from "./paypalConfig";
import { demo, tx, type DB } from "./db";
import { executePayPalTool } from "./paypalToolkit";
import { balance, post } from "./ledger";
import { requireThat } from "./policy";
import { activate } from "./circles";
import { trust } from "./trust";
const base = "https://api-m.sandbox.paypal.com"; // Deliberately no live-money switch.
export async function paypal(path: string, body?: any, key?: string): Promise<any> {
  requireThat(
    process.env.PAYPAL_CLIENT_ID && paypalSecret(),
    "Configure PayPal sandbox credentials",
  );
  const auth = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${paypalSecret()}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20000),
  });
  requireThat(auth.ok, "PayPal authentication failed");
  const token: any = await auth.json();
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      ...(key ? { "PayPal-Request-Id": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(`PayPal ${r.status}: ${data.name || "request failed"}`);
  return data;
}
export async function createOrder(
  c: DB,
  memberId: string,
  kind: string,
  requestKey: string,
) {
  requireThat(
    ["collateral", "contribution", "topup"].includes(kind),
    "Invalid payment kind",
  );
  const m = (
    await c.query(
      "SELECT m.*,c.contribution,c.current_cycle,c.currency,c.status AS circle_status FROM members m JOIN circles c ON c.id=m.circle_id WHERE m.id=$1",
      [memberId],
    )
  ).rows[0];
  requireThat(m && m.status !== "exited", "Invalid member");
  requireThat(
    !m.barred_at && m.default_count < 2,
    "Payments are disabled after two defaults; request settlement",
  );
  requireThat(m.circle_status !== "paused", "Circle is paused for reconciliation");
  let cycle: any = null;
  let amount = Number(m.required_collateral);
  if (kind === "contribution") {
    cycle = (
      await c.query(
        "SELECT * FROM cycles WHERE circle_id=$1 AND n=$2 AND status<>'closed'",
        [m.circle_id, m.current_cycle],
      )
    ).rows[0];
    requireThat(cycle, "No open cycle");
    const due = (
      await c.query("SELECT * FROM contributions WHERE cycle_id=$1 AND member_id=$2", [
        cycle.id,
        m.id,
      ])
    ).rows[0];
    requireThat(due?.status === "pending", "Contribution already settled");
    amount = Number(m.contribution);
  } else {
    amount = Math.max(
      0,
      Number(m.required_collateral) - (await balance(c, `collateral:${m.id}`)),
    );
    requireThat(amount > 0, "Collateral already funded");
  }
  let order = (
    await c.query(
      "SELECT * FROM payment_orders WHERE request_key=$1 OR (member_id=$2 AND cycle_id=$3 AND kind='contribution')",
      [requestKey, m.id, cycle?.id ?? null],
    )
  ).rows[0];
  if (!order && kind !== "contribution") {
    order = (
      await c.query(
        "SELECT * FROM payment_orders WHERE member_id=$1 AND kind=$2 AND status='created' ORDER BY created_at DESC LIMIT 1",
        [m.id, kind],
      )
    ).rows[0];
  }
  if (order)
    requireThat(
      order.member_id === m.id && order.kind === kind,
      "Idempotency key belongs to another payment",
    );
  else
    order = (
      await c.query(
        "INSERT INTO payment_orders(member_id,cycle_id,kind,amount,currency,request_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [m.id, cycle?.id ?? null, kind, amount, m.currency, requestKey],
      )
    ).rows[0];
  return order;
}
// Called after committing the intent, so network retries use the same persisted UUID.
export async function prepareOrder(id: string) {
  try {
    return await prepareOrderIntent(id);
  } catch (error) {
    await tx((c) =>
      c.query(
        "UPDATE payment_orders SET last_error=$2,last_checked_at=now() WHERE id=$1",
        [id, error instanceof Error ? error.message : "PayPal checkout creation failed"],
      ),
    );
    throw error;
  }
}
async function prepareOrderIntent(id: string) {
  const order = await tx(
    async (c) =>
      (await c.query("SELECT * FROM payment_orders WHERE id=$1", [id])).rows[0],
  );
  requireThat(order, "Order not found");
  const member = await tx(
    async (c) =>
      (
        await c.query(
          "SELECT m.*,ci.status AS circle_status FROM members m JOIN circles ci ON ci.id=m.circle_id WHERE m.id=$1",
          [order.member_id],
        )
      ).rows[0],
  );
  requireThat(
    member &&
      !member.barred_at &&
      member.default_count < 2 &&
      member.status !== "exited" &&
      member.circle_status !== "paused",
    "Payment creation unavailable for this member",
  );
  if (demo) return { id, mode: "demo" };
  if (order.paypal_id) return order;
  // A proposal is not a provider attempt. Start the retry clock at first checkout creation.
  const started = await tx(
    async (c) =>
      (
        await c.query(
          "UPDATE payment_orders SET creation_started_at=COALESCE(creation_started_at,now()) WHERE id=$1 RETURNING creation_started_at",
          [id],
        )
      ).rows[0].creation_started_at,
  );
  requireThat(
    Date.now() - +new Date(started) < 3 * 3600000,
    "Order creation retry window expired; reconcile provider records before creating another intent",
  );
  requireThat(order.currency === "USD", "PayPal toolkit orders require USD");
  const amount = Number(order.amount) / 100;
  const data = await executePayPalTool(
    "create_order",
    {
      currencyCode: order.currency,
      items: [
        {
          name: `TrustCircle ${order.kind}`,
          quantity: 1,
          itemCost: amount,
          itemTotal: amount,
          taxPercent: 0,
        },
      ],
      returnUrl: `${appOrigin()}/?order=${id}`,
      cancelUrl: `${appOrigin()}/?cancelled=${id}`,
    },
    id,
  );
  return tx(
    async (c) =>
      (
        await c.query(
          "UPDATE payment_orders SET paypal_id=$2,approval_url=$3,provider_status='CREATED',last_error=NULL WHERE id=$1 RETURNING *",
          [
            id,
            data.id,
            data.links?.find((l: any) => ["payer-action", "approve"].includes(l.rel))
              ?.href,
          ],
        )
      ).rows[0],
  );
}
export async function applyCapture(c: DB, order: any, capture: any) {
  order = (await c.query("SELECT * FROM payment_orders WHERE id=$1", [order.id])).rows[0];
  if (order.status === "completed") return;
  requireThat(capture.status === "COMPLETED", "Capture is not completed");
  requireThat(
    capture.amount?.currency_code === order.currency &&
      Math.round(Number(capture.amount?.value) * 100) === Number(order.amount),
    "Capture amount/currency mismatch",
  );
  const m = (await c.query("SELECT * FROM members WHERE id=$1", [order.member_id]))
    .rows[0];
  requireThat(m.status !== "exited", "Exited member capture requires reconciliation");
  let account = `collateral:${m.id}`;
  if (order.kind === "contribution") {
    const due = (
      await c.query("SELECT * FROM contributions WHERE cycle_id=$1 AND member_id=$2", [
        order.cycle_id,
        m.id,
      ])
    ).rows[0];
    // A capture arriving after automatic coverage is member credit, never a second pot payment.
    if (due.status === "pending" && Number(due.funded) === 0) {
      account = `pot:${order.cycle_id}`;
      await c.query(
        "UPDATE contributions SET status='paid',funded=amount,paid_at=now(),paypal_order_id=$3 WHERE cycle_id=$1 AND member_id=$2",
        [order.cycle_id, m.id, order.paypal_id],
      );
      const cycle = (
        await c.query("SELECT due_at FROM cycles WHERE id=$1", [order.cycle_id])
      ).rows[0];
      await trust(
        c,
        m.user_id,
        new Date() <= new Date(cycle.due_at) ? "on_time" : "late",
        new Date() <= new Date(cycle.due_at) ? 3 : -3,
        order.cycle_id,
      );
    }
  }
  await post(
    c,
    m.circle_id,
    m.id,
    "external",
    account,
    Number(order.amount),
    order.kind,
    `capture:${capture.id}`,
    "Verified capture",
  );
  await c.query(
    "UPDATE payment_orders SET status='completed',capture_id=$2,provider_status='COMPLETED',last_error=NULL,last_checked_at=now() WHERE id=$1",
    [order.id, capture.id],
  );
  if ((await balance(c, `collateral:${m.id}`)) >= Number(m.required_collateral))
    await c.query(
      "UPDATE members SET status=CASE WHEN status='suspended' THEN 'active' ELSE status END,topup_deadline=NULL WHERE id=$1 AND barred_at IS NULL AND default_count<2",
      [m.id],
    );
  await activate(c, m.circle_id);
}
export async function captureOrder(id: string) {
  const order = await tx(
    async (c) =>
      (await c.query("SELECT * FROM payment_orders WHERE id=$1", [id])).rows[0],
  );
  requireThat(order, "Unknown order");
  if (order.status === "completed") return order;
  let capture: any;
  if (demo)
    capture = {
      id: `demo-${id}`,
      status: "COMPLETED",
      amount: {
        currency_code: order.currency,
        value: (Number(order.amount) / 100).toFixed(2),
      },
    };
  else {
    requireThat(
      order.paypal_id && order.currency === "USD",
      "No PayPal USD order is available for capture",
    );
    let data = await executePayPalTool("get_order", { id: order.paypal_id });
    await recordOrderStatus(id, data.status);
    requireThat(data.id === order.paypal_id, "PayPal order identity mismatch");
    const owner = await tx(
      async (c) =>
        (
          await c.query(
            "SELECT u.paypal_email FROM members m JOIN users u ON u.id=m.user_id WHERE m.id=$1",
            [order.member_id],
          )
        ).rows[0],
    );
    requireThat(
      !["APPROVED", "COMPLETED"].includes(data.status) ||
        String(
          data.payer?.email_address || data.payment_source?.paypal?.email_address || "",
        ).toLowerCase() === String(owner.paypal_email).toLowerCase(),
      "Approve using this member’s registered PayPal sandbox account",
    );

    const units = data.purchase_units;
    requireThat(
      units?.length === 1 &&
        units[0].amount?.currency_code === order.currency &&
        Math.round(Number(units[0].amount?.value) * 100) === Number(order.amount),
      "PayPal order amount/currency mismatch",
    );
    if (data.status !== "COMPLETED" && !units[0].payments?.captures?.length) {
      if (["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"].includes(data.status)) {
        return { id, status: "awaiting_buyer_approval" };
      }
      requireThat(
        data.status === "APPROVED",
        "Buyer must approve this order in PayPal before capture",
      );
      data = await executePayPalTool("pay_order", { id: order.paypal_id }, order.id);
    }
    capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    requireThat(capture, "PayPal has not returned a capture; retry status check");
    await recordOrderStatus(id, capture.status);
    if (capture.status === "PENDING") return { id, status: "pending" };
    requireThat(
      capture.status === "COMPLETED",
      `PayPal capture ${capture.status}; funds were not credited`,
    );
  }
  await tx((c) => applyCapture(c, order, capture));
  return { id, status: "completed" };
}
export async function enqueuePayout(
  c: DB,
  m: any,
  amount: number,
  purpose: string,
  key: string,
  source: string,
) {
  if (!amount) return;
  if (
    (await c.query("SELECT id FROM payouts WHERE idempotency_key=$1", [key])).rows.length
  )
    return;
  const u = (await c.query("SELECT paypal_email FROM users WHERE id=$1", [m.user_id]))
    .rows[0];
  const p = (
    await c.query(
      "INSERT INTO payouts(idempotency_key,member_id,receiver,amount,purpose) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [key, m.id, u.paypal_email, amount, purpose],
    )
  ).rows[0];
  await post(
    c,
    m.circle_id,
    m.id,
    source,
    `payout:${p.id}`,
    amount,
    "payout_reserved",
    `${key}:reserve`,
    purpose,
  );
}
let processing = false;
export async function processPayouts() {
  if (processing) return;
  processing = true;
  try {
    const ps = await tx(
      async (c) =>
        (
          await c.query(
            "SELECT p.*,m.circle_id,c.currency FROM payouts p JOIN members m ON m.id=p.member_id JOIN circles c ON c.id=m.circle_id WHERE p.status IN ('pending','sent') AND p.next_retry_at<=now() ORDER BY p.id",
          )
        ).rows,
    );
    for (const p of ps)
      try {
        let state = "SUCCESS",
          batch = p.batch_id,
          item = p.item_id;
        if (!demo) {
          requireThat(
            p.currency === "USD",
            "Simulation payouts cannot be sent to PayPal",
          );
          if (!batch && Date.now() - +new Date(p.created_at) > 25 * 86400000) {
            await tx(async (c) => {
              await c.query(
                "UPDATE payouts SET status='failed',last_error='Retry window expired: reconcile provider records before resending' WHERE id=$1",
                [p.id],
              );
            });
            continue;
          }
          if (!batch) {
            const r = await paypal(
              "/v1/payments/payouts",
              {
                sender_batch_header: {
                  sender_batch_id: p.id,
                  email_subject: "TrustCircle sandbox payout",
                },
                items: [
                  {
                    recipient_type: "EMAIL",
                    receiver: p.receiver,
                    amount: {
                      value: (Number(p.amount) / 100).toFixed(2),
                      currency: p.currency,
                    },
                    sender_item_id: p.id,
                    note: p.purpose,
                  },
                ],
              },
              p.id,
            );
            batch = r.batch_header.payout_batch_id;
          }
          // Persist batch before polling. Batch SUCCESS alone is not recipient success.
          await tx(async (c) => {
            await c.query("UPDATE payouts SET batch_id=$2,status='sent' WHERE id=$1", [
              p.id,
              batch,
            ]);
          });
          const detail = await paypal(`/v1/payments/payouts/${batch}?page_size=1000`);
          const providerItem = detail.items?.find(
            (i: any) => i.payout_item?.sender_item_id === p.id,
          );
          state = providerItem?.transaction_status || "PENDING";
          item = providerItem?.payout_item_id || item;
        }
        await tx(async (c) => {
          if (state === "SUCCESS") {
            await post(
              c,
              p.circle_id,
              p.member_id,
              `payout:${p.id}`,
              "external",
              Number(p.amount),
              "payout_completed",
              `paid:${p.id}`,
              p.purpose,
            );
            await c.query(
              "UPDATE payouts SET status='succeeded',batch_id=$2,item_id=$3,last_error=NULL WHERE id=$1",
              [p.id, batch, item],
            );
            if (p.purpose === "refund")
              await c.query(
                "UPDATE settlements SET status='succeeded' WHERE member_id=$1",
                [p.member_id],
              );
          } else
            await c.query(
              "UPDATE payouts SET status=$2,batch_id=$3,last_error=$4,next_retry_at=now()+interval '1 minute' WHERE id=$1",
              [
                p.id,
                ["DENIED", "FAILED", "RETURNED", "REFUNDED", "BLOCKED"].includes(state)
                  ? "failed"
                  : "sent",
                batch,
                state,
              ],
            );
        });
      } catch (e) {
        await tx(async (c) => {
          await c.query(
            "UPDATE payouts SET attempts=attempts+1,last_error=$2,next_retry_at=now()+interval '1 minute' WHERE id=$1",
            [p.id, String(e)],
          );
        });
      }
  } finally {
    processing = false;
  }
}

async function recordOrderStatus(id: string, status: string) {
  await tx((c) =>
    c.query(
      "UPDATE payment_orders SET provider_status=$2,last_checked_at=now(),last_error=NULL WHERE id=$1",
      [id, status],
    ),
  );
}

// Recover approval/capture when a buyer closes the tab or the return request fails.
// Every attempt re-reads PayPal and uses the persisted order's idempotency key.
let reconciling = false;
export async function reconcileOrders() {
  if (demo || reconciling) return;
  reconciling = true;
  try {
    const orders = await tx(
      async (c) =>
        (
          await c.query(
            "SELECT id FROM payment_orders WHERE status='created' AND currency='USD' AND paypal_id IS NOT NULL AND COALESCE(provider_status,'') NOT IN ('VOIDED','DECLINED','DENIED','FAILED') AND (last_checked_at IS NULL OR last_checked_at < now()-interval '30 seconds') AND created_at > now()-interval '29 days' ORDER BY last_checked_at NULLS FIRST LIMIT 5",
          )
        ).rows,
    );
    for (const order of orders) {
      try {
        await captureOrder(order.id);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "PayPal reconciliation failed";
        await tx((c) =>
          c.query(
            "UPDATE payment_orders SET last_error=$2,last_checked_at=now() WHERE id=$1",
            [order.id, message],
          ),
        );
      }
    }
  } finally {
    reconciling = false;
  }
}
