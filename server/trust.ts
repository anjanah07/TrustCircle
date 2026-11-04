import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import type { DB } from "./db";
const keys = process.env.BADGE_PRIVATE_KEY
  ? { privateKey: createPrivateKey(process.env.BADGE_PRIVATE_KEY.replace(/\\n/g, "\n")) }
  : generateKeyPairSync("ed25519");
export const badgePublicKey = createPublicKey(keys.privateKey).export({
  type: "spki",
  format: "pem",
});
export async function trust(
  c: DB,
  user: string,
  kind: string,
  delta: number,
  ref: string,
) {
  const inserted = await c.query(
    "INSERT INTO trust_events(user_id,kind,delta,ref) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
    [user, kind, delta, ref],
  );
  if (inserted.rows.length)
    await c.query(
      "UPDATE users SET trust_score=LEAST(100,GREATEST(0,trust_score+$2)) WHERE id=$1",
      [user, delta],
    );
}
export function badge(user: any) {
  const payload = JSON.stringify({
    version: 1,
    issuer: "TrustCircle sandbox",
    subject: user.id,
    score: user.trust_score,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    disclaimer: "Demo reputation; not a regulated credit score",
  });
  return {
    payload,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64"),
    algorithm: "Ed25519",
    public_key: badgePublicKey,
  };
}
