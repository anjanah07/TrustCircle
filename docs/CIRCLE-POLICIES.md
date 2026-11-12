# Circle creation, discovery and defaults

Circle creators set the monthly total pot (before discount and retention), 2–10 members, and collateral per member. The monthly contribution is the pot divided by member count. Whole-cent divisibility is required; collateral must cover at least one contribution. These terms are fixed on creation. Existing circles retain their original amounts.

Public circles are visible to signed-in users while forming and below capacity. Their minimum trust score defaults to 50 and may be raised to 100. The server checks the current score, capacity and circle status in the same serialized transaction as membership creation. A public circle creator must also meet their chosen threshold.

Private circles require a secret invite token, except for their creator and existing members. The creator's “Copy circle invite” button copies `/invite/<id>?token=<secret>`. Opening the link retains it through login/signup and displays the group preview; pasting it in the lobby also opens the preview. Joining is an explicit action. Invite tokens are omitted from member snapshots, public listings and other members' circle lists. Treat a private invite as shareable access to that circle.

## Two-default policy

A default is a distinct contribution still unpaid after its grace deadline. Collateral is debited only up to its available balance; any retention coverage is separately recorded. Retrying a scheduler tick never increments the default count twice for the same contribution.

At the second default, eligibility is immediately suspended and the circle pauses. The autonomous Treasurer receives structured facts and its policy prompt, then calls the narrow `bar_member` tool. The tool rechecks the persisted default count, bars the member, preserves balances and writes an audit decision. Model failure or an omitted/invalid tool call uses an explicitly labeled policy fallback. The tool cannot bar anyone after only one default. Top-ups do not undo a bar.

The pause is intentional: removing a member does not remove outstanding financial obligations or magically fund future pots. Settlement and funding reconciliation are required before the circle can resume. This change does not implement an operator workflow to replace members or resume paused circles. Remaining collateral is preserved, not automatically confiscated or refunded. Existing settlement previews/actions remain available.

## Collateral states

A saved deposit proposal is not a PayPal transfer. The member clicks Deposit collateral, then approves PayPal checkout. Only a verified completed capture credits collateral. A funded member may still be pending circle activation until every seat and deposit is ready; the UI explains this separately.

Checkout retries reuse the same saved order and idempotency key. Creation errors are persisted. The retry window starts at the first creation attempt, not at proposal time. An uncertain provider attempt older than the retry window still requires reconciliation; the app does not silently create another charge.

Migration 006 adds circle options, invitation secrets, default counters, bar timestamps and checkout-attempt timestamps. Deploying the app runs it automatically. Existing member default counts are backfilled from already processed defaults. Real PayPal/AI credentials and payment data are not used in the automated tests; the model tool-selection test uses a controlled response.

Implementation references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [PayPal Orders API](https://developer.paypal.com/api/orders/v2).

## Hackathon timer controls

New circles created through the API use 30 seconds to contribute followed by 30 seconds of grace; the payout-request window remains 60 seconds. These are accelerated sandbox demonstration timings, not a monthly production schedule.

For an existing circle, its creator can select **Use 30-second demo timing** in Overview before bidding opens and before defaults are processed. This changes the current collection deadlines and future rounds. An active round starts paused after conversion; select **Resume timer** when ready.

Only the authenticated creator can pause/resume demo timers. The pause is persisted, survives restarts, and blocks automatic defaults, bidding, request-window opening, and settlement. Resume shifts deadlines by the paused duration. Already approved payments can still complete, and already queued payouts are not cancelled. A circle paused for default/reconciliation cannot be resumed with this timer control.
