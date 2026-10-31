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
  assert.deepEqual(Array.from(callbacks), ["abilities", "groupadd", "tools", "author", "personal"]);
  assert.equal(menu.kb.inline_keyboard[3][0].text, "👍 автор бота");
  assert.deepEqual(Array.from(menu.kb.inline_keyboard.slice(0, 4), row => row.length), [1, 1, 1, 2]);
  assert.equal(menu.text, "<b>📋 Менюшка</b>\n\nНу че, куда?");
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
  const apiCall = async (method, payload) => {
    calls.push({ method, payload });
    return method === "sendMessage" ? { ok: true, result: { message_id: nextId++ } } : { ok: true };
  };
  const { sendView } = runInNewContext(`${stripTypeScriptTypes(source.slice(first, last))}\n({ sendView })`, {
    redis: async ([cmd, key, value]) => {
      if (cmd === "GET") return saved.get(key);
      if (cmd === "SET") { saved.set(key, value); return "OK"; }
    },
    tg: apiCall,
    tgView: apiCall,
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

test("unsupported custom emoji does not resend a menu without its icons", async () => {
  const first = source.indexOf("async function tgView(");
  const last = source.indexOf("\nasync function sendView(", first);
  const calls = [];
  const { tgView } = runInNewContext(`${stripTypeScriptTypes(source.slice(first, last))}\n({ tgView })`, {
    tg: async (method, payload) => {
      calls.push({ method, payload });
      return calls.length === 1 ? { ok: false, error_code: 400 } : { ok: true };
    },
  });
  const result = await tgView("sendMessage", { reply_markup: { inline_keyboard: [[
    { text: "автор бота", callback_data: "author", icon_custom_emoji_id: "222" },
  ]] } });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, "222");
});
