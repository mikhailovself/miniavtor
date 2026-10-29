import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("async function scheduleReminder(");
const end = source.indexOf("\nasync function replaceReminder(", start);
assert.ok(start >= 0 && end > start);
const code = stripTypeScriptTypes(source.slice(start, end));

function fixture(afterNine) {
  const queue = new Set();
  const keys = new Map();
  const sent = [];
  const f = runInNewContext(`${code}\nscheduleReminder`, {
    ymd: () => "2026-10-29",
    isAfterMorningReminderTime: () => afterNine,
    hashStr: () => "stable",
    redis: async ([cmd, key, ...args]) => {
      if (cmd === "ZADD") { queue.add(args[1]); return 1; }
      if (cmd === "ZREM") return queue.delete(args[0]) ? 1 : 0;
      if (cmd === "GET") return keys.get(key) ?? null;
      if (cmd === "SET") { if (args.includes("NX") && keys.has(key)) return null; keys.set(key, args[0]); return "OK"; }
      if (cmd === "DEL") return keys.delete(key) ? 1 : 0;
      throw new Error(`Unexpected Redis command: ${cmd}`);
    },
    tg: async (_method, payload) => { sent.push(payload); return { ok: true }; },
    appendPrivateLog: async () => {},
    console,
    Date,
  });
  return { f, queue, sent };
}

test("today is declined with the owner's exact text; tomorrow is queued", async () => {
  for (const afterNine of [false, true]) {
    const f = fixture(afterNine);
    assert.equal(await f.f("123", "Билеты", "2026-10-29"), false);
    assert.equal(f.queue.size, 0);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].text, "извини ,влад ебаный бомж и не может опалатить подписку одного из сервисов, потэому напомнит сегодня я не могу, а на любой другой день могу");
    assert.equal(await f.f("123", "Билеты", "2026-10-30"), true);
    assert.equal(f.queue.size, 1);
    assert.equal(f.sent.length, 1);
    assert.equal(await f.f("123", "Вчера", "2026-10-28"), false);
  }
});
