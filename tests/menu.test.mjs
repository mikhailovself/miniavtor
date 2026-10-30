import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("async function mainView(");
const end = source.indexOf("\nasync function connectView(", start);
assert.ok(start >= 0 && end > start);
const code = stripTypeScriptTypes(source.slice(start, end));

test("start menu leads to abilities, ordinary group and secretary", async () => {
  const views = runInNewContext(`${code}\n({ mainView, abilitiesView, regularGroupView, secretaryView })`, {
    isOwner: () => false,
    redis: async () => null,
    botName: async () => "example_bot",
    btn: (text, callback_data) => ({ text, callback_data }),
    urlBtn: (text, url) => ({ text, url }),
    backBtn: (callback_data, text) => ({ text, callback_data }),
    esc: (value) => value,
  });
  const menu = await views.mainView({ id: "123" });
  const callbacks = menu.kb.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(Array.from(callbacks), ["abilities", "groupadd", "secretary", "author", "beat", "personal"]);
  assert.deepEqual(Array.from(menu.kb.inline_keyboard.slice(0, 3), row => row.length), [2, 2, 2]);
  assert.match(menu.text, /Творчество и дела/);
  assert.match(views.abilitiesView().text, /тематическим папкам/);
  assert.doesNotMatch(views.abilitiesView().text, /Смотрю и слушаю/);
  assert.match((await views.regularGroupView()).kb.inline_keyboard[0][0].url, /startgroup=chat/);
  assert.equal(views.secretaryView().kb.inline_keyboard[0][0].callback_data, "connect");
});

test("opening a new menu removes the previous bot menu after sending", async () => {
  const first = source.indexOf("async function sendView(");
  const last = source.indexOf("\nasync function setupCommands(", first);
  const calls = [];
  const saved = new Map();
  let nextId = 100;
  const { sendView } = runInNewContext(`${stripTypeScriptTypes(source.slice(first, last))}\n({ sendView })`, {
    redis: async ([cmd, key, value]) => {
      if (cmd === "GET") return saved.get(key);
      if (cmd === "SET") { saved.set(key, value); return "OK"; }
    },
    tg: async (method, payload) => {
      calls.push({ method, payload });
      return method === "sendMessage" ? { ok: true, result: { message_id: nextId++ } } : { ok: true };
    },
    Date,
    JSON,
    Number,
    console,
  });
  const view = { text: "Меню", kb: { inline_keyboard: [] } };
  await sendView(42, view);
  await sendView(42, view);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "sendMessage", "deleteMessage"]);
  assert.equal(calls[2].payload.message_id, 100);
  assert.equal(JSON.parse(saved.get("ui:menu:42")).id, 101);
});
