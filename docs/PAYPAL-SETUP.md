# PayPal sandbox integration

This app uses real PayPal sandbox API requests and sandbox account balances. Sandbox funds are test funds, not live bank money. Live-money endpoints are intentionally not enabled.

## Verified configuration

On November 3, 2026, a read-only call authenticated successfully with the configured client ID and the existing `PAYPAL_SECRET`. The configured webhook belongs to the same app and has the required subscriptions. The configured PostgreSQL connection works.

Remaining blockers found by `npm run paypal:check`:

- `APP_URL` is not a public HTTPS origin and does not match the webhook destination.
- The database contains simulated INR circles. Use `DATABASE_SCHEMA=trustcircle_paypal` to isolate USD sandbox records within the same database, or use a fresh database. Do not erase the old records or change their currency labels.
- The Treasurer email display label is not set. Account identity is determined by the credentials, not this label.
- Payouts access, sufficient sandbox balance and all five buyer accounts have not yet been verified.

## What to configure

Keep credentials in root `.env`, never in chat or `NEXT_PUBLIC_` variables.

```dotenv
PAYMENT_MODE=paypal
DATABASE_URL=your_postgresql_database_connection
DATABASE_SCHEMA=trustcircle_paypal
PGSSL=true
APP_URL=https://your-public-app-origin.example
PAYPAL_CLIENT_ID=existing_business_sandbox_app_id
PAYPAL_SECRET=existing_business_sandbox_app_secret
PAYPAL_WEBHOOK_ID=existing_webhook_id
TREASURER_PAYPAL_EMAIL=business-sandbox-account@example.com
```

`PAYPAL_CLIENT_SECRET` is also supported and takes precedence over `PAYPAL_SECRET`. You do not need to rename an existing valid secret. Use `PGSSL=true` for the configured hosted database, with certificate verification. Local PostgreSQL may use different TLS settings.

`APP_URL` must be the public origin only, with no path or query. Set that app's webhook URL in PayPal Developer to:

```text
https://your-public-app-origin.example/api/webhooks/paypal
```

Subscribe to `CHECKOUT.ORDER.APPROVED`, capture completion/pending/decline/refund/reversal events, and payout batch/item events. The preflight command lists any missing required event names. Changing webhook registrations can produce a new webhook ID; update `.env` accordingly.

## Accounts needed

- One Business sandbox account owning the REST app credentials: this is the Treasurer that receives captures and funds payouts.
- Enable PayPal Payouts for that app/account and provide sufficient sandbox balance, including provider fees. Order collections and payouts are separate PayPal products; working checkout does not prove Payouts access.
- Five distinct Personal sandbox accounts, each with a sandbox balance and its own email/login. Register members using those exact emails. The app never stores their PayPal passwords. Each member approves checkout under their own account.
- Run one persistent Node server for the automatic worker. The public HTTPS URL must stay reachable for callbacks and webhooks.

## Start and verify

```bash
npm run paypal:check
npm run build
npm start
```

The checker makes no payment mutations. Startup applies schema migrations only after required configuration is present, then rejects any selected schema containing simulation circles. The synthetic fixture and simulated capture branches are disabled in PayPal mode.

1. Register all five actual sandbox members and join one new USD circle.
2. Each member confirms the displayed deposit with `okay`, approves PayPal checkout, and verifies a completed capture in Transactions and the Treasurer's sandbox account.
3. Approval webhooks can capture even if the member closes the browser before returning. Background reconciliation retries and checks pending captures. No ledger credit occurs until PayPal confirms completion.
4. After activation, each member contributes through PayPal. On full funding, the 60-second request window opens.
5. Submit requests/discounts. Verify the eligible highest-discount winner and equal discount shares, subject to the existing retention policy.
6. Verify each payout's batch/item IDs and successful recipient status in Transactions and in the receiving Personal sandbox account. A queued payout is not proof of delivery.
7. Check cancellation, a wrong buyer account, repeated return/webhook delivery and a pending capture. None should create duplicate or unverified credit.

The new automated contract tests replace transport, so they verify code paths without moving funds. Successful sandbox OAuth and webhook lookup are real provider checks; neither is a completed payment. End-to-end collection and payout still require the accounts and buyer approvals above.

## Implemented API scope

- Toolkit: Orders v2 creation, retrieval and capture, persisted request IDs and approval links.
- Verified webhooks: approval capture recovery, completed-capture reconciliation, pending/declined state, reversals pausing the circle, and payout polling triggers.
- Autonomous worker: checks uncompleted orders, selects payout recipients under circle rules, submits payout requests and tracks recipient-item results.
- UI: explicit PayPal approval, checkout cancellation notice, resume/check controls, provider status, capture and payout identifiers.

The flow uses immediate-capture orders. Deferred authorization, arbitrary order edits, shipment tracking, saved-wallet mandates and live-money operation are not part of this savings-circle checkout flow. An in-app `okay` does not replace PayPal buyer approval.

References: [Orders checkout flow](https://developer.paypal.com/whats-an-order/), [webhook events](https://developer.paypal.com/api/rest/webhooks/event-names/).
