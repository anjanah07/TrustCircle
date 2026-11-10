# Accounts and the public walkthrough

The home page provides username/password signup and login. `/demo` is public in all payment modes, including deployment setup mode. It is a browser-only, two-round guided simulation: it never calls the payment APIs, writes database rows, or invokes the model. Refresh or Reset clears it. Demo ties use member order; the real auction retains its existing bidding rules.

## Deployment

Push these changes and redeploy the existing Render service. Migration 005 automatically adds usernames, password hashes, sessions, and login throttling without deleting existing users or circles. No OAuth credentials or new environment secrets are required. Keep the existing production `DATABASE_URL`, `DATABASE_SCHEMA`, and HTTPS `APP_URL` configured. `DEPLOYMENT_SETUP=true` leaves account/payment APIs disabled while the public walkthrough remains available. Set it to false only after the existing PayPal setup is complete.

Create an account for each person with a unique username, a password of at least 12 characters, and their own PayPal sandbox email. Login does not replace PayPal buyer approval. Existing members can expand “Already have an old member account?” at signup and supply their existing token and matching email once to preserve membership. This invalidates that token. Knowing an existing email alone cannot claim that account.

## Access controls

Production protected endpoints require a random, seven-day server session in an HttpOnly, SameSite=Lax cookie (Secure in production). Only a SHA-256 digest of the session is stored. Logout revokes the session. Passwords use salted scrypt (N=32768, r=8, p=3). Password attempts are limited to ten per username per fifteen minutes in the database, and concurrent password hashing is bounded. POSTs require a matching Origin in PayPal mode, except the separately signature-verified PayPal webhook. Existing member ownership checks still apply.

The old `/api/register` endpoint and bearer member-token authentication remain available only in explicit server demo mode for synthetic test fixtures. Production callers must use `/api/auth/signup`, `/api/auth/login`, `/api/auth/session` and `/api/auth/logout`. Responses are not cacheable. The real dashboard lists the signed-in member's circles and supports joining by invite ID.

This implementation provides password authentication, not email verification, password recovery, or Google OAuth. Those require a separate email/OAuth setup. The registered email is not presented as verified. This remains a PayPal sandbox deployment; the public simulation is not evidence of completed PayPal settlement.

## Validation

`pnpm test` includes production-mode auth tests against an isolated in-memory database, and pure public-demo tests for collateral deductions, discount dividends, duplicate settlement prevention, and prior-winner exclusion. No real payments are performed by these tests.
