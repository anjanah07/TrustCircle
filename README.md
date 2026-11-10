# TrustCircle — Next.js 16 + TypeScript

One application serves the dashboard and API from the same origin.

```text
trustcircle/
  app/                Next.js pages, layout and styles
    api/              Backend route handlers
  components/         Dashboard and AG Grid components
  server/             Database, PayPal toolkit, ledger and Treasurer policies
  test/               Engine, provider contract and HTTP integration tests
  instrumentation.ts  Starts the automatic Treasurer worker
  .env                Server credentials (ignored by Git)
  compose.yaml        Optional local PostgreSQL
  render.yaml         One Next.js service plus PostgreSQL
```

## Run locally

Requires Node 22.12+.

```bash
npm ci
# On a fresh checkout only: cp .env.example .env
npm run paypal:check
npm run dev
```

Open http://localhost:3000. Pages and `/api` routes run in the same Next.js process.
Existing credentials are stored in root `.env`. PayPal mode is the default and requires the HTTPS origin, webhook and a separate clean PostgreSQL database described in [PayPal setup](docs/PAYPAL-SETUP.md). Existing simulated data is preserved and cannot be used for PayPal payouts.

`npm run demo` uses simulated payments and disables model calls. `npm run demo:ai`
uses the configured `OPENAI_API_KEY` and `OPENAI_MODEL` for automatic explanations.
`npm run dev` uses PayPal unless `PAYMENT_MODE=demo` is explicitly set. Never put provider credentials
in `NEXT_PUBLIC_` variables.

```bash
npm run typecheck
npm test
npm run build
npm start
```

`npm run format` formats source, styles, configuration and documentation with Prettier;
`npm run format:check` checks formatting. `npm run test:agent` and
`npm run test:autonomous` are opt-in real model tests and incur API usage.
With the demo app running, `node test/http-demo.mjs` checks the automatic two-minute cycle.

## Two-minute automated demo

1. Start a **new** two-minute demo. Existing circles retain their original timings.
2. Click **Fund all deposits**. The fifth verified simulated deposit activates the circle.
3. New one-click demos allow 25 seconds to contribute, then 30 seconds of grace. When the pot is fully funded (including any collateral coverage), a 60-second payout request window opens. If everyone pays early, it opens early.
4. Optionally click **Everyone except Sara pays**.
5. At grace expiry, missed contributions and fees are covered from deposits. After the request window, the highest discount request wins; ties use earliest bid, then rotation slot. Without requests, the next eligible rotation member wins. The engine applies retention and processes simulated payouts. No manual close is necessary. Scheduling polls every second.
6. Switch to Sara: only Sara sees her deduction banner and private transaction list. Switch back to another member to verify isolation. User switching clears old member data and stale responses are ignored.
7. The **Treasurer** tab shows concise policy reasons and optional automatic model explanations. It is an activity feed, not a chatbot. The model cannot override deterministic winner or funding rules. Model latency/failure does not delay settlement.

New simulated rounds take about 115 seconds if members miss payments, or about 60 seconds after early full funding. This intentionally consumes collateral quickly if users keep skipping contributions. An unfunded pot is blocked, not fabricated. Legacy auction circles need an eligible bid; provider payouts can remain pending or fail. Actual PayPal delivery cannot be guaranteed within two minutes.

## Where money is stored

**Simulation:** integer ledger balances in local PGlite/PostgreSQL. No money reaches PayPal and the sample accounts are fictitious.

**PayPal sandbox:** all approved member collateral and contributions are captured into the **Treasurer business sandbox account** owning `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Payouts use that same account’s credentials. The AI does not own an account; the platform operates the Treasury account.

A collateral deduction is an internal reallocation of already-collected Treasury funds, from `collateral:<member>` into `pot:<cycle>` and fees. It is not another debit from the member’s private PayPal account. The actual provider transfer occurs when the funded payout is sent to the winner’s personal account.

Required setup for five real sandbox identities:

1. In PayPal Developer, create one Business sandbox account for the Treasurer and **five separate Personal sandbox accounts**. This app does not provision PayPal accounts or store their passwords.
2. Create the sandbox application under that Business account, enable Payouts, and provide enough sandbox balance for provider fees.
3. Configure root `.env`:

```dotenv
PAYMENT_MODE=paypal
DATABASE_URL=your_postgresql_url
DATABASE_SCHEMA=trustcircle_paypal
PAYPAL_CLIENT_ID=treasurer_business_app_client_id
PAYPAL_CLIENT_SECRET=treasurer_business_app_secret
TREASURER_PAYPAL_EMAIL=treasurer_business_sandbox_email
PAYPAL_WEBHOOK_ID=your_webhook_id
APP_URL=https://your-app.example
OPENAI_API_KEY=your_key
OPENAI_MODEL=your_configured_model
```

`TREASURER_PAYPAL_EMAIL` is a display label; credentials determine actual custody. It must match the business account you configured. 4. Register each member with their own Personal sandbox email. Each gets a private bearer token. Each buyer approves deposits/contributions using their own PayPal login. Before capture, the app checks the approved payer email matches the member’s registered receiver email. 5. Set the verified webhook listener to `https://your-app.example/api/webhooks/paypal`, subscribing to capture completion/refund/reversal and payout events. 6. Contributions use the PayPal toolkit `create_order/get_order/pay_order` flow. Payouts and signature verification use existing PayPal REST integrations. Only confirmed completed captures credit the ledger; only successful provider payout items appear as succeeded. 7. The Transactions tab shows **only the selected member’s** collection orders, capture IDs, outgoing Treasury payout batches/items and ledger. Other members’ PayPal receiver emails are removed from circle snapshots.

The one-click five-member fixture is simulation-only. To accelerate a circle formed by your five real sandbox accounts, set `DEMO_CYCLE_SECONDS=115` before creating the circle. This explicitly shortens its contribution deadline to 85 seconds plus 30 seconds grace; tell every test participant before depositing. Without this setting, PayPal sandbox circles use the regular calendar schedule. New circles additionally wait for their request window to finish before queuing payout; provider delivery may take longer. Do not switch a simulation database into PayPal mode. INR is simulation-only; provider circles use USD.

## Database and deployment

Use PostgreSQL (Render Postgres for deployment). `compose.yaml` supplies local PostgreSQL; set `DATABASE_URL=postgresql://trustcircle:trustcircle@localhost:5432/trustcircle` and run `npm run db:migrate` from the project root. Without `DATABASE_URL`, demo uses persistent `.demo-db`.

Render Blueprint runs one persistent Next.js Node service and PostgreSQL. Set `APP_URL`
to that service's HTTPS origin. The worker starts through Next.js instrumentation and
checks active cycles every second; the dashboard refreshes authorized data every two
seconds. No separate API port, proxy, Socket.IO server or frontend URL is required.

Use one continuously running Node instance for the embedded worker. Serverless functions,
sleeping instances and static exports cannot provide reliable background timing. Scaling
to multiple instances requires coordinating the worker and model jobs. No deployment
has been performed.

## Boundaries

- Sandbox prototype; PayPal business balance is not regulated escrow. Licensed pooled-funds custody, KYC/AML, reconciliation, verified account recovery and independent security review are required before live money.
- Early exits pause a circle for replacement/obligation reconciliation. Retention reduces exposure but does not guarantee funds.
- Policy selection is deterministic and auditable; model output is an explanation, not hidden chain-of-thought and not a money-movement authorization.
- Existing bearer-token auth is a prototype. Do not share member tokens; demo identity switching is available only for synthetic members.
- Toolkit 1.11.0 still introduces 12 audit findings (11 high, 1 moderate); compatible fixes did not resolve them. Review upstream toolkit dependencies before production.
- Automated tests mock PayPal transport; a successful real sandbox end-to-end payment flow has not been verified here.

## Deposit confirmation and payout requests

For new circles, every funded round opens a 60-second window. Request the payout with a zero discount or offer a larger discount to accept less. Previous winners cannot win again during the entire circle. Repeated requests update the same member bid; ties use bid time, then slot. No requests means the next eligible rotation member wins. Each other member receives an equal discount share through the payout queue; any remainder cents follow slot order. Provider confirmation, rather than queue creation, marks a payout successful. Existing circles retain their original rules.

Clicking Deposit collateral creates or reuses the member’s deposit proposal and immediately starts checkout for that amount and Treasurer recipient. Simulation credits the simulated deposit; sandbox uses the PayPal Agent Toolkit to create checkout, and captures only after PayPal buyer approval on return. This does not implement saved-wallet mandates or bypass PayPal approval.

The API accepts `request_window_seconds` (15–3600, default 60) when creating a circle. `POST /api/members/:id/deposit-proposal` creates/reuses the member's deposit intent; `POST /api/members/:id/deposit-confirmation` accepts `{order_id, confirmed: true}`.

## PayPal order recovery

Create/get/capture use the official PayPal Agent Toolkit. Approval webhooks and background reconciliation recover checkout even if the browser never returns. Pending captures are shown as pending and never credited early; completed captures verify the order, buyer, currency and amount before updating the ledger. The Transactions view supports resuming checkout and checking an approved payment. Payouts use the separate PayPal Payouts API and are complete only after the provider reports recipient-item success.

`npm run paypal:check` makes read-only authentication, webhook configuration and database checks. It never creates orders, captures payments or sends payouts. See [PayPal setup](docs/PAYPAL-SETUP.md) for the remaining account setup and end-to-end acceptance steps.

## Render deployment

Follow [the Render deployment steps](docs/RENDER.md). The Blueprint initially sets `DEPLOYMENT_SETUP=true`, so the app can deploy before PayPal callbacks are configured. Registration and payment actions stay disabled until setup is complete. Render supplies the default public app origin automatically.
