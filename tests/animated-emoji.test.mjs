import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { EMOJI_CANDIDATES } from "../api/emoji-candidates.ts";

const source = readFileSync(new URL("../api/animated-emoji.ts", import.meta.url), "utf8")
  .replace(/^import .*\n/gm, "").replace(/^export /gm, "");
const { animatedEmojiIds, decorateAnimatedEmoji, plainEmojiFallback } = runInNewContext(
  `${stripTypeScriptTypes(source)}\n({ animatedEmojiIds, decorateAnimatedEmoji, plainEmojiFallback })`,
  { EMOJI_CANDIDATES, Intl, Map, Set, Date, Promise, AbortSignal, console,
    fetch: (...args) => globalThis.fetch(...args) },
);

test("Telegram pack loader accepts only colored animated custom emoji with exact alt", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => ({ json: async () => url.endsWith("getCustomEmojiStickers")
    ? { ok: true, result: [
      { type: "custom_emoji", emoji: "🗂", custom_emoji_id: "5431736674147114227", is_animated: true },
      { type: "custom_emoji", emoji: "📋", custom_emoji_id: "456", is_animated: true },
    ] }
    : { ok: true, result: { sticker_type: "custom_emoji", stickers: [
      { type: "custom_emoji", emoji: "🎧", custom_emoji_id: "123", is_animated: true },
      { type: "custom_emoji", emoji: "📋", custom_emoji_id: "456", is_animated: false },
      { type: "custom_emoji", emoji: "⚙️", custom_emoji_id: "789", is_video: true, needs_repainting: true },
    ] } } });
  try {
    const ids = await animatedEmojiIds("test-token");
    assert.equal(ids.get("🎧"), "123");
    assert.equal(ids.get("🗂"), "5431736674147114227");
    assert.equal(ids.has("📋"), false);
    assert.equal(ids.has("⚙️"), false);
  } finally { globalThis.fetch = previous; }
});

test("menu wording and actions stay intact while a verified animated icon is used", () => {
  const ids = new Map([["🎧", "123"]]);
  const original = { text: "<b>📋 Менюшка</b>\n\nНу че, куда?", parse_mode: "HTML", reply_markup: { inline_keyboard: [[
    { text: "🎧 Скачать биток", callback_data: "beat" },
    { text: "автор бота", callback_data: "author", icon_custom_emoji_id: "5384084295465854839" },
  ]] } };
  const result = decorateAnimatedEmoji("sendMessage", original, ids);
  assert.equal(result.text, "<b>Менюшка</b>\n\nНу че, куда?");
  assert.equal(result.reply_markup.inline_keyboard[0][0].text, "Скачать биток");
  assert.equal(result.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, "123");
  assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data, "beat");
  assert.equal(result.reply_markup.inline_keyboard[0][1].icon_custom_emoji_id, "5384084295465854839");
  assert.equal(original.reply_markup.inline_keyboard[0][0].text, "🎧 Скачать биток");
});

test("plain text and captions keep verified animated emoji with adjusted UTF-16 offsets", () => {
  const ids = new Map([["🎧", "123"]]);
  const text = "😀 🎧 Бит";
  const result = decorateAnimatedEmoji("sendMessage", { text }, ids);
  assert.equal(result.text, "🎧 Бит");
  assert.equal(result.entities[0].offset, 0);
  assert.equal(result.entities[0].length, 2);
  const audio = decorateAnimatedEmoji("sendAudio", { caption: "🎧 Бит" }, ids);
  assert.equal(audio.caption, "🎧 Бит");
  assert.equal(audio.caption_entities[0].custom_emoji_id, "123");
});

test("unknown emoji disappear and reply keyboard uses animated icons", () => {
  const ids = new Map([["📋", "456"]]);
  const result = decorateAnimatedEmoji("sendMessage", { text: "👀 Привет", reply_markup: { keyboard: [[{ text: "📋 Менюшка" }]] } }, ids);
  assert.equal(result.text, "Привет");
  assert.equal(result.reply_markup.keyboard[0][0].text, "Менюшка");
  assert.equal(result.reply_markup.keyboard[0][0].icon_custom_emoji_id, "456");
  const fallback = plainEmojiFallback("sendMessage", result);
  assert.equal(fallback.reply_markup.keyboard[0][0].icon_custom_emoji_id, undefined);
  assert.equal(fallback.reply_markup.keyboard[0][0].text, "Менюшка");
});

test("removing an unsupported emoji keeps formatting entity positions valid", () => {
  const result = decorateAnimatedEmoji("sendMessage", {
    text: "😀 Тест", entities: [{ type: "bold", offset: 3, length: 4 }],
  }, new Map());
  assert.equal(result.text, "Тест");
  assert.equal(result.entities[0].offset, 0);
  assert.equal(result.entities[0].length, 4);
});
