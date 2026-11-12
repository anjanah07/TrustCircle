import { databaseConfig, databaseSchema } from "./databaseConfig.mjs";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import "dotenv/config";
export interface DB {
  query(sql: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
const paymentMode = process.env.PAYMENT_MODE || "paypal";
if (!["paypal", "demo"].includes(paymentMode))
  throw new Error("PAYMENT_MODE must be paypal or demo");
export const demo = paymentMode === "demo";
if (!demo && process.env.DEPLOYMENT_SETUP !== "true" && !process.env.DATABASE_URL)
  throw new Error("PayPal mode requires DATABASE_URL");
type DatabaseState = {
  embedded: PGlite | null;
  pool: Pool | null;
  queue: Promise<unknown>;
};
const globalDatabase = globalThis as typeof globalThis & {
  trustCircleDatabase?: DatabaseState;
};
function database(): DatabaseState {
  if (!globalDatabase.trustCircleDatabase) {
    const embedded = process.env.DATABASE_URL
      ? null
      : new PGlite(process.env.DEMO_DB_PATH || "./.demo-db");
    const pool = embedded ? null : new Pool(databaseConfig());
    globalDatabase.trustCircleDatabase = { embedded, pool, queue: Promise.resolve() };
  }
  return globalDatabase.trustCircleDatabase;
}
export async function tx<T>(fn: (c: DB) => Promise<T>): Promise<T> {
  const state = database();
  const { embedded, pool } = state;
  // Serialize the embedded connection; Postgres uses a cross-process row lock.
  const run = async () => {
    const c: any = embedded || (await pool!.connect());
    try {
      await c.query("BEGIN");
      await c.query("SELECT id FROM engine_lock WHERE id=1 FOR UPDATE");
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      if (!embedded) c.release();
    }
  };
  const result = state.queue.then(run, run);
  state.queue = result.catch(() => {});
  return result;
}
// Consistent dashboard/auth reads must not wait for the money-engine lock.
// PostgreSQL rejects writes in this transaction. PGlite shares one connection,
// so its reads still use the existing queue to avoid interleaving transactions.
export async function read<T>(fn: (c: DB) => Promise<T>): Promise<T> {
  const state = database();
  const run = async () => {
    const c: any = state.embedded || (await state.pool!.connect());
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      if (!state.embedded) c.release();
    }
  };
  if (!state.embedded) return run();
  const result = state.queue.then(run, run);
  state.queue = result.catch(() => {});
  return result;
}

export async function migrate() {
  const { embedded, pool } = database();
  const c: any = embedded || (await pool!.connect());
  try {
    const schema = databaseSchema();
    if (schema) {
      // databaseSchema validates the identifier before it is interpolated.
      await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await c.query(`SET search_path TO "${schema}"`);
    }
    await c.query("CREATE TABLE IF NOT EXISTS migrations (version int PRIMARY KEY)");
    if (!(await c.query("SELECT * FROM migrations WHERE version=1")).rows.length) {
      const sql = await readFile(`${process.cwd()}/server/schema.sql`, "utf8");
      if (embedded)
        await embedded.exec(`BEGIN; ${sql} INSERT INTO migrations VALUES (1); COMMIT;`);
      else {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO migrations VALUES (1)");
        await c.query("COMMIT");
      }
    }
    if (!(await c.query("SELECT * FROM migrations WHERE version=2")).rows.length) {
      const sql = await readFile(`${process.cwd()}/server/migration-002.sql`, "utf8");
      if (embedded)
        await embedded.exec(`BEGIN; ${sql} INSERT INTO migrations VALUES(2); COMMIT;`);
      else {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO migrations VALUES(2)");
        await c.query("COMMIT");
      }
    }
    if (!(await c.query("SELECT * FROM migrations WHERE version=3")).rows.length) {
      const sql = await readFile(`${process.cwd()}/server/migration-003.sql`, "utf8");
      if (embedded)
        await embedded.exec(`BEGIN; ${sql} INSERT INTO migrations VALUES(3); COMMIT;`);
      else {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO migrations VALUES(3)");
        await c.query("COMMIT");
      }
    }
    if (!(await c.query("SELECT * FROM migrations WHERE version=4")).rows.length) {
      const sql = await readFile(`${process.cwd()}/server/migration-004.sql`, "utf8");
      if (embedded)
        await embedded.exec(`BEGIN; ${sql} INSERT INTO migrations VALUES(4); COMMIT;`);
      else {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO migrations VALUES(4)");
        await c.query("COMMIT");
      }
    }
    if (!(await c.query("SELECT * FROM migrations WHERE version=5")).rows.length) {
      const sql = await readFile(`${process.cwd()}/server/migration-005.sql`, "utf8");
      await c.query("BEGIN");
      try {
        if (embedded) await embedded.exec(sql);
        else await c.query(sql);
        await c.query("INSERT INTO migrations VALUES(5)");
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
    }
    if (!(await c.query("SELECT * FROM migrations WHERE version=6")).rows.length) {
      const sql = await readFile(`${process.cwd()}/server/migration-006.sql`, "utf8");
      await c.query("BEGIN");
      try {
        if (embedded) await embedded.exec(sql);
        else await c.query(sql);
        await c.query("INSERT INTO migrations VALUES(6)");
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
    }
    if (!(await c.query("SELECT * FROM migrations WHERE version=7")).rows.length) {
      const sql = await readFile(`${process.cwd()}/server/migration-007.sql`, "utf8");
      await c.query("BEGIN");
      try {
        if (embedded) await embedded.exec(sql);
        else await c.query(sql);
        await c.query("INSERT INTO migrations VALUES(7)");
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (!embedded) c.release();
  }
}
export async function closeDB() {
  const { embedded, pool } = database();
  if (embedded) await embedded.close();
  else await pool!.end();
}
