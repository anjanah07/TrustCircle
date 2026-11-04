# Validation

- `npm run build`: passed (TypeScript and Vite production bundle).
- `npm test`: 13/13 passed using isolated, in-memory PostgreSQL (PGlite).
- Browser walkthrough: created a five-member circle, funded all collateral, paid and closed cycle 1, skipped Sara in cycle 2, advanced past grace, checked collateral fell to ₹950 and trust to 43, paid the second winner, calculated and completed Sara's ₹895 simulated refund, and verified the 27-entry ledger chain.
- Browser proof: `demo-ledger.png`.
- The default demo uses no PayPal or OpenAI API calls. Real sandbox approval/capture, externally delivered webhook verification, provider payout execution, and LLM responses were not exercised. They require configured credentials and a reachable HTTPS deployment.
- Render Blueprint is prepared but has not been deployed.
- The local preview server was stopped after verification. Run `npm run demo` to open it again.

## Live AI verification — November 1, 2026

Two real Treasurer requests succeeded using the configured API key and model, with synthetic members and an isolated in-memory database. The model invoked `compute_settlement`; the tool returned a 144500-minor-unit refund. Its explanation correctly gave ₹1,500 collateral minus ₹50 exit penalty minus ₹5 platform fee = ₹1,445. The second request verified the added explicit INR currency field. Both dry runs left the ledger unchanged. Build passed after the fix. This validates the settlement tool-calling path, not all agent tools or PayPal execution. No credentials were printed or added to this report.

## Next.js split and autonomous-cycle verification — November 1, 2026

- Frontend moved to `frontend/`: Next.js 16.4.3 App Router and strict TypeScript. Backend is standalone Express/TypeScript, no Vite entry point.
- Browser user switching verified Sara → Ananya, with refreshed headings, private account identity and zero browser console errors.
- Real-time localhost HTTP test created a fresh five-member synthetic circle, deposited collateral, paid four contributions, and waited without advancing the clock. Automatic payout succeeded after **116 seconds**: Ananya ₹2,000, ₹500 retained; Sara's deposit reduced from ₹1,500 to ₹950 through ₹500 contribution coverage plus ₹50 late fee.
- Five distinct simulated PayPal receiver identities and member-scoped collection-order views verified. Other members' receiver email fields were absent from payout responses.
- The test paused its synthetic circle through the normal early-exit settlement after validation, preventing unattended later-cycle deductions.
- Real OpenAI autonomous explanation test passed, with `source: openai`, triggered from a synthetic approved decision without a user chat prompt. No live provider payments were made.
- `test/http-demo.mjs` is opt-in and requires the demo app on localhost:3000. It takes approximately two minutes and creates only synthetic test data.
- Actual PayPal business-account custody and five separately provisioned Personal sandbox accounts still require the user's PayPal setup and provider end-to-end verification. API simulations are not proof of PayPal delivery.

## Combined Next.js application — November 1, 2026

This supersedes the split deployment described above.

- Consolidated pages, components and 22 API operations into one Next.js 16.4.3 app, with route handlers under `app/api` and one root package/configuration.
- `npm run build`, `npm run typecheck`, `npm run format:check` and all 18 engine/toolkit tests passed.
- The production Next.js server ran against an isolated in-memory demo database with external model and payment calls disabled. The instrumentation worker completed the automatic payout in **116 seconds**: Ananya received a simulated ₹2,000, ₹500 was retained, and Sara's collateral fell to ₹950. Five distinct account identities and private order views passed again.
- Browser switching Ananya → Sara → Ananya loaded each member's correct receiver identity without console errors. Screenshot: `combined-nextjs.png`.
- HTTP smoke checks passed for public health, missing/invalid authentication (401), malformed/invalid JSON (400), and the 64 KB request body limit (413).
- Existing root `.env` credentials and persistent `.demo-db` were preserved. Integration tests did not use or change that database.
- No new real PayPal or OpenAI calls were made for this restructuring. The test server was stopped after verification.

## Deposit confirmation and request window — November 3, 2026

- Production build, strict TypeScript and formatting checks passed; all 21 unit/contract tests passed.
- New tests cover waiting for full funding, persistent deadlines, blocking early settlement and late bids, previous-winner rejection, exact discount distribution, automatic rotation fallback, duplicate-settlement prevention and member-scoped deposit confirmation.
- `test/http-requests.mjs` verifies the combined Next.js API using an isolated simulated database and a 15-second test window. It confirms deposits with `okay`, submits competing discounts, and checks automatic winner and dividend payouts.
- Browser verification: typing `okay` and confirming the displayed ₹1,500 amount updated Ananya's simulated deposit to ₹1,500, with no console errors. Screenshot: `deposit-confirmation.png`.
- New circles default to a 60-second request window; existing circles retain their stored rules. The one-click demo uses 25 seconds to contribute plus 30 seconds grace and 60 seconds for requests.
- No provider payments, live model calls, or hosted-database migrations were run for these checks. Sandbox checkout still requires buyer approval; saved-wallet charging is not implemented.

## PayPal-first integration — November 3, 2026

- Default application mode is now PayPal sandbox, with no implicit simulation fallback. Existing `PAYPAL_SECRET` is accepted alongside `PAYPAL_CLIENT_SECRET`.
- Real, read-only sandbox OAuth succeeded. The webhook ID belongs to the configured app and all required event subscriptions were present. PostgreSQL connectivity succeeded.
- Configuration blockers: no public HTTPS `APP_URL`, webhook destination mismatch, existing simulated circles in the configured database, and missing Treasurer email display label. Payouts entitlement and five Personal sandbox identities still need confirmation.
- Added approval-webhook capture, background reconciliation, pending-capture states, payer and amount verification before capture, completed-webhook revalidation, and checkout cancellation/resume/check UI.
- Production build, TypeScript, formatting and all 22 tests passed. The new provider-branch test covers approval webhook recovery, pending captures without duplicate capture, wrong buyer/amount rejection, invalid webhook signature rejection and idempotent completion. Provider transport is controlled in these tests; they are not proof of a completed PayPal transfer.
- No orders, captures or payouts were created on PayPal during this verification. No hosted-database migration was run. See `PAYPAL-SETUP.md` for the remaining setup and acceptance sequence.
