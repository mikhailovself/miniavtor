import test from "node:test";
import assert from "node:assert/strict";
import { animatedEmojiIds, decorateAnimatedEmoji } from "../api/animated-emoji.ts";

test("Telegram pack loader accepts only colored animated custom emoji with exact alt", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: {
    sticker_type: "custom_emoji", stickers: [
      { type: "custom_emoji", emoji: "🎧", custom_emoji_id: "123", is_animated: true },
      { type: "custom_emoji", emoji: "📋", custom_emoji_id: "456", is_animated: false },
      { type: "custom_emoji", emoji: "⚙️", custom_emoji_id: "789", is_video: true, needs_repainting: true },
    ],
  } }) });
  try {
    const ids = await animatedEmojiIds("test-token");
    assert.equal(ids.get("🎧"), "123");
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
  assert.equal(result.text, original.text);
  assert.equal(result.reply_markup.inline_keyboard[0][0].text, "Скачать биток");
  assert.equal(result.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, "123");
  assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data, "beat");
  assert.equal(result.reply_markup.inline_keyboard[0][1].icon_custom_emoji_id, "5384084295465854839");
  assert.equal(original.reply_markup.inline_keyboard[0][0].text, "🎧 Скачать биток");
});

test("plain text and captions retain their content and UTF-16 emoji offsets", () => {
  const ids = new Map([["🎧", "123"]]);
  const text = "😀 🎧 Бит";
  const result = decorateAnimatedEmoji("sendMessage", { text }, ids);
  assert.equal(result.text, text);
  assert.equal(result.entities[0].offset, 3);
  assert.equal(result.entities[0].length, 2);
  const audio = decorateAnimatedEmoji("sendAudio", { caption: "🎧 Бит" }, ids);
  assert.equal(audio.caption, "🎧 Бит");
  assert.equal(audio.caption_entities[0].custom_emoji_id, "123");
});
