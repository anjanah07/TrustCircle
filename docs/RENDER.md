# Deploy TrustCircle on Render

Use a Node Web Service and Render PostgreSQL. The repository's `render.yaml` creates a Starter web service and a basic-256mb database, both paid resources. Review the plans in Render before creating them. Keep a single app instance for the embedded Treasurer worker. A free service sleeps when idle and cannot maintain payout timing.

## 1. Push the app

Make `trustcircle` itself the repository root, so `package.json` and `render.yaml` are at the root. The existing `.gitignore` excludes `.env`, dependency folders, local demo data and generated builds. Do not upload `.env` or account passwords. The five supplied member emails are saved only in ignored local `.env` as `PAYPAL_SANDBOX_MEMBER_EMAILS`, for onboarding reference; they are not automatically registered.

If using a monorepo instead, set the web service's `rootDir` to the path containing `package.json`, and select the corresponding Blueprint path in Render.

## 2. Create the deployment

In Render Dashboard, choose **New → Blueprint**, connect the repository, and select its `render.yaml`. Review the paid resources and create the Blueprint.

The Blueprint supplies:

- Node 22.22.0, with `npm ci --include=dev && npm run build`.
- `npm start`, using Render's supplied `PORT`.
- A new PostgreSQL database connected through `DATABASE_URL`.
- `PAYMENT_MODE=paypal` and `DEPLOYMENT_SETUP=true`.
- Health endpoint `/api/health`.

Setup mode serves a setup page and health/config endpoints. It blocks registration and all payment endpoints, skips database initialization and never starts the automatic worker. It does not simulate payments. This lets the first deploy succeed before the webhook is ready.

The database has external IP access disabled in the Blueprint. The Render web service uses the internal connection. For local verification of a Render-only database, use the Render service's Shell rather than opening public database access.

## 3. Configure the hosted service

Once Render displays the app's `https://...onrender.com` address, configure the PayPal app's webhook URL as:

```text
https://YOUR-SERVICE.onrender.com/api/webhooks/paypal
```

In **Render → Web Service → Environment**, add:

```dotenv
PAYPAL_CLIENT_ID=your_existing_sandbox_client_id
PAYPAL_SECRET=your_existing_sandbox_secret
PAYPAL_WEBHOOK_ID=the_webhook_id_for_this_destination
TREASURER_PAYPAL_EMAIL=your_business_sandbox_email
OPENAI_API_KEY=your_existing_key
OPENAI_MODEL=your_existing_model
```

The model variables are optional for payment execution. They enable automatic explanations. `PAYPAL_CLIENT_SECRET` is supported instead of `PAYPAL_SECRET`. Configure a persistent Ed25519 `BADGE_PRIVATE_KEY` if badges must verify across restarts.

Leave `APP_URL` unset on Render to use its automatic `RENDER_EXTERNAL_URL`. Set `APP_URL` explicitly only for a different public origin, such as a custom domain. Never copy the local `APP_URL=http://localhost:3000` into Render.

Render environment variables and local `.env` are separate. Editing the local file does not update the deployed app. The Blueprint sets `DATABASE_SCHEMA=trustcircle_paypal`. This creates dedicated PayPal tables, even if the same database contains older simulation tables in `public`. Those older tables stay intact.

See `PAYPAL-SETUP.md` for webhook subscriptions and account requirements. The five personal account emails are used when members register; their PayPal dashboard numeric IDs are not needed by the email-based payout flow.

## 4. Activate payments

From the Render Shell, run `npm run paypal:check`. Resolve authentication, webhook URL/event or database errors. Then change `DEPLOYMENT_SETUP=false` in Render Environment and redeploy. Also update that value in `render.yaml` after setup, so future Blueprint syncs do not restore setup mode.

The app validates configuration, migrates the new database and starts its worker. Register the five members with their own sandbox emails. Test one buyer-approved deposit first, confirm it in PayPal, then proceed to the full circle.

No Render deployment has been created by the coding agent. Account selection, repository connection and resource creation remain to be done in Render.

Sources: [Next.js on Render](https://render.com/docs/deploy-nextjs-app), [Render environment variables](https://render.com/docs/environment-variables), [free service limitations](https://render.com/docs/free).

## Internal database TLS

Set `PGSSL_MODE=render-internal` in the Render web service's Environment and redeploy the updated code. The Blueprint now includes this setting. Render's internal database endpoint uses a self-signed certificate, so this explicitly requires TLS without CA verification only when running on Render with a private `dpg-...` hostname. External URLs are rejected in this mode. It overrides `PGSSL=true` for that private connection only.

Leave this mode unset locally and for external database URLs. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`: that disables verification for unrelated HTTPS connections, including PayPal. Adding `--use-system-ca` does not establish trust in a certificate that is absent from the system trust store.

Reference: [Render PostgreSQL TLS modes](https://render.com/docs/postgresql-creating-connecting).

## Existing simulated-circle startup error

Push the latest code, then set `DATABASE_SCHEMA=trustcircle_paypal` in Render Environment and redeploy. Keep the same internal `DATABASE_URL` and `PGSSL_MODE=render-internal`. Startup creates that schema and its empty tables automatically, without looking up tables in `public`. This is database namespace isolation, not a new database purchase. Existing simulated circles remain in their original schema. Register fresh members in the new PayPal schema. Do not change the schema name after starting actual sandbox transactions.
