import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

// Reproduce an existing public schema that would otherwise block sandbox startup.
const embedded = new PGlite("memory://");
(globalThis as any).trustCircleDatabase = {
  embedded,
  pool: null,
  queue: Promise.resolve(),
};
process.env.DATABASE_SCHEMA = "trustcircle_paypal";
const { migrate, tx, closeDB } = await import("../server/db.js");

test("migration preserves simulation tables and creates separate empty PayPal tables", async () => {
  try {
    await embedded.exec(
      "CREATE TABLE public.circles (id int, currency text); INSERT INTO public.circles VALUES(1,'INR'); CREATE TABLE public.migrations(version int PRIMARY KEY); INSERT INTO public.migrations VALUES(1),(2),(3),(4);",
    );
    await migrate();
    const fresh = await tx(async (c) => (await c.query("SELECT * FROM circles")).rows);
    assert.equal(fresh.length, 0);
    const preserved = await embedded.query("SELECT * FROM public.circles");
    assert.deepEqual(preserved.rows, [{ id: 1, currency: "INR" }]);
    const versions = await embedded.query(
      "SELECT version FROM trustcircle_paypal.migrations ORDER BY version",
    );
    assert.deepEqual(versions.rows, [
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    await migrate();
    assert.equal((await embedded.query("SELECT * FROM public.circles")).rows.length, 1);
    assert.equal(
      (await embedded.query("SELECT * FROM trustcircle_paypal.circles")).rows.length,
      0,
    );
  } finally {
    await closeDB();
    delete process.env.DATABASE_SCHEMA;
  }
});
