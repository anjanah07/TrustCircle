import { paypalConfigurationIssues, deploymentSetup } from "./paypalConfig";
import { demo, migrate, tx } from "./db";
import { scheduler } from "./cycleEngine";
import { processPayouts, reconcileOrders } from "./paypal";
import { explainDecisions } from "./autonomous";

type RuntimeState = {
  ready?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
};
const globalRuntime = globalThis as typeof globalThis & {
  trustCircleRuntime?: RuntimeState;
};
const state = (globalRuntime.trustCircleRuntime ??= { running: false });

export async function ensureRuntime(): Promise<void> {
  if (deploymentSetup()) return;
  if (!state.ready) {
    state.ready = (async () => {
      if (!demo) {
        const issues = paypalConfigurationIssues();
        if (issues.length)
          throw new Error(
            `PayPal setup incomplete: ${issues.join("; ")}. Run npm run paypal:check.`,
          );
      }
      await migrate();
      if (!demo) {
        const legacy = await tx(
          async (c) =>
            (await c.query("SELECT id FROM circles WHERE currency<>'USD' LIMIT 1")).rows
              .length,
        );
        if (legacy)
          throw new Error(
            "The selected database schema contains simulated circles. Set DATABASE_SCHEMA=trustcircle_paypal to use a dedicated empty schema, or use a fresh DATABASE_URL. Existing data has been preserved.",
          );
      }
      // A single timer survives development reloads. Database locks and payout
      // idempotency protect the money operations inside each tick.
      state.timer = setInterval(() => void runScheduledWork(), 1000);
      state.timer.unref();
    })().catch((error) => {
      state.ready = undefined;
      throw error;
    });
  }
  await state.ready;
}

async function runScheduledWork(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    void reconcileOrders().catch(console.error);
    await scheduler();
    await processPayouts();
    void explainDecisions().catch(console.error);
  } catch (error) {
    console.error("Treasurer worker failed", error);
  } finally {
    state.running = false;
  }
}
