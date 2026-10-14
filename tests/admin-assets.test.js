import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function assetEnv() {
  const requests = [];
  return {
    requests,
    env: { ASSETS: { async fetch(input) {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      return new Response(url.endsWith("settings-context.js") ? "window.SettingsContext = {};" : "admin shell", {
        headers: { "content-type": url.endsWith(".js") ? "application/javascript" : "text/html" }
      });
    } } }
  };
}

test("admin JavaScript assets are served as assets instead of the HTML app shell", async () => {
  const { env, requests } = assetEnv();
  const response = await worker.fetch(new Request("https://crm.test/admin/settings-context.js"), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/javascript");
  assert.equal(await response.text(), "window.SettingsContext = {};");
  assert.deepEqual(requests, ["https://crm.test/admin/settings-context.js"]);
});

test("admin deep links still require staff authentication", async () => {
  const { env, requests } = assetEnv();
  const response = await worker.fetch(new Request("https://crm.test/admin/events/123"), env, {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://crm.test/auth/login");
  assert.deepEqual(requests, []);
});