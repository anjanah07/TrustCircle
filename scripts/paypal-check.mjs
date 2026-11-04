import nextEnv from "@next/env";
import pg from "pg";
nextEnv.loadEnvConfig(process.cwd(), true);
const appUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "";
const secret = process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_SECRET;
const result = {
  mode: process.env.PAYMENT_MODE || "paypal",
  credentialsPresent: !!(process.env.PAYPAL_CLIENT_ID && secret),
  publicHttpsOrigin: /^https:\/\//.test(appUrl),
  treasurerLabelPresent: !!process.env.TREASURER_PAYPAL_EMAIL,
  webhookIdPresent: !!process.env.PAYPAL_WEBHOOK_ID,
};
const requiredEvents = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
];
if (result.credentialsPresent) {
  try {
    const response = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000),
    });
    result.sandboxAuthentication = response.ok;
    if (response.ok && result.webhookIdPresent) {
      const token = await response.json();
      const webhook = await fetch(
        `https://api-m.sandbox.paypal.com/v1/notifications/webhooks/${encodeURIComponent(process.env.PAYPAL_WEBHOOK_ID)}`,
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(15000),
        },
      );
      result.webhookBelongsToApp = webhook.ok;
      if (webhook.ok) {
        const data = await webhook.json();
        result.webhookUrlMatches =
          data.url === `${appUrl.replace(/\/$/, "")}/api/webhooks/paypal`;
        const names = data.event_types?.map((event) => event.name) || [];
        result.missingWebhookEvents = names.includes("*")
          ? []
          : requiredEvents.filter((name) => !names.includes(name));
      }
    }
  } catch {
    result.providerCheck = "Could not reach PayPal sandbox";
  }
}
if (process.env.DATABASE_URL) {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    result.databaseConnected = true;
    const tables = await client.query("SELECT to_regclass('public.circles') AS circles");
    result.containsSimulationData = tables.rows[0].circles
      ? (
          await client.query(
            "SELECT EXISTS(SELECT 1 FROM circles WHERE currency<>'USD') AS found",
          )
        ).rows[0].found
      : false;
  } catch {
    result.databaseConnected = false;
  } finally {
    await client.end();
  }
}
console.log(JSON.stringify(result, null, 2));
console.log(
  "Read-only checks only. Payouts access, account balances, buyer approval and end-to-end settlement must still be verified in PayPal sandbox.",
);
if (
  result.mode !== "paypal" ||
  !result.sandboxAuthentication ||
  !result.publicHttpsOrigin ||
  !result.webhookBelongsToApp ||
  !result.webhookUrlMatches ||
  result.missingWebhookEvents?.length ||
  !result.databaseConnected ||
  result.containsSimulationData
)
  process.exitCode = 1;
