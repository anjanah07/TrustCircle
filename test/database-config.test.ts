import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { databaseConfig } from "../server/databaseConfig.mjs";

test("Render internal mode requires TLS and overrides conflicting URL ssl flags", () => {
  const options = databaseConfig({
    RENDER: "true",
    PGSSL_MODE: "render-internal",
    PGSSL: "true",
    DATABASE_URL: "postgresql://user:pass@dpg-example-a/db?sslmode=disable",
  });
  assert.deepEqual(options.ssl, { rejectUnauthorized: false });
  const client = new pg.Client(options);
  assert.deepEqual((client as any).connectionParameters.ssl, {
    rejectUnauthorized: false,
  });
});
test("Render exception rejects local, public and host-override connections", () => {
  for (const url of [
    "postgresql://user:pass@database.example/db",
    "postgresql://user:pass@dpg-example-a.oregon-postgres.render.com/db",
    "postgresql://user:pass@dpg-example-a/db?host=other.example",
  ]) {
    assert.throws(
      () =>
        databaseConfig({
          RENDER: "true",
          PGSSL_MODE: "render-internal",
          DATABASE_URL: url,
        }),
      /private/,
    );
  }
  assert.throws(
    () =>
      databaseConfig({
        PGSSL_MODE: "render-internal",
        DATABASE_URL: "postgresql://user:pass@dpg-example-a/db",
      }),
    /Render service/,
  );
});
test("ordinary hosted connections retain certificate verification", () => {
  assert.deepEqual(
    databaseConfig({
      PGSSL: "true",
      DATABASE_URL: "postgresql://user:pass@db.example/db",
    }).ssl,
    { rejectUnauthorized: true },
  );
});
