import { createHash } from "node:crypto";
import type { DB } from "./db";
import { money, requireThat } from "./policy";
export function digest(e: any) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        String(e.seq),
        e.circle_id,
        e.member_id,
        e.debit_account,
        e.credit_account,
        String(e.amount),
        e.kind,
        e.memo,
        e.idempotency_key,
        new Date(e.created_at).toISOString(),
        e.prev_hash,
      ]),
    )
    .digest("hex");
}
export async function balance(c: DB, account: string) {
  const { rows } = await c.query(
    "SELECT COALESCE(SUM(CASE WHEN credit_account=$1 THEN amount ELSE -amount END),0) AS balance FROM ledger WHERE credit_account=$1 OR debit_account=$1",
    [account],
  );
  return Number(rows[0].balance);
}
export async function post(
  c: DB,
  circle: string,
  member: string | null,
  from: string,
  to: string,
  amount: number,
  kind: string,
  key: string,
  memo = "",
) {
  money(amount);
  if (!amount) return;
  requireThat(from !== to, "Accounts must differ");
  const old = (await c.query("SELECT * FROM ledger WHERE idempotency_key=$1", [key]))
    .rows[0];
  if (old) {
    requireThat(
      old.debit_account === from &&
        old.credit_account === to &&
        Number(old.amount) === amount,
      "Idempotency conflict",
    );
    return old;
  }
  if (from !== "external")
    requireThat((await balance(c, from)) >= amount, `Insufficient funds in ${from}`);
  const tail = (await c.query("SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1"))
    .rows[0];
  const seq = (await c.query("SELECT nextval('ledger_seq_seq') AS seq")).rows[0].seq;
  const e = {
    seq,
    circle_id: circle,
    member_id: member,
    debit_account: from,
    credit_account: to,
    amount,
    kind,
    memo,
    idempotency_key: key,
    created_at: new Date().toISOString(),
    prev_hash: tail?.hash || "GENESIS",
  };
  await c.query(
    "INSERT INTO ledger(seq,circle_id,member_id,debit_account,credit_account,amount,kind,memo,idempotency_key,created_at,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      seq,
      circle,
      member,
      from,
      to,
      amount,
      kind,
      memo,
      key,
      e.created_at,
      e.prev_hash,
      digest(e),
    ],
  );
  return e;
}
export async function verify(c: DB) {
  const rows = (await c.query("SELECT * FROM ledger ORDER BY seq")).rows;
  let prev = "GENESIS";
  for (const e of rows) {
    if (e.prev_hash !== prev || digest(e) !== e.hash)
      return { valid: false, broken_at: e.seq, entries: rows.length };
    prev = e.hash;
  }
  return { valid: true, entries: rows.length, head: prev };
}
