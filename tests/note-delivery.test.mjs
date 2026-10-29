import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("async function sendNoteOnce(");
const end = source.indexOf("\nasync function rememberNote(", start);
assert.ok(start >= 0 && end > start);
const code = stripTypeScriptTypes(source.slice(start, end));
function fixture(loseResponse = false, loseReceipt = false) {
  const keys = new Map(); let sends = 0;
  const send = runInNewContext(`${code}\nsendNoteOnce`, {
    redis: async ([cmd, key, value, ...opts]) => {
      if (cmd === "GET") return keys.get(key) ?? null;
      if (opts.includes("NX") && keys.has(key)) return null;
      if (loseReceipt && JSON.parse(value).result) throw new Error("Redis failed after delivery");
      keys.set(key, value); return "OK";
    },
    tg: async () => {
      sends++;
      if (loseResponse) throw new Error("Response lost after Telegram accepted message");
      return { ok: true, result: { message_id: 99 } };
    },
  });
  return { send: () => send("note:test", "sendMessage", { text: "Билеты" }), sends: () => sends };
}
test("retry after downstream failure reuses the sent message ID", async () => {
  const f = fixture();
  assert.equal((await f.send()).result.message_id, 99);
  assert.equal((await f.send()).result.message_id, 99);
  assert.equal(f.sends(), 1);
});
test("lost Telegram response or Redis receipt never triggers a blind resend", async () => {
  for (const f of [fixture(true), fixture(false, true)]) {
    await assert.rejects(f.send());
    const result = await f.send();
    assert.equal(result.ok, false);
    assert.match(result.description, /доставка не подтверждена/);
    assert.equal(f.sends(), 1);
  }
});
