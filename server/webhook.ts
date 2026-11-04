import { paypal, captureOrder } from "./paypal";
import { tx, demo } from "./db";
import { requireThat } from "./policy";
export async function webhook(headers: any, event: any) {
  requireThat(!demo, "Webhooks are disabled in demo mode");
  requireThat(process.env.PAYPAL_WEBHOOK_ID, "PAYPAL_WEBHOOK_ID is required");
  const check = await paypal("/v1/notifications/verify-webhook-signature", {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  requireThat(check.verification_status === "SUCCESS", "Invalid webhook signature");
  if (
    ["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED"].includes(event.event_type)
  ) {
    const providerId =
      event.event_type === "CHECKOUT.ORDER.APPROVED"
        ? event.resource?.id
        : event.resource?.supplementary_data?.related_ids?.order_id;
    const order = await tx(
      async (c) =>
        (await c.query("SELECT id FROM payment_orders WHERE paypal_id=$1", [providerId]))
          .rows[0],
    );
    requireThat(order, "Unrecognized order; retry after order intent persists");
    // Validate provider order, buyer, amount and completed capture even for webhooks.
    await captureOrder(order.id);
  }
  await tx(async (c) => {
    if (
      (await c.query("SELECT event_id FROM webhook_events WHERE event_id=$1", [event.id]))
        .rows.length
    )
      return;
    if (
      [
        "PAYMENT.CAPTURE.PENDING",
        "PAYMENT.CAPTURE.DECLINED",
        "PAYMENT.CAPTURE.DENIED",
      ].includes(event.event_type)
    ) {
      await c.query(
        "UPDATE payment_orders SET provider_status=$2,last_checked_at=now() WHERE paypal_id=$1 AND status<>'completed'",
        [
          event.resource?.supplementary_data?.related_ids?.order_id,
          event.resource?.status || event.event_type.split(".").at(-1),
        ],
      );
    }
    // Payout events trigger polling; their body never directly authorizes a transfer.
    if (String(event.event_type).startsWith("PAYMENT.PAYOUTS"))
      await c.query("UPDATE payouts SET next_retry_at=now() WHERE status='sent'");
    if (
      ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(event.event_type)
    ) {
      const captureId =
        event.resource?.supplementary_data?.related_ids?.capture_id || event.resource?.id;
      const o = (
        await c.query(
          "SELECT m.circle_id FROM payment_orders p JOIN members m ON m.id=p.member_id WHERE p.capture_id=$1",
          [captureId],
        )
      ).rows[0];
      if (o)
        await c.query("UPDATE circles SET status='paused' WHERE id=$1", [o.circle_id]);
    }
    await c.query("INSERT INTO webhook_events(event_id,type,payload) VALUES($1,$2,$3)", [
      event.id,
      event.event_type,
      JSON.stringify(event),
    ]);
  });
}
