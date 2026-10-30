import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { CUSTOM_EMOJI_IDS } from "../api/emoji-map.ts";
import { EXTRA_CUSTOM_EMOJI_IDS } from "../api/emoji-extra.ts";

const source = readFileSync(new URL("../api/emoji.ts", import.meta.url), "utf8")
  .replace(/^import .*\n/gm, "")
  .replace(/^export /gm, "");
const { decorateTelegramPayload } = runInNewContext(
  `${stripTypeScriptTypes(source)}\n({ decorateTelegramPayload })`,
  { CUSTOM_EMOJI_IDS, EXTRA_CUSTOM_EMOJI_IDS, Intl, Set },
);

test("custom emoji keep HTML formatting and leave code untouched", () => {
  const text = "<b>🎧 Скачать биток</b> <code>👍 BPM</code> <a href=\"https://example.org\">🔗 ссылка</a>";
  const result = decorateTelegramPayload("sendMessage", { text, parse_mode: "HTML" });
  assert.match(result.text, /<b><tg-emoji emoji-id="\d+">🎧<\/tg-emoji> Скачать биток<\/b>/);
  assert.match(result.text, /<code>👍 BPM<\/code>/);
  assert.match(result.text, /<a href="https:\/\/example.org">🔗 ссылка<\/a>/);
});

test("plain text uses UTF-16 offsets without changing the message", () => {
  const text = "😀 🎧 Бит";
  const result = decorateTelegramPayload("sendMessage", { text });
  assert.equal(result.text, text);
  assert.equal(result.entities[1].offset, 3);
  assert.equal(result.entities[1].length, 2);
});

test("button emoji become native icons without changing actions", () => {
  const original = { reply_markup: { inline_keyboard: [[
    { text: "🎧 Скачать биток", callback_data: "beat" },
    { text: "автор бота", callback_data: "author", icon_custom_emoji_id: "5384084295465854839" },
  ]] } };
  const result = decorateTelegramPayload("sendMessage", original);
  assert.equal(result.reply_markup.inline_keyboard[0][0].text, "Скачать биток");
  assert.match(result.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, /^\d+$/);
  assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data, "beat");
  assert.equal(result.reply_markup.inline_keyboard[0][1].icon_custom_emoji_id, "5384084295465854839");
  assert.equal(original.reply_markup.inline_keyboard[0][0].text, "🎧 Скачать биток");
});

test("captions get custom emoji entities without changing their text", () => {
  const original = { caption: "🎧 Бит · 87 BPM" };
  const result = decorateTelegramPayload("sendAudio", original);
  assert.equal(result.caption, original.caption);
  assert.equal(result.caption_entities[0].offset, 0);
  assert.equal(result.caption_entities[0].custom_emoji_id, CUSTOM_EMOJI_IDS["🎧"] ?? EXTRA_CUSTOM_EMOJI_IDS["🎧"]);
});

test("existing links and custom emoji entities are left alone", () => {
  const original = { text: "🔗 сайт 🎧", entities: [
    { type: "text_link", offset: 0, length: 7, url: "https://example.org" },
  ] };
  const result = decorateTelegramPayload("sendMessage", original);
  assert.equal(result.entities.length, 2);
  assert.equal(result.entities[1].offset, 8);
});
