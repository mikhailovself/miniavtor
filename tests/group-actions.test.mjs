import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import * as GC from "../lib/group-chat.ts";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");

function load() {
  const start = source.indexOf("type ActionCtx =");
  const end = source.indexOf("// ---------- Редкие голосовые");
  assert.ok(start > 0 && end > start);
  const code = stripTypeScriptTypes(source.slice(start, end));
  const calls = [];
  const slots = new Map();
  const counters = new Map();
  const env = {
    GC, sleep: async () => {},
    redis: async ([cmd, key, , nx]) => {
      if (cmd === "SET" && nx === "NX") { if (slots.has(key)) return null; slots.set(key, 1); return "OK"; }
      return null;
    },
    redisPipe: async ([[, key]]) => { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return [n, 1]; },
    tg: async (method, payload) => { calls.push({ method, ...payload }); return { ok: true, result: { message_id: 500 } }; },
    chatMemories: async () => [], isOwner: () => false,
  };
  const { runGroupActions } = runInNewContext(`${code}\n({ runGroupActions })`, env);
  return { runGroupActions, calls };
}

const hist = [
  { ts: Date.now() - 4000, uid: "1", name: "A", form: "?", mid: 10, text: "привет" },
  { ts: Date.now() - 3000, uid: "bot", name: "б", form: "он", bot: true, mid: 11, text: "здарова" },
];
const msg = { message_id: 12, text: "ну такое", from: { id: 1 }, chat: { id: -1 } };

test("опрос и кубик: только корректные и не чаще лимита", async () => {
  const { runGroupActions, calls } = load();
  const ctx = { history: hist, sentMids: [], addressed: false };
  await runGroupActions("-1", msg, "1", [{ name: "send_poll", args: { question: "Кто душнит?", options: ["Я", "Ты"] } }], undefined, ctx);
  await runGroupActions("-1", msg, "1", [{ name: "send_poll", args: { question: "Ещё один?", options: ["да", "нет"] } }], undefined, ctx);
  await runGroupActions("-1", msg, "1", [{ name: "send_poll", args: { question: "Плохой", options: ["один"] } }], undefined, ctx);
  await runGroupActions("-1", msg, "1", [{ name: "send_dice", args: { emoji: "💩" } }, { name: "send_dice", args: { emoji: "🎲" } }], undefined, ctx);
  assert.equal(calls.filter((c) => c.method === "sendPoll").length, 1);
  assert.equal(JSON.stringify(calls.find((c) => c.method === "sendPoll").options), JSON.stringify([{ text: "Я" }, { text: "Ты" }]));
  assert.equal(calls.filter((c) => c.method === "sendDice").length, 1);
});

test("реакция на выбранное сообщение и лимит для самостоятельных реакций", async () => {
  const { runGroupActions, calls } = load();
  const ctx = { history: hist, sentMids: [], addressed: false };
  await runGroupActions("-1", msg, "1", [{ name: "react", args: { emoji: "🗿", message_id: 10 } }], undefined, ctx);
  await runGroupActions("-1", msg, "1", [{ name: "react", args: { emoji: "🔥" } }], undefined, ctx);
  const reacts = calls.filter((c) => c.method === "setMessageReaction");
  assert.equal(reacts.length, 1);
  assert.equal(reacts[0].message_id, 10);
  // по просьбе (addressed) лимит не действует; чужой/ботов номер игнорируется, берётся текущее сообщение
  await runGroupActions("-1", msg, "1", [{ name: "react", args: { emoji: "🔥", message_id: 11 } }], undefined, { ...ctx, addressed: true });
  assert.equal(calls.filter((c) => c.method === "setMessageReaction").at(-1).message_id, 12);
});

test("правка и удаление трогают только последнее сообщение бота и ограничены тремя в час", async () => {
  const { runGroupActions, calls } = load();
  const ctx = { history: hist, sentMids: [77], addressed: true };
  await runGroupActions("-1", msg, "1", [{ name: "edit_own", args: { text: "а нет, хотел сказать другое" } }], undefined, ctx);
  await runGroupActions("-1", msg, "1", [{ name: "delete_own", args: {} }], undefined, ctx);
  const edit = calls.find((c) => c.method === "editMessageText");
  assert.equal(edit.message_id, 77);
  assert.equal(calls.find((c) => c.method === "deleteMessage").message_id, 77);
  // без отправленного в этом ходе берётся последнее сообщение бота из истории
  const second = load();
  await second.runGroupActions("-1", msg, "1", [{ name: "delete_own", args: {} }], undefined, { history: hist, sentMids: [], addressed: true });
  assert.equal(second.calls.find((c) => c.method === "deleteMessage").message_id, 11);
  // четвёртое действие за час отбрасывается
  const third = load();
  for (let i = 0; i < 5; i++) await third.runGroupActions("-1", msg, "1", [{ name: "delete_own", args: {} }], undefined, { history: hist, sentMids: [], addressed: true });
  assert.equal(third.calls.filter((c) => c.method === "deleteMessage").length, 3);
});

test("проводка в groupChatter: фильтр функций, stay_silent, reply_to, голосовые", () => {
  assert.match(source, /actions = \(res\.actions \?\? \[\]\)\.filter\(\(a\) => offered\.has\(a\.name\)\)/);
  assert.match(source, /GC\.pickActionDecls\(\{ addressed, text, heated: GC\.isHeated\(text\) \}\)/);
  assert.match(source, /a\.name === "stay_silent"[\s\S]{0,200}startSulk\(chat, uid, "user", 15 \* 60\)/);
  assert.match(source, /GC\.validMessageId\(replyPick\.args\?\.message_id, chatHistory\.shown\)/);
  assert.match(source, /Math\.random\(\) < VOICE_CHANCE/);
  assert.match(source, /VOICE_CHANCE = [^;]*"0\.04"/);
});

test("«я уже всё сказал»: при обиде бот пересылает своё сообщение и ставит точку", async () => {
  const start = source.indexOf("async function groupHistoryLines(");
  const end = source.indexOf("// Считает обмены в споре");
  const code = stripTypeScriptTypes(source.slice(start, end));
  const calls = [];
  const orig = Math.random;
  Math.random = () => 0.9; // sulkAction -> dot
  try {
    const { sulkResponse } = runInNewContext(`${code}\n({ sulkResponse })`, {
      GC, redis: async () => [GC.serializeLine({ ts: Date.now() - 1000, uid: "bot", name: "б", form: "он", bot: true, mid: 31, text: "я всё сказал" })],
      tg: async (method, payload) => { calls.push({ method, ...payload }); return { ok: true }; },
    });
    await sulkResponse("-1", { message_id: 40 });
  } finally { Math.random = orig; }
  assert.equal(calls[0].method, "forwardMessage");
  assert.equal(calls[0].message_id, 31);
  assert.equal(calls[1].method, "sendMessage");
  assert.equal(calls[1].text, ".");
  assert.equal(calls[1].reply_parameters.message_id, 40);
});
