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
    authorEmojiId: async () => "123456789",
    botName: async () => "example_bot",
    btn: (text, callback_data) => ({ text, callback_data }),
    urlBtn: (text, url) => ({ text, url }),
    backBtn: (callback_data, text) => ({ text, callback_data }),
    esc: (value) => value,
  });
  const menu = await views.mainView({ id: "123" });
  const callbacks = menu.kb.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(Array.from(callbacks), ["abilities", "groupadd", "secretary", "beat", "author", "personal"]);
  assert.equal(menu.kb.inline_keyboard[2][0].icon_custom_emoji_id, "123456789");
  assert.equal(menu.kb.inline_keyboard[2][0].text, "автор бота");
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

test("author icon resolves the thumbs-up custom emoji from the linked pack", async () => {
  const first = source.indexOf("async function authorEmojiId(");
  const last = source.indexOf("\nconst profileUrl", first);
  const saved = new Map();
  const requests = [];
  const { authorEmojiId } = runInNewContext(`${stripTypeScriptTypes(source.slice(first, last))}\n({ authorEmojiId })`, {
    redis: async ([command, key, value]) => command === "GET" ? saved.get(key) : saved.set(key, value),
    tg: async (method, payload) => {
      requests.push({ method, payload });
      return { ok: true, result: { stickers: [
        { type: "custom_emoji", emoji: "🎤", custom_emoji_id: "111" },
        { type: "custom_emoji", emoji: "👍", custom_emoji_id: "222" },
      ] } };
    },
  });
  assert.equal(await authorEmojiId(), "222");
  assert.equal(await authorEmojiId(), "222");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.name, "avtor_emojis");
});

test("unsupported custom emoji icon falls back to a regular thumbs-up", async () => {
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
  assert.equal(result.ok, true);
  assert.equal(calls[1].payload.reply_markup.inline_keyboard[0][0].text, "👍 автор бота");
  assert.equal(calls[1].payload.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, undefined);
});
