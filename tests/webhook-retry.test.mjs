import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const code = stripTypeScriptTypes(source.slice(source.indexOf("export default async function handler(")).replace("export default ", ""));
function fixture() {
  const keys = new Map();
  let attempts = 0, fail = true, unavailable = false;
  const handler = runInNewContext(`${code}\nhandler`, {
    WEBHOOK_SECRET: "secret", REDIS_URL: "test", REDIS_TOKEN: "test",
    console: { error() {} },
    redis: async ([cmd, key, value, ...options]) => {
      if (unavailable) throw new Error("Redis offline");
      if (cmd === "GET") return keys.get(key) ?? null;
      if (cmd === "SET") {
        if (options.includes("NX") && keys.has(key)) return null;
        keys.set(key, value); return "OK";
      }
      throw new Error(cmd);
    },
    handlePrivate: async () => { attempts++; if (fail) throw new Error("interrupted"); },
  });
  return {
    keys, attempts: () => attempts,
    succeed() { fail = false; }, offline() { unavailable = true; },
    async send() {
      let status;
      await handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: { update_id: 42, message: { chat: { type: "private" } } } }, {
        status(value) { status = value; return this; }, send() { return this; },
      });
      return status;
    },
  };
}
test("failed update remains retryable, success prevents redelivery", async () => {
  const f = fixture();
  assert.equal(await f.send(), 503);
  assert.equal(f.keys.has("update:done:42"), false);
  assert.equal(await f.send(), 503);
  assert.equal(f.attempts(), 1);
  f.keys.delete("update:processing:42"); // Redis TTL expiry after worker failure.
  f.succeed();
  assert.equal(await f.send(), 200);
  assert.equal(await f.send(), 200);
  assert.equal(f.attempts(), 2);
});
test("unavailable Redis prevents processing instead of silently accepting", async () => {
  const f = fixture(); f.offline();
  assert.equal(await f.send(), 503);
  assert.equal(f.attempts(), 0);
});
