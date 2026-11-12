import type { DB } from "./db";
import { requireThat } from "./policy";

export async function controlTimer(
  c: DB,
  circleId: string,
  userId: string,
  action: "enable_demo" | "pause" | "resume",
) {
  const circle = (await c.query("SELECT * FROM circles WHERE id=$1", [circleId])).rows[0];
  requireThat(
    circle && circle.creator_id === userId,
    "Only the circle creator can control the timer",
  );
  requireThat(
    ["forming", "active"].includes(circle.status),
    "Timer controls unavailable for this circle",
  );
  const cycle = (
    await c.query(
      "SELECT * FROM cycles WHERE circle_id=$1 AND n=$2 AND status<>'closed'",
      [circleId, circle.current_cycle],
    )
  ).rows[0];
  const now = new Date();
  if (action === "enable_demo") {
    requireThat(!circle.rules_json?.demo_cycle_seconds, "Demo timing is already enabled");
    requireThat(
      !cycle?.request_opened_at,
      "Cannot change timing during a payout request window",
    );
    if (cycle) {
      requireThat(
        !(
          await c.query(
            "SELECT 1 FROM contributions WHERE cycle_id=$1 AND default_processed=true LIMIT 1",
            [cycle.id],
          )
        ).rows.length,
        "Cannot reset a round after defaults have been processed",
      );
      await c.query(
        "UPDATE cycles SET due_at=$2,grace_end_at=$3,status='open' WHERE id=$1",
        [cycle.id, new Date(+now + 30000), new Date(+now + 60000)],
      );
    }
    // Start an existing active circle paused so the creator can prepare the demo.
    await c.query(
      "UPDATE circles SET rules_json=rules_json || $2::jsonb,timer_paused_at=$3,clock_at=NULL WHERE id=$1",
      [circleId, JSON.stringify({ demo_cycle_seconds: 60 }), cycle ? now : null],
    );
  } else {
    requireThat(
      circle.rules_json?.demo_cycle_seconds && cycle,
      "An active demo-timed round is required",
    );
    if (action === "pause" && !circle.timer_paused_at) {
      const deadline = new Date(cycle.request_closes_at || cycle.grace_end_at);
      requireThat(
        now < deadline,
        "Deadline has passed; wait for the Treasurer to process this round",
      );
      await c.query("UPDATE circles SET timer_paused_at=$2 WHERE id=$1", [circleId, now]);
    } else if (action === "resume" && circle.timer_paused_at) {
      const elapsed = Math.max(0, +now - +new Date(circle.timer_paused_at));
      await c.query(
        `UPDATE cycles SET due_at=due_at + $2 * interval '1 millisecond',
        grace_end_at=grace_end_at + $2 * interval '1 millisecond',
        request_opened_at=request_opened_at + $2 * interval '1 millisecond',
        request_closes_at=request_closes_at + $2 * interval '1 millisecond' WHERE id=$1`,
        [cycle.id, elapsed],
      );
      await c.query(
        "UPDATE members SET topup_deadline=topup_deadline + $2 * interval '1 millisecond' WHERE circle_id=$1 AND topup_deadline IS NOT NULL",
        [circleId, elapsed],
      );
      await c.query("UPDATE circles SET timer_paused_at=NULL WHERE id=$1", [circleId]);
    } else return { ok: true };
  }
  await c.query(
    "INSERT INTO agent_actions(circle_id,tool,args,decision,result) VALUES($1,'timer_control',$2,'creator_requested',$3)",
    [circleId, JSON.stringify({ action }), JSON.stringify({ actor: userId })],
  );
  return { ok: true };
}
