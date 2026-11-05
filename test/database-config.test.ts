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

test("dedicated schema overrides URL search path without public fallback", () => {
  const config = databaseConfig({
    DATABASE_URL:
      "postgresql://user:pass@db.example/db?options=-c%20search_path%3Dpublic",
    DATABASE_SCHEMA: "trustcircle_paypal",
    PGSSL: "true",
  });
  const client = new pg.Client(config);
  assert.equal(
    (client as any).connectionParameters.options,
    "-c search_path=trustcircle_paypal",
  );
  assert.deepEqual((client as any).connectionParameters.ssl, {
    rejectUnauthorized: true,
  });
});

test("invalid or shared schema names are rejected", () => {
  for (const schema of [
    "public",
    "pg_catalog",
    "a,b",
    "test;DROP SCHEMA public",
    "information_schema",
  ]) {
    assert.throws(
      () =>
        databaseConfig({
          DATABASE_URL: "postgresql://user:pass@db.example/db",
          DATABASE_SCHEMA: schema,
        }),
      /dedicated/,
    );
  }
});
