import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../server/http.js";
import { ensureRuntime } from "../server/runtime.js";
import { appOrigin } from "../server/paypalConfig.js";

test("deployment setup serves health but blocks application actions and starts no worker", async () => {
  const original = process.env.DEPLOYMENT_SETUP;
  process.env.DEPLOYMENT_SETUP = "true";
  try {
    let called = false;
    const endpoint = async () => {
      called = true;
      return Response.json({ ok: true });
    };
    const context = { params: Promise.resolve({}) };
    const blocked = await handle(endpoint, { public: true })(
      new Request("https://example.test/api/register", { method: "POST" }),
      context,
    );
    assert.equal(blocked.status, 503);
    assert.equal(called, false);
    const health = await handle(endpoint, { public: true, setupAllowed: true })(
      new Request("https://example.test/api/health"),
      context,
    );
    assert.equal(health.status, 200);
    await ensureRuntime();
    assert.equal((globalThis as any).trustCircleRuntime?.timer, undefined);
    assert.equal((globalThis as any).trustCircleDatabase, undefined);
  } finally {
    if (original === undefined) delete process.env.DEPLOYMENT_SETUP;
    else process.env.DEPLOYMENT_SETUP = original;
  }
});

test("Render origin is used unless APP_URL is explicitly configured", () => {
  const originalApp = process.env.APP_URL;
  const originalRender = process.env.RENDER_EXTERNAL_URL;
  try {
    delete process.env.APP_URL;
    process.env.RENDER_EXTERNAL_URL = "https://trustcircle-test.onrender.com";
    assert.equal(appOrigin(), "https://trustcircle-test.onrender.com");
    process.env.APP_URL = "https://circle.example/";
    assert.equal(appOrigin(), "https://circle.example");
  } finally {
    if (originalApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalApp;
    if (originalRender === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = originalRender;
  }
});
