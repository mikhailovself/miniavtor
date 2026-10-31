import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { EMOJI_CANDIDATES } from "../api/emoji-candidates.ts";

const source = readFileSync(new URL("../api/animated-emoji.ts", import.meta.url), "utf8")
  .replace(/^import .*\n/gm, "").replace(/^export /gm, "");
const { animatedEmojiIds, decorateAnimatedEmoji, needsAnimatedEmoji } = runInNewContext(
  `${stripTypeScriptTypes(source)}\n({ animatedEmojiIds, decorateAnimatedEmoji, needsAnimatedEmoji })`,
  { EMOJI_CANDIDATES, Intl, Map, Set, Date, Promise, AbortSignal, console,
    fetch: (...args) => globalThis.fetch(...args) },
);

test("Telegram pack loader accepts only colored animated custom emoji with exact alt", async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url) => { requests++; return ({ json: async () => url.endsWith("getCustomEmojiStickers")
    ? { ok: true, result: [
      { type: "custom_emoji", emoji: "🗂", custom_emoji_id: "5431736674147114227", is_animated: true },
      { type: "custom_emoji", emoji: "📋", custom_emoji_id: "456", is_animated: true },
    ] }
    : { ok: true, result: { sticker_type: "custom_emoji", stickers: [
      { type: "custom_emoji", emoji: "🎧", custom_emoji_id: "123", is_animated: true },
      { type: "custom_emoji", emoji: "📋", custom_emoji_id: "456", is_animated: false },
      { type: "custom_emoji", emoji: "⚙️", custom_emoji_id: "789", is_video: true, needs_repainting: true },
    ] } } }); };
  try {
    const [ids, same] = await Promise.all([animatedEmojiIds("test-token"), animatedEmojiIds("test-token")]);
    assert.equal(ids, same);
    assert.equal(ids.get("🎧"), "123");
    assert.equal(ids.get("🗂"), "5431736674147114227");
    assert.equal(ids.has("📋"), false);
    assert.equal(ids.has("⚙️"), false);
    const before = requests;
    await animatedEmojiIds("test-token");
    assert.equal(requests, before);
    assert.equal(requests, 15);
  } finally { globalThis.fetch = previous; }
});

test("empty catalog refuses to drop icons while ordinary text still works", () => {
  assert.throws(() => decorateAnimatedEmoji("sendMessage", { text: "👀 Привет" }, new Map()), /ANIMATED_EMOJI_UNAVAILABLE/);
  assert.equal(decorateAnimatedEmoji("sendMessage", { text: "Привет" }, new Map()).text, "Привет");
});

test("cold process uses a fresh verified Redis snapshot without Telegram requests", async () => {
  let requests = 0;
  const { animatedEmojiIds: load } = runInNewContext(`${stripTypeScriptTypes(source)}\n({ animatedEmojiIds })`, {
    EMOJI_CANDIDATES, Intl, Map, Set, Date, Promise, AbortSignal, console,
    fetch: async () => { requests++; throw new Error("must not fetch"); },
  });
  const ids = await load("test", {
    read: async () => JSON.stringify({ version: 1, at: Date.now(), entries: [["🎧", "123"]] }),
    write: async () => { throw new Error("must not write"); },
  });
  assert.equal(ids.get("🎧"), "123");
  assert.equal(requests, 0);
});

test("catalog storage failure still allows Telegram verification", async () => {
  const { animatedEmojiIds: load } = runInNewContext(`${stripTypeScriptTypes(source)}\n({ animatedEmojiIds })`, {
    EMOJI_CANDIDATES, Intl, Map, Set, Date, Promise, AbortSignal, console: { info() {} },
    fetch: async () => ({ json: async () => ({ ok: true, result: { sticker_type: "custom_emoji", stickers: [
      { type: "custom_emoji", emoji: "🎧", custom_emoji_id: "123", is_animated: true },
    ] } }) }),
  });
  const ids = await load("test", { read: async () => { throw new Error("offline"); }, write: async () => { throw new Error("offline"); } });
  assert.equal(ids.get("🎧"), "123");
});

test("HTML numeric emoji and existing tg-emoji IDs are replaced with verified icons", () => {
  const result = decorateAnimatedEmoji("sendMessage", {
    text: '<b>&#x1f3a7;</b> <tg-emoji emoji-id="unverified">🎧</tg-emoji> &lt;test&gt;', parse_mode: "HTML",
  }, new Map([["🎧", "123"]]));
  assert.equal(result.text, '<b><tg-emoji emoji-id="123">🎧</tg-emoji></b> <tg-emoji emoji-id="123">🎧</tg-emoji> &lt;test&gt;');
  assert.equal(decorateAnimatedEmoji("sendMessage", result, new Map([["🎧", "123"]])).text, result.text);
});

test("icons inside code remain animated outside the code span", () => {
  const ids = new Map([["🎧", "123"]]);
  const html = decorateAnimatedEmoji("sendMessage", { text: '<code>A 🎧 B</code>', parse_mode: "HTML" }, ids);
  assert.equal(html.text, '<code>A </code><tg-emoji emoji-id="123">🎧</tg-emoji><code> B</code>');
  const plain = decorateAnimatedEmoji("sendMessage", { text: "A 🎧 B", entities: [{ type: "code", offset: 0, length: 6 }] }, ids);
  assert.deepEqual(Array.from(plain.entities, e => [e.type, e.offset, e.length]), [["code", 0, 2], ["code", 4, 2], ["custom_emoji", 2, 2]]);
});

test("existing unverified entities cannot bypass the animated catalog", () => {
  const result = decorateAnimatedEmoji("sendMessage", { text: "🎧", entities: [
    { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "static" },
  ] }, new Map([["🎧", "123"]]));
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].custom_emoji_id, "123");
});

test("album captions, voice captions and string buttons are decorated", () => {
  const ids = new Map([["🎧", "123"]]);
  const album = decorateAnimatedEmoji("sendMediaGroup", { media: [{ type: "photo", media: "id", caption: "🎧" }] }, ids);
  assert.equal(album.media[0].caption_entities[0].custom_emoji_id, "123");
  const voice = decorateAnimatedEmoji("sendVoice", { caption: "🎧", reply_markup: { keyboard: [["🎧 Слушать"]] } }, ids);
  assert.equal(voice.caption_entities[0].custom_emoji_id, "123");
  assert.equal(voice.reply_markup.keyboard[0][0].icon_custom_emoji_id, "123");
});

test("musical alternatives are preferred to an unrelated verified icon", () => {
  const result = decorateAnimatedEmoji("sendMessage", { text: "🎶 Биток" }, new Map([["📋", "456"], ["🎧", "123"]]));
  assert.equal(result.text, "🎧 Биток");
  assert.equal(result.entities[0].custom_emoji_id, "123");
});

test("catalog lookup is needed only for visible emoji and button icons", () => {
  assert.equal(needsAnimatedEmoji({ text: "Привет", reply_markup: { inline_keyboard: [[{ text: "Тест", callback_data: "🎧" }]] } }), false);
  assert.equal(needsAnimatedEmoji({ media: [{ caption: "🎧" }] }), true);
  assert.equal(needsAnimatedEmoji({ reply_markup: { keyboard: [["🎧 Тест"]] } }), true);
  assert.equal(needsAnimatedEmoji({ text: "&#128512;", parse_mode: "HTML" }), true);
});

test("progress bar squares survive both decoration and Telegram errors without an iconless retry", async () => {
  const webhook = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  const start = webhook.indexOf("const PLAIN_SQUARES");
  const end = webhook.indexOf("\n// Прогресс-бар битка", start);
  const calls = [];
  const { tg } = runInNewContext(`${stripTypeScriptTypes(webhook.slice(start, end))}\n({ tg })`, {
    decorateAnimatedEmoji, needsAnimatedEmoji, animatedEmojiIds: async () => new Map([["🎧", "123"]]),
    TELEGRAM_BOT_TOKEN: "test", console: { error() {} },
    fetch: async (_, options) => { calls.push(JSON.parse(options.body)); return { json: async () => ({ ok: false, error_code: 400 }) }; },
  });
  const result = await tg("editMessageText", { text: "🎧 Биток\n🟩⬜ 10%", parse_mode: "HTML", keep_plain_squares: true });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '<tg-emoji emoji-id="123">🎧</tg-emoji> Биток\n🟩⬜ 10%');
  assert.equal(calls[0].keep_plain_squares, undefined);
});

test("menu wording and actions stay intact while a verified animated icon is used", () => {
  const ids = new Map([["🎧", "123"], ["📋", "456"]]);
  const original = { text: "<b>📋 Менюшка</b>\n\nНу че, куда?", parse_mode: "HTML", reply_markup: { inline_keyboard: [[
    { text: "🎧 Скачать биток", callback_data: "beat" },
    { text: "автор бота", callback_data: "author", icon_custom_emoji_id: "5384084295465854839" },
  ]] } };
  const result = decorateAnimatedEmoji("sendMessage", original, ids);
  assert.equal(result.text, '<b><tg-emoji emoji-id="456">📋</tg-emoji> Менюшка</b>\n\nНу че, куда?');
  assert.equal(result.reply_markup.inline_keyboard[0][0].text, "Скачать биток");
  assert.equal(result.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, "123");
  assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data, "beat");
  assert.equal(result.reply_markup.inline_keyboard[0][1].icon_custom_emoji_id, "123");
  assert.equal(original.reply_markup.inline_keyboard[0][0].text, "🎧 Скачать биток");
});

test("plain text and captions keep verified animated emoji with adjusted UTF-16 offsets", () => {
  const ids = new Map([["🎧", "123"], ["✨", "456"]]);
  const text = "😀 🎧 Бит";
  const result = decorateAnimatedEmoji("sendMessage", { text }, ids);
  assert.equal(result.text, "✨ 🎧 Бит");
  assert.equal(result.entities[0].offset, 0);
  assert.equal(result.entities[0].length, 1);
  assert.equal(result.entities[1].offset, 2);
  const audio = decorateAnimatedEmoji("sendAudio", { caption: "🎧 Бит" }, ids);
  assert.equal(audio.caption, "🎧 Бит");
  assert.equal(audio.caption_entities[0].custom_emoji_id, "123");
});

test("unknown emoji get animated alternatives and reply keyboard keeps icons", () => {
  const ids = new Map([["📋", "456"]]);
  const result = decorateAnimatedEmoji("sendMessage", { text: "👀 Привет", reply_markup: { keyboard: [[{ text: "📋 Менюшка" }]] } }, ids);
  assert.equal(result.text, "📋 Привет");
  assert.equal(result.reply_markup.keyboard[0][0].text, "Менюшка");
  assert.equal(result.reply_markup.keyboard[0][0].icon_custom_emoji_id, "456");
});

test("substituting emoji keeps formatting entity positions valid", () => {
  const result = decorateAnimatedEmoji("sendMessage", {
    text: "😀 Тест", entities: [{ type: "bold", offset: 3, length: 4 }],
  }, new Map([["✨", "456"]]));
  assert.equal(result.text, "✨ Тест");
  assert.equal(result.entities[0].offset, 2);
  assert.equal(result.entities[0].length, 4);
});
