import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("async function runReminders()");
const end = source.indexOf("\nconst OUTREACH_TEXTS", start);
assert.ok(start >= 0 && end > start, "reminder function found");
const functionSource = stripTypeScriptTypes(source.slice(start, end));

function fixture() {
  const reminder = JSON.stringify({ u: "123", t: "Встреча", d: "2026-10-28" });
  const queue = new Set([reminder]);
  const keys = new Map();
  const calls = [];
  const responses = [];
  const redis = async ([command, key, ...args]) => {
    if (command === "ZRANGEBYSCORE") return [...queue];
    if (command === "ZREM") return queue.delete(args[0]) ? 1 : 0;
    if (command === "GET") return keys.get(key) ?? null;
    if (command === "SET") {
      if (args.includes("NX") && keys.has(key)) return null;
      keys.set(key, args[0]);
      return "OK";
    }
    if (command === "DEL") return keys.delete(key) ? 1 : 0;
    if (command === "HINCRBY" || command === "HSET") return 1;
    throw new Error(`Unexpected Redis command: ${command}`);
  };
  const run = runInNewContext(`${functionSource}\nrunReminders`, {
    redis,
    redisPipe: async () => [1, 1],
    tg: async (_method, payload) => {
      calls.push(payload);
      return responses.shift() ?? { ok: true };
    },
    appendPrivateLog: async () => {},
    ymd: (offset = 0) => offset ? "2026-10-29" : "2026-10-28",
    hashStr: () => "stable",
    pickOne: (items) => items[0],
    setTimeout,
    Date,
    console,
  });
  return { run, queue, calls, responses };
}

test("failed reminder remains queued and succeeds on retry without a duplicate", async () => {
  const f = fixture();
  f.responses.push({ ok: false, error_code: 400, description: "temporary failure" });
  assert.deepEqual({ ...await f.run() }, { sent: 0, errors: 1 });
  assert.equal(f.queue.size, 1);

  assert.deepEqual({ ...await f.run() }, { sent: 1, errors: 0 });
  assert.equal(f.queue.size, 0);
  assert.deepEqual({ ...await f.run() }, { sent: 0, errors: 0 });
  assert.equal(f.calls.length, 2);
});
