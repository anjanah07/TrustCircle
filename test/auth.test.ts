import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

// Production authorization, with an isolated in-memory database and no worker/network.
process.env.PAYMENT_MODE = "paypal";
process.env.DATABASE_URL = "postgres://unused";
process.env.APP_URL = "https://circle.test";
(globalThis as any).trustCircleDatabase = {
  embedded: new PGlite("memory://"),
  pool: null,
  queue: Promise.resolve(),
};
(globalThis as any).trustCircleRuntime = { ready: Promise.resolve(), running: false };
const { migrate, tx, closeDB } = await import("../server/db.js");
const { authenticate, logout, sessionUser } = await import("../server/auth.js");
const { handle } = await import("../server/http.js");
const { register } = await import("../server/circles.js");
const context = (body: any = {}, cookie = "") => ({
  body,
  headers: { cookie },
  params: {},
  user: null,
});

test("password login, session expiry/revocation, legacy upgrade and production access boundaries", async () => {
  await migrate();
  try {
    const credentials = {
      username: "test_member",
      password: "long-private-password",
      name: "Test Member",
      email: "test@example.com",
    };
    const created = await authenticate(context(credentials), true);
    assert.equal(created.status, 200);
    const cookie = created.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal((await sessionUser({ cookie }))?.username, credentials.username);
    const stored = await tx(
      async (c) =>
        (
          await c.query("SELECT password_hash FROM users WHERE username=$1", [
            credentials.username,
          ])
        ).rows[0],
    );
    assert.ok(stored.password_hash);
    assert.ok(!stored.password_hash.includes(credentials.password));
    assert.equal(
      (
        await authenticate(
          context({ ...credentials, password: "wrong-long-password" }),
          false,
        )
      ).status,
      401,
    );
    const login = await authenticate(context(credentials), false);
    assert.equal(login.status, 200);
    await logout(context({}, cookie));
    assert.equal(await sessionUser({ cookie }), null);
    const secondCookie = login.headers.get("set-cookie")!;
    await tx((c) =>
      c.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second'"),
    );
    assert.equal(await sessionUser({ cookie: secondCookie }), null);

    const legacy = await tx((c) => register(c, "Old member", "old@example.com"));
    const protectedRoute = handle(async () => Response.json({ secret: true }), {
      public: false,
    });
    const route = { params: Promise.resolve({}) };
    assert.equal(
      (
        await protectedRoute(
          new Request("https://circle.test/api/me", {
            headers: { Authorization: `Bearer ${legacy.token}` },
          }),
          route,
        )
      ).status,
      401,
    );
    const signup = handle((c) => authenticate(c, true), { public: true });
    assert.equal(
      (
        await signup(
          new Request("https://circle.test/api/auth/signup", {
            method: "POST",
            headers: { Origin: "https://evil.test" },
          }),
          route,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await signup(
          new Request("https://circle.test/api/auth/signup", { method: "POST" }),
          route,
        )
      ).status,
      403,
    );
    const oldCredentials = {
      ...credentials,
      username: "old_member",
      email: "old@example.com",
    };
    assert.equal((await authenticate(context(oldCredentials), true)).status, 409);
    const upgraded = await authenticate(
      context({ ...oldCredentials, legacyToken: legacy.token }),
      true,
    );
    assert.equal(upgraded.status, 200);
    assert.equal((await upgraded.json()).id, legacy.id);
    const authenticated = await protectedRoute(
      new Request("https://circle.test/api/me", {
        headers: { Cookie: upgraded.headers.get("set-cookie")! },
      }),
      route,
    );
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get("cache-control"), "no-store");
    for (let i = 0; i < 10; i++)
      await authenticate(
        context({ username: "missing_user", password: "wrong-long-password" }),
        false,
      );
    assert.equal(
      (
        await authenticate(
          context({ username: "missing_user", password: "wrong-long-password" }),
          false,
        )
      ).status,
      429,
    );
  } finally {
    await closeDB();
  }
});
