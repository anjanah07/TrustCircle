import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { read, tx } from "./db";
import { register, tokenHash } from "./circles";
import type { ApiContext } from "./http";

export const cookieName = "tc_session";
const lifetime = 7 * 24 * 60 * 60;
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  const expected = Buffer.from(hash || "", "hex");
  const actual = await derive(password, salt || "missing-account");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function sessionToken(headers: Record<string, string>) {
  return headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
}
export async function sessionUser(headers: Record<string, string>) {
  const token = sessionToken(headers);
  if (!token) return null;
  return read(
    async (c) =>
      (
        await c.query(
          "SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at > now()",
          [tokenHash(token)],
        )
      ).rows[0] || null,
  );
}
function cookie(value: string, seconds: number) {
  return `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
async function issue(user: { id: string; name: string; username: string }) {
  const token = randomBytes(32).toString("hex");
  await tx(async (c) => {
    await c.query("DELETE FROM auth_sessions WHERE expires_at <= now()");
    await c.query(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [tokenHash(token), user.id, new Date(Date.now() + lifetime * 1000)],
    );
  });
  return Response.json(
    { id: user.id, name: user.name, username: user.username },
    { headers: { "Set-Cookie": cookie(token, lifetime), "Cache-Control": "no-store" } },
  );
}
const credentials = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,32}$/, "Username must be 3–32 letters, numbers or underscores"),
  password: z.string().min(12, "Use at least 12 characters for your password").max(128),
});
async function throttle(key: string) {
  const attempts = await tx(async (c) => {
    await c.query("DELETE FROM auth_attempts WHERE resets_at < now()");
    return (
      await c.query(
        "INSERT INTO auth_attempts(key,resets_at) VALUES($1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts",
        [key],
      )
    ).rows[0].attempts;
  });
  return attempts <= 10;
}
// Limit memory used by concurrent password derivations on small deployment instances.
let pending = 0;
export async function authenticate(context: ApiContext, signup: boolean) {
  if (pending >= 2)
    return Response.json({ error: "Please try again shortly" }, { status: 429 });
  const input = credentials.parse(context.body);
  if (!(await throttle(`login:${input.username}`)))
    return Response.json(
      { error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 },
    );
  if (pending >= 2)
    return Response.json({ error: "Please try again shortly" }, { status: 429 });
  pending++;
  try {
    if (signup) {
      const details = z
        .object({
          name: z.string().trim().min(1).max(80),
          email: z
            .email()
            .max(254)
            .transform((v) => v.toLowerCase()),
          legacyToken: z.string().max(128).optional(),
        })
        .parse(context.body);
      const hash = await hashPassword(input.password);
      const user = await tx(async (c) => {
        const existing = (
          await c.query("SELECT * FROM users WHERE lower(email)=$1 OR username=$2", [
            details.email,
            input.username,
          ])
        ).rows;
        let id: string;
        if (existing.length) {
          const old = existing[0];
          if (
            existing.length !== 1 ||
            old.password_hash ||
            old.email.toLowerCase() !== details.email ||
            !details.legacyToken ||
            tokenHash(details.legacyToken) !== old.token_hash
          )
            return null;
          id = old.id;
        } else {
          id = (await register(c, details.name, details.email)).id;
        }
        return (
          await c.query(
            "UPDATE users SET username=$1,password_hash=$2,token_hash=$3 WHERE id=$4 RETURNING id,name,username",
            [input.username, hash, tokenHash(randomBytes(32).toString("hex")), id],
          )
        ).rows[0];
      });
      if (!user)
        return Response.json(
          {
            error:
              "Account unavailable. Sign in, choose another username, or supply your existing member token to upgrade an old account.",
          },
          { status: 409 },
        );
      return issue(user);
    }
    const user = await read(
      async (c) =>
        (await c.query("SELECT * FROM users WHERE username=$1", [input.username]))
          .rows[0],
    );
    const valid = await verifyPassword(input.password, user?.password_hash || "missing:");
    if (!valid || !user)
      return Response.json({ error: "Invalid username or password" }, { status: 401 });
    return issue(user);
  } finally {
    pending--;
  }
}
export async function logout(context: ApiContext) {
  const token = sessionToken(context.headers);
  if (token)
    await tx((c) =>
      c.query("DELETE FROM auth_sessions WHERE token_hash=$1", [tokenHash(token)]),
    );
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie("", 0) } });
}
