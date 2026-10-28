import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("async function broadcastRecipients()");
const end = source.indexOf("\n// ---------- Напоминания о сроках", start);
assert.ok(start >= 0 && end > start);
const code = stripTypeScriptTypes(source.slice(start, end));

test("broadcasts to private users, skips bans and reports delivery", async () => {
  const users = ["1", "2", "3", "4"];
  const queue = ["2", "3"];
  const active = { id: "abc", message_id: "77", status: "sending", total: "2", sent: "0", failed: "0", skipped: "0" };
  const sent = [];
  const redis = async ([cmd, key, ...args]) => {
    if (cmd === "SMEMBERS") return users;
    if (cmd === "HGET") return key.startsWith("activity:") ? (key.endsWith("1") || key.endsWith("2") || key.endsWith("3") ? "1" : "0") : null;
    if (cmd === "SISMEMBER") return key === "banned" && args[0] === "3" ? 1 : key === "users" ? 1 : 0;
    if (cmd === "SET") return "OK";
    if (cmd === "HGETALL") return active;
    if (cmd === "LPOP") return queue.shift() ?? null;
    if (cmd === "LLEN") return queue.length;
    if (cmd === "HINCRBY") { active[args[0]] = String(Number(active[args[0]] || 0) + Number(args[1])); return active[args[0]]; }
    if (cmd === "HSET") { for (let i = 0; i < args.length; i += 2) active[args[i]] = args[i + 1]; return 1; }
    if (cmd === "DEL") return 1;
    throw new Error(`Unexpected Redis command: ${cmd}`);
  };
  const f = runInNewContext(`${code}\n({ broadcastRecipients, runBroadcast })`, {
    OWNER_ID: "1", redis, redisPipe: async (commands) => Promise.all(commands.map(redis)),
    toObj: (x) => x, tg: async (method, payload) => { sent.push({ method, payload }); return { ok: true }; },
    setTimeout, Promise, Date,
  });
  assert.deepEqual(Array.from(await f.broadcastRecipients()), ["2"]);
  await f.runBroadcast(15000);
  assert.equal(active.sent, "1");
  assert.equal(active.skipped, "1");
  assert.equal(active.status, "done");
  assert.equal(sent.filter((x) => x.method === "copyMessage").length, 1);
  assert.equal(sent.find((x) => x.method === "copyMessage").payload.chat_id, "2");
});
