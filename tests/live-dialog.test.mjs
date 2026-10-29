import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("const LIVE_SECONDS =");
const end = source.indexOf("\n// ---------- Напоминания о сроках", start);
assert.ok(start >= 0 && end > start, "live-dialog functions found");
const functionSource = stripTypeScriptTypes(source.slice(start, end));

function fixture() {
  const keys = new Map();
  const sent = [];
  const logs = [];
  const redis = async ([command, key, ...args]) => {
    if (command === "GET") return keys.get(key) ?? null;
    if (command === "SET") { keys.set(key, args[0]); return "OK"; }
    if (command === "DEL") return keys.delete(key) ? 1 : 0;
    if (command === "EXPIRE") return keys.has(key) ? 1 : 0;
    throw new Error(`Unexpected Redis command: ${command}`);
  };
  const redisPipe = async (commands) => Promise.all(commands.map(redis));
  const tg = async (method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: 42 } };
  };
  const functions = runInNewContext(`${functionSource}\n({ startLive, relayFromOwner, stopLive })`, {
    OWNER_ID: "1",
    redis,
    redisPipe,
    tg,
    appendPrivateLog: async (...args) => logs.push(args),
    loadHistory: async () => [],
    Promise,
  });
  return { ...functions, keys, sent, logs };
}

test("owner joins one dialog, replies to its user and leaves", async () => {
  const f = fixture();
  assert.equal(await f.startLive("123"), true);
  assert.equal(f.keys.get("live:owner"), "123");
  assert.equal(f.keys.get("live:user:123"), "1");
  assert.equal(f.sent.some((item) => item.method === "sendMessage" && item.payload.chat_id === "123"), false);

  assert.equal(await f.relayFromOwner({ message_id: 77, text: "Привет лично" }, "123"), true);
  const copy = f.sent.find((item) => item.method === "copyMessage");
  assert.equal(copy.payload.chat_id, "123");
  assert.equal(copy.payload.from_chat_id, "1");
  assert.ok(f.logs.some((entry) => entry[0] === "123" && entry[1] === "o"));

  assert.equal(await f.stopLive(), "123");
  assert.equal(f.keys.has("live:owner"), false);
  assert.equal(f.keys.has("live:user:123"), false);
  assert.equal(f.sent.some((item) => item.method === "sendMessage" && item.payload.chat_id === "123"), false);
});
