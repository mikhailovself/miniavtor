import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("export default async function handler(");
assert.ok(start >= 0);
const code = stripTypeScriptTypes(source.slice(start).replace("export default ", ""));

async function request(secret, header) {
  let processed = 0;
  const handler = runInNewContext(`${code}\nhandler`, {
    WEBHOOK_SECRET: secret,
    REDIS_URL: "https://redis.test",
    REDIS_TOKEN: "test",
    redis: async ([cmd]) => cmd === "SET" ? "OK" : null,
    handlePrivate: async () => { processed++; },
    console,
  });
  const result = {};
  const response = {
    status(code) { result.status = code; return this; },
    send(body) { result.body = body; return this; },
  };
  await handler({
    method: "POST",
    headers: header === undefined ? {} : { "x-telegram-bot-api-secret-token": header },
    body: { update_id: 123, message: { chat: { type: "private" } } },
  }, response);
  return { ...result, processed };
}

test("unconfigured webhook rejects requests before handling messages", async () => {
  for (const secret of [undefined, "", "   "]) {
    for (const header of [undefined, secret, "forged"]) {
      const result = await request(secret, header);
      assert.equal(result.status, 503);
      assert.equal(result.processed, 0);
    }
  }
});

test("configured webhook accepts only the matching secret header", async () => {
  for (const header of [undefined, "", "wrong", ["test-secret"]]) {
    const result = await request("test-secret", header);
    assert.equal(result.status, 401);
    assert.equal(result.processed, 0);
  }
  const result = await request("test-secret", "test-secret");
  assert.equal(result.status, 200);
  assert.equal(result.processed, 1);
});
