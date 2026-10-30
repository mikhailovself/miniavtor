import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { membershipState, checkSubscription, subscriptionKeyboard, subscriptionText } from "../api/subscription.ts";

test("channel members can enter; departed and restricted nonmembers cannot", () => {
  for (const status of ["creator", "administrator", "member"]) {
    assert.equal(membershipState({ ok: true, result: { status } }), "subscribed");
  }
  assert.equal(membershipState({ ok: true, result: { status: "restricted", is_member: true } }), "subscribed");
  for (const status of ["left", "kicked", "restricted"]) {
    assert.equal(membershipState({ ok: true, result: { status } }), "missing");
  }
  assert.equal(membershipState({ ok: false }), "error");
});

test("membership check uses the configured channel and user's Telegram ID", async () => {
  const previous = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return { json: async () => ({ ok: true, result: { status: "member" } }) };
  };
  try {
    assert.equal(await checkSubscription("test-token", 12345), "subscribed");
    assert.match(request.url, /getChatMember$/);
    assert.deepEqual(request.body, { chat_id: "@vladavtorx", user_id: 12345 });
  } finally { globalThis.fetch = previous; }
});

test("gate offers the channel and a recheck", () => {
  assert.match(subscriptionText("missing"), /без подписки/);
  assert.equal(subscriptionKeyboard().inline_keyboard[0][0].url, "https://t.me/vladavtorx");
  assert.equal(subscriptionKeyboard().inline_keyboard[1][0].callback_data, "subcheck");
});

test("unsubscribed private user sees the gate only after /start", async () => {
  const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function handlePrivate(");
  const end = source.indexOf("  if (isOwner(uid)) await migrateLegacy();", start);
  const code = stripTypeScriptTypes(source.slice(start, end) + "\n}");
  const views = [];
  const { handlePrivate } = runInNewContext(`${code}\n({ handlePrivate })`, {
    REDIS_URL: "https://redis.test", TELEGRAM_BOT_TOKEN: "token",
    checkSubscription: async () => "missing",
    subscriptionView: state => ({ text: state }),
    sendView: async (chat, view) => { views.push({ chat, view }); },
    tg: async () => { throw new Error("normal bot work must not run"); },
    Date,
  });
  await handlePrivate({ from: { id: 123 }, chat: { id: 123 }, text: "/start" });
  assert.deepEqual(views, [{ chat: 123, view: { text: "missing" } }]);
  await handlePrivate({ from: { id: 123 }, chat: { id: 123 }, text: "/beat https://youtu.be/example" });
  await handlePrivate({ from: { id: 123 }, chat: { id: 123 }, text: "Привет" });
  await handlePrivate({ from: { id: 123 }, chat: { id: 123 }, voice: { file_id: "voice" } });
  assert.equal(views.length, 1);
});

test("unsubscribed button presses are acknowledged without another gate", async () => {
  const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function handleCallback(");
  const end = source.indexOf("  if (uid && chatId && mid && cb.message?.chat?.type !== \"private\"", start);
  const code = stripTypeScriptTypes(source.slice(start, end) + "\n}");
  const replies = [];
  const { handleCallback } = runInNewContext(`${code}\n({ handleCallback })`, {
    TELEGRAM_BOT_TOKEN: "token",
    checkSubscription: async () => "missing",
    tg: async (method, payload) => { replies.push({ method, payload }); },
    sendView: async () => { throw new Error("must not send another gate"); },
  });
  const base = { id: "callback", from: { id: 123 }, message: { chat: { id: 123, type: "private" }, message_id: 1 } };
  await handleCallback({ ...base, data: "menu" });
  await handleCallback({ ...base, data: "subcheck" });
  assert.deepEqual(replies.map(reply => reply.method), ["answerCallbackQuery", "answerCallbackQuery"]);
  assert.equal(replies[0].payload.text, undefined);
  assert.match(replies[1].payload.text, /Подписки пока не вижу/);
});

test("group button presses bypass the private subscription gate", async () => {
  const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function handleCallback(");
  const end = source.indexOf("  if (uid && chatId && mid && cb.message?.chat?.type !== \"private\"", start);
  const code = stripTypeScriptTypes(source.slice(start, end) + "\n}");
  const { handleCallback } = runInNewContext(`${code}\n({ handleCallback })`, {
    checkSubscription: async () => { throw new Error("group membership must not be checked"); },
    tg: async () => { throw new Error("group button must not receive a subscription prompt"); },
  });
  await handleCallback({ id: "callback", data: "noteitem:0", from: { id: 123 }, message: { chat: { id: -123, type: "supergroup" }, message_id: 1 } });
});

test("group commands work without a channel subscription", async () => {
  const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function handleGroup(");
  const end = source.indexOf("  if (cmd === \"/connect\")", start);
  const code = stripTypeScriptTypes(source.slice(start, end) + "\n}");
  const messages = [];
  const { handleGroup } = runInNewContext(`${code}\n({ handleGroup })`, {
    REDIS_URL: "https://redis.test", TELEGRAM_BOT_TOKEN: "token",
    checkSubscription: async () => { throw new Error("group membership must not be checked"); },
    sayIn: async (chat, thread, message) => { messages.push({ chat, thread, message }); },
  });
  await handleGroup({ from: { id: 123 }, chat: { id: -123, type: "supergroup" }, text: "/ping" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat, "-123");
});
