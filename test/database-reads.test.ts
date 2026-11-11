import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PAYMENT_MODE = "demo";
const { read, tx } = await import("../server/db.js");

test("PostgreSQL reads bypass a busy write queue and never take the engine lock", async () => {
  const connections: string[][] = [];
  let releases = 0;
  (globalThis as any).trustCircleDatabase = {
    embedded: null,
    queue: Promise.resolve(),
    pool: {
      connect: async () => {
        const statements: string[] = [];
        connections.push(statements);
        return {
          query: async (sql: string) => {
            statements.push(sql);
            return { rows: [] };
          },
          release: () => releases++,
        };
      },
    },
  };
  let unblock!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const writer = tx(async () => {
    entered();
    await gate;
  });
  await writing;
  try {
    await read(async (c) => {
      await c.query("SELECT 1");
    });
    assert.deepEqual(connections[1], [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT 1",
      "COMMIT",
    ]);
    assert.ok(connections[0].some((sql) => sql.includes("FOR UPDATE")));
    await assert.rejects(
      read(async () => {
        throw new Error("read failed");
      }),
      /read failed/,
    );
    assert.equal(connections[2].at(-1), "ROLLBACK");
  } finally {
    unblock();
    await writer;
  }
  assert.equal(releases, 3);
});
