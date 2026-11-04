import { deploymentSetup } from "./paypalConfig";
import { proposeDeposit, confirmDeposit } from "./deposit";
import { z } from "zod";
import { tx, demo } from "./db";
import { createCircle, register, join, snapshot } from "./circles";
import { createOrder, prepareOrder, captureOrder, processPayouts } from "./paypal";
import { tick, closeCycle, message } from "./cycleEngine";
import { settle, computeSettlement } from "./settlement";
import { bid } from "./auction";
import { verify } from "./ledger";
import { badge, badgePublicKey } from "./trust";
import { webhook } from "./webhook";
import { treasurer } from "./treasurer";
import { requireThat } from "./policy";
import type { ApiContext } from "./http";
async function ownMember(user: string, id: string) {
  return tx(async (c) => {
    const m = (
      await c.query("SELECT * FROM members WHERE id=$1 AND user_id=$2", [id, user])
    ).rows[0];
    requireThat(m, "Member access denied");
    return m;
  });
}
async function access(user: string, id: string) {
  return tx(async (c) => {
    const m = (
      await c.query("SELECT * FROM members WHERE circle_id=$1 AND user_id=$2", [id, user])
    ).rows[0];
    requireThat(m, "Circle access denied");
    return m;
  });
}

export async function getHealth(context: ApiContext): Promise<Response> {
  const response = Response.json({
    ok: true,
    mode: demo ? "demo" : "paypal-sandbox",
    setupPending: deploymentSetup(),
  });
  return response;
}
export async function getConfig(context: ApiContext): Promise<Response> {
  const response = Response.json({
    demo,
    setupPending: deploymentSetup(),
    currency: demo ? "INR" : "USD",
    ai: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
    treasury: demo
      ? "Simulated Treasurer balance"
      : process.env.TREASURER_PAYPAL_EMAIL || "Configured PayPal business account",
    publicKey: badgePublicKey,
  });
  return response;
}
export async function postWebhooksPaypal(context: ApiContext): Promise<Response> {
  await webhook(context.headers, context.body);
  const response = new Response(null, { status: 200 });
  await processPayouts();
  return response;
}
export async function postRegister(context: ApiContext): Promise<Response> {
  const b = z
    .object({
      name: z.string().min(1).max(80),
      email: z.email(),
      locale: z.enum(["en", "hi"]).default("en"),
    })
    .parse(context.body);
  const response = Response.json(await tx((c) => register(c, b.name, b.email, b.locale)));
  return response;
}
export async function postDemo(): Promise<Response> {
  requireThat(demo, "Demo disabled");
  const data = await tx(async (connection) => {
    const circle = await createCircle(connection, { name: "The Friday Circle" });
    await connection.query("UPDATE circles SET rules_json=$2 WHERE id=$1", [
      circle.id,
      JSON.stringify({ demo_cycle_seconds: 55, request_window_seconds: 60 }),
    ]);
    const members = [];
    for (const [index, name] of ["Ananya", "Rohan", "Meera", "Arjun", "Sara"].entries()) {
      const user = await register(
        connection,
        name,
        `demo-${circle.id}-${index}@example.com`,
        index === 1 ? "hi" : "en",
      );
      const member = await join(connection, circle.id, user.id);
      members.push({ ...member, name, token: user.token });
    }
    return { circle, members };
  });
  return Response.json(data);
}
export async function getMe(context: ApiContext): Promise<Response> {
  const response = Response.json({
    id: context.user.id,
    name: context.user.name,
    paypal_email: context.user.paypal_email,
    demo,
  });
  return response;
}
export async function getCircles(context: ApiContext): Promise<Response> {
  const response = Response.json(
    await tx(
      async (c) =>
        (
          await c.query(
            "SELECT c.* FROM circles c JOIN members m ON m.circle_id=c.id WHERE m.user_id=$1",
            [context.user.id],
          )
        ).rows,
    ),
  );
  return response;
}
export async function postCircles(context: ApiContext): Promise<Response> {
  const input = z
    .object({
      name: z.string().min(1).max(100),
      contribution: z.number().int().positive().max(100000000),
      n_members: z.number().int().min(2).max(10),
      mode: z.enum(["rotation", "auction"]),
      request_window_seconds: z.number().int().min(15).max(3600).default(60),
    })
    .parse(context.body);
  const response = Response.json(
    await tx(async (c) => {
      const circle = await createCircle(c, input);
      await join(c, circle.id, context.user.id);
      return circle;
    }),
  );
  return response;
}
export async function postCirclesIdJoin(context: ApiContext): Promise<Response> {
  const response = Response.json(
    await tx((c) => join(c, context.params.id, context.user.id)),
  );
  return response;
}
export async function getCirclesId(context: ApiContext): Promise<Response> {
  const m = await access(context.user.id, context.params.id);
  const state = await tx((c) => snapshot(c, context.params.id));
  for (const p of state.payouts) delete p.receiver;
  const response = Response.json({
    ...state,
    ownOrders: await tx(
      async (c) =>
        (
          await c.query(
            "SELECT id,kind,amount,currency,paypal_id,capture_id,status,provider_status,last_error,approval_url FROM payment_orders WHERE member_id=$1",
            [m.id],
          )
        ).rows,
    ),
  });
  return response;
}
export async function postMembersIdOrders(context: ApiContext): Promise<Response> {
  await ownMember(context.user.id, context.params.id);
  const b = z
    .object({
      kind: z.enum(["collateral", "contribution", "topup"]),
      key: z.string().min(8).max(100),
    })
    .parse(context.body);
  const o = await tx((c) => createOrder(c, context.params.id, b.kind, b.key));
  const response = Response.json(await prepareOrder(o.id));
  return response;
}
export async function postOrdersIdCapture(context: ApiContext): Promise<Response> {
  const m = await tx(
    async (c) =>
      (
        await c.query(
          "SELECT m.* FROM payment_orders p JOIN members m ON m.id=p.member_id WHERE p.id=$1 AND m.user_id=$2",
          [context.params.id, context.user.id],
        )
      ).rows[0],
  );
  requireThat(m, "Order access denied");
  const response = Response.json(await captureOrder(context.params.id));
  return response;
}
export async function postMembersIdBid(context: ApiContext): Promise<Response> {
  const m = await ownMember(context.user.id, context.params.id);
  const response = Response.json(
    await tx((c) =>
      bid(c, m.id, z.number().int().nonnegative().parse(context.body.discount)),
    ),
  );
  return response;
}
export async function getMembersIdSettlement(context: ApiContext): Promise<Response> {
  await ownMember(context.user.id, context.params.id);
  const { member: _, ...data } = await tx((c) => computeSettlement(c, context.params.id));
  const response = Response.json(data);
  return response;
}
export async function postMembersIdExit(context: ApiContext): Promise<Response> {
  const m = await ownMember(context.user.id, context.params.id);
  const response = Response.json(await tx((c) => settle(c, m.id)));
  await processPayouts();
  return response;
}
export async function getMembersIdBadge(context: ApiContext): Promise<Response> {
  await ownMember(context.user.id, context.params.id);
  const response = Response.json(badge(context.user));
  return response;
}
export async function postMembersIdChat(context: ApiContext): Promise<Response> {
  const m = await ownMember(context.user.id, context.params.id);
  const text = z.string().min(1).max(2000).parse(context.body.text);
  const response = Response.json(await treasurer(m.id, text));
  return response;
}
export async function postMembersIdDisputes(context: ApiContext): Promise<Response> {
  const m = await ownMember(context.user.id, context.params.id);
  const b = z
    .object({
      seq: z.coerce.number().int().positive(),
      reason: z.string().min(3).max(1000),
    })
    .parse(context.body);
  const response = Response.json(
    await tx(async (c) => {
      const e = (
        await c.query("SELECT * FROM ledger WHERE seq=$1 AND member_id=$2", [b.seq, m.id])
      ).rows[0];
      requireThat(e, "Entry does not belong to member");
      return (
        await c.query(
          "INSERT INTO disputes(ledger_seq,member_id,reason) VALUES($1,$2,$3) RETURNING *",
          [b.seq, m.id, b.reason],
        )
      ).rows[0];
    }),
  );
  return response;
}
export async function postCirclesIdMessages(context: ApiContext): Promise<Response> {
  const m = await access(context.user.id, context.params.id);
  await tx((c) =>
    message(
      c,
      m.circle_id,
      m.id,
      "chat",
      z.string().min(1).max(1000).parse(context.body.text),
      crypto.randomUUID(),
    ),
  );
  const response = Response.json({ ok: true });
  return response;
}
export async function postCirclesIdClose(context: ApiContext): Promise<Response> {
  await access(context.user.id, context.params.id);
  const response = Response.json(await tx((c) => closeCycle(c, context.params.id)));
  await processPayouts();
  return response;
}
export async function postCirclesIdAdvance(context: ApiContext): Promise<Response> {
  requireThat(demo, "Time controls are demo-only");
  await access(context.user.id, context.params.id);
  await tx(async (c) => {
    const cy = (
      await c.query(
        "SELECT cy.* FROM cycles cy JOIN circles ci ON ci.id=cy.circle_id WHERE ci.id=$1 AND cy.n=ci.current_cycle",
        [context.params.id],
      )
    ).rows[0];
    requireThat(cy, "No active cycle");
    await c.query("UPDATE circles SET clock_at=$2 WHERE id=$1", [
      context.params.id,
      new Date(+new Date(cy.grace_end_at) + 1000),
    ]);
    await tick(c, context.params.id);
  });
  const response = Response.json({ ok: true });
  return response;
}
export async function getCirclesIdVerify(context: ApiContext): Promise<Response> {
  await access(context.user.id, context.params.id);
  const response = Response.json(await tx(verify));
  return response;
}

export async function postDepositProposal(context: ApiContext): Promise<Response> {
  const member = await ownMember(context.user.id, context.params.id);
  return Response.json(await proposeDeposit(member.id));
}

export async function postDepositConfirmation(context: ApiContext): Promise<Response> {
  const member = await ownMember(context.user.id, context.params.id);
  const input = z
    .object({ order_id: z.uuid(), confirmation: z.string().max(20) })
    .strict()
    .parse(context.body);
  return Response.json(
    await confirmDeposit(member.id, input.order_id, input.confirmation),
  );
}
