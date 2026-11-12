# TrustCircle

**A smarter alternative to traditional chit funds—collateral-backed savings with an AI Treasurer and PayPal-powered payments.**

Built for the PayPal hackathon. TrustCircle makes community savings more transparent through verified payments, collateral-backed commitments, and an auditable Treasurer. This is a **sandbox prototype**, not a live-money financial service or a guarantee against loss.

- [Deployed application](https://trustcircle-dci6.onrender.com/)
- [Interactive simulation](https://trustcircle-dci6.onrender.com/demo) — no signup, API credentials, AI calls, or money transfers
- [Public repository](https://github.com/anjanah07/TrustCircle)
- [MIT license](LICENSE) — [OSI-approved](https://opensource.org/license/mit)

## What you can do

Create a public or private circle with a chosen pot, member count, and collateral. Public circles use a minimum trust score; private circles use invitation links. Members register and sign in with username/password, then approve payments using their own PayPal Personal sandbox accounts.

After collateral funding, members contribute to each round. Once the pot is funded, a 60-second request window opens. The highest discount wins; the discount is split equally among the other members. Previous winners cannot claim again in the same circle. Without requests, the next eligible rotation member wins. Retention may secure future obligations beyond collateral.

Missed contributions can be covered from available collateral. Two defaults bar the member and pause the circle for reconciliation. Unfunded shortfalls are never treated as paid. Recipients see confirmed payout notices and a link to PayPal Sandbox; transactions and Treasurer decisions remain inspectable.

New circles created through the application use **30 seconds to contribute plus 30 seconds grace** for hackathon demonstrations. The creator can pause/resume the timer, preserving time remaining. Existing circles explicitly opt in through Overview. Pausing does not cancel approved payments or already queued payouts. See [circle policies](docs/CIRCLE-POLICIES.md).

## PayPal integration — required technology

All provider calls use the **free PayPal sandbox environment** and sandbox funds. The code deliberately has no live-money switch.

| PayPal tool/service                   | Role in TrustCircle                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@paypal/agent-toolkit/openai`        | Official PayPal Agent Toolkit integration, configured with `sandbox: true` and create/get/capture order actions.                          |
| `create_order`                        | Creates approval links for collateral, contributions, and top-ups. Amounts and recipients come from validated application records.        |
| `get_order`                           | Retrieves the provider order status for verification and recovery.                                                                        |
| `pay_order`                           | Captures orders after PayPal buyer approval.                                                                                              |
| Orders API                            | Underlying checkout/capture lifecycle into the Treasurer Business sandbox account.                                                        |
| Payouts API                           | Sends winner payouts, discount shares, retention releases, and refunds to member Personal sandbox accounts. Called directly through REST. |
| Webhooks + signature verification API | Verifies notifications and triggers reconciliation for captures, refunds/reversals, and payouts.                                          |

Relevant code: [toolkit adapter](server/paypalToolkit.ts), [agent tool bindings](server/paypalAgent.ts), [orders and payouts](server/paypal.ts), [webhook handler](server/webhook.ts).

Completed captures are validated against the registered buyer, amount, and currency before crediting the ledger. Payout completion requires recipient-item success, not just a successful batch. Persisted intents and idempotency protect retries. Webhooks and polling recover interrupted checkout flows. Sandbox testing has confirmed buyer captures and recipient payouts, including a USD500 payout; automated tests separately use mocked transport.

### Where funds are held

The Business sandbox account owning the configured API credentials receives deposits and contributions and sends payouts. The AI itself does not own a PayPal account. Each member has a separate Personal sandbox account.

Collateral deductions reallocate funds already held by the Treasurer; they do not debit the Personal account again. TrustCircle's ledger is not the member's PayPal wallet balance. Sandbox funds cannot be withdrawn to a real bank account.

## AI integration — required technology

TrustCircle uses the **OpenAI TypeScript SDK and Responses API**, with **GPT-5 nano (`gpt-5-nano`)** as the project configuration. Set `OPENAI_MODEL` to a Responses-compatible model available to your account.

- **Default review:** the autonomous Treasurer reviews structured default facts and can call the narrow `bar_member` tool after two verified defaults. The backend rechecks eligibility, preserves remaining funds, and pauses the circle. See [default agent](server/defaultAgent.ts).
- **Decision explanations:** the model generates concise explanations from recorded payout decisions, including the winner, discount, retention, and released amount. These are audit summaries, not hidden chain-of-thought. See [automatic explanations](server/autonomous.ts).
- **Tool integration:** the model tool layer exposes policy-scoped PayPal create/get/capture actions and application tools. It never accepts an arbitrary receiver or price from the model. See [Treasurer](server/treasurer.ts) and [PayPal agent](server/paypalAgent.ts).

Winner ranking, ledger arithmetic, ownership checks, and financial eligibility are deterministic. The model cannot bypass buyer approval or override these checks. A labelled policy fallback handles model unavailability. The public `/demo` walkthrough is browser-only simulation and does not call the model or PayPal.

## Additional sponsors and technology

| Technology                    | Usage                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Render**                    | Hosts the persistent Next.js Node web service and managed PostgreSQL database. Supplies the public HTTPS webhook endpoint. `render.yaml` defines the deployment.                |
| **AG Grid Community**         | Interactive transaction, payout, member, and public-circle tables with sorting, filtering, pagination, quick search, and CSV export. See [Grid component](components/Grid.tsx). |
| Next.js 16, React, TypeScript | One application containing the interface and backend API routes.                                                                                                                |
| PostgreSQL / `pg`             | Accounts, memberships, sessions, payment records, ledger, and transaction locking.                                                                                              |
| PGlite                        | Local, isolated simulation and test database.                                                                                                                                   |
| Zod                           | Request validation.                                                                                                                                                             |
| Node crypto                   | Password hashing, session tokens, and ledger integrity checks.                                                                                                                  |

APIMatic, Postman, and Astro are not integrations in this repository.

## Local setup

Requires **Node.js 22.12+** and npm. Use separate credentials/accounts for testing; do not put secrets in source code or `NEXT_PUBLIC_` variables.

```bash
git clone https://github.com/anjanah07/TrustCircle.git
cd TrustCircle
npm ci
cp .env.example .env  # fresh checkout only; never overwrite an existing .env
```

### Fast start: no credentials

```bash
npm run demo
```

Visit `http://localhost:3000/demo` for the public walkthrough. This mode uses simulated money and disables model calls. The main application also supports local signup and simulated circles. Demo persistence uses `.demo-db`, which Git ignores. To use AI with simulated money, configure your own `OPENAI_API_KEY` and `OPENAI_MODEL`, then run `npm run demo:ai` (model usage may be billed).

### Connected PayPal sandbox + AI

1. Create a Business sandbox account for the Treasurer and separate Personal sandbox accounts for participants. Create a sandbox REST app under the Business account, enable Payouts access, and provision test funds for payments and fees. Choose account countries that support the test flow; India-to-India payments may be restricted.
2. Configure a PostgreSQL database and a dedicated schema with no simulation records. Locally use `trustcircle_paypal_local`; on Render use `trustcircle_paypal`. Do not change a schema after funding circles just to hide old records.
3. Set the following **only in your ignored `.env` or Render Environment**:

```dotenv
PAYMENT_MODE=paypal
DATABASE_URL=postgresql://USERNAME:PASSWORD@HOST:5432/DATABASE
DATABASE_SCHEMA=trustcircle_paypal_local
APP_URL=https://YOUR-PUBLIC-HTTPS-ORIGIN
PAYPAL_CLIENT_ID=YOUR-SANDBOX-APP-CLIENT-ID
PAYPAL_CLIENT_SECRET=YOUR-SANDBOX-APP-SECRET
PAYPAL_WEBHOOK_ID=YOUR-WEBHOOK-SUBSCRIPTION-ID
TREASURER_PAYPAL_EMAIL=YOUR-BUSINESS-SANDBOX-EMAIL
OPENAI_API_KEY=YOUR-OPENAI-API-KEY
OPENAI_MODEL=gpt-5-nano
DEPLOYMENT_SETUP=false
```

4. Use a public HTTPS deployment or tunnel for callbacks. Register **one** webhook at `https://YOUR-PUBLIC-HTTPS-ORIGIN/api/webhooks/paypal`; use its subscription ID, not an event ID. Configure the events in [PayPal setup](docs/PAYPAL-SETUP.md).
5. Run:

```bash
npm run paypal:check
npm run dev
```

`paypal:check` is read-only: it checks authentication, webhook configuration, and database state; it does not send payments. Startup runs migrations. Each user registers with their own Personal sandbox email and approves checkout with that matching account. Do not publish account passwords.

Optional local PostgreSQL is defined in `compose.yaml`; run `docker compose up -d` if Docker is installed, and use its local connection settings. TLS settings depend on your database provider; never globally disable certificate checks.

Detailed guides: [PayPal setup](docs/PAYPAL-SETUP.md), [authentication and demo](docs/AUTH-AND-DEMO.md), [circle policies](docs/CIRCLE-POLICIES.md).

## Deploy on Render

1. Connect this repository through **New → Blueprint** and select `render.yaml`.
2. Review the specified paid service/database plans. Use one continuously running Node instance for the embedded scheduler; sleeping instances cannot maintain demo deadlines reliably.
3. Initially leave `DEPLOYMENT_SETUP=true` to deploy before PayPal callbacks are configured.
4. Put credentials in **Render → Environment**. Use the database's **Internal Database URL**, `DATABASE_SCHEMA=trustcircle_paypal`, and the Blueprint's private-connection TLS settings. Render environment settings are separate from local `.env`.
5. Register the `/api/webhooks/paypal` URL. Run `npm run paypal:check` in Render Shell, resolve configuration problems, set `DEPLOYMENT_SETUP=false`, and redeploy. Keep the Blueprint setup flag consistent with the service when syncing it later.

Build: `npm ci --include=dev && npm run build`. Start: `npm start`. Health check: `/api/health`.

See [Render deployment guide](docs/RENDER.md). The worker starts in Next.js instrumentation; no separate frontend/backend deployment is needed. Multi-instance scaling requires further worker coordination.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm start
```

Tests cover ledger conservation, payment ownership, duplicate captures, webhook verification, payout rules, default handling, privacy, and creator-only timer controls. The normal test suite uses isolated databases and mocked PayPal transport, not real sandbox transfers. `test:agent` and `test:autonomous` are opt-in model tests and may incur API usage.

## Repository layout

```text
app/                 Pages and styles
app/api/             Backend route handlers
components/          Dashboard, receipts, forms and AG Grid tables
server/              PayPal, AI, database migrations, ledger and rules
lib/                 Browser-only simulation
scripts/             Read-only configuration checks
test/                Automated tests
instrumentation.ts   Persistent Treasurer worker startup
render.yaml          Render web service and PostgreSQL Blueprint
.env.example         Public configuration template; no real credentials
```

## Secrets and publication

- `.env` and `.env.*` are ignored, except the placeholder-only `.env.example`.
- Local databases, builds, dependencies, private keys, and generated recording output are excluded from Git.
- Store deployed secrets in Render Environment. Never include them in screenshots, videos, issue reports, or browser-exposed variables.
- `.gitignore` does not remove previously committed secrets. If a credential is ever committed, revoke/rotate it and clean history before distributing the repository.
- Report potential credential exposure privately to the repository owner; do not post the secret in an issue.

## Prototype boundaries

This project supports sandbox funds only. It is not regulated escrow and does not guarantee savings or prevent every default. Live-money use would require legal/operational review, security review, reconciliation and dispute procedures, and stronger identity/account recovery. Dependencies require ongoing review. User-facing authentication uses password hashing and server-side sessions; demo identity switching is for synthetic participants only.

## License

TrustCircle source code is released under the **MIT License**. See [LICENSE](LICENSE). Third-party packages retain their respective licenses; PayPal, OpenAI, Render, and AG Grid names/trademarks belong to their respective owners.
