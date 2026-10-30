import { CUSTOM_EMOJI_IDS } from "./emoji-map.js";
import { EXTRA_CUSTOM_EMOJI_IDS } from "./emoji-extra.js";

type Button = { text: string; icon_custom_emoji_id?: string; [key: string]: unknown };
type Payload = Record<string, any>;

const segmenter = new Intl.Segmenter("ru", { granularity: "grapheme" });
const textMethods = new Set(["sendMessage", "editMessageText"]);
const captionMethods = new Set([
  "sendPhoto", "sendVideo", "sendAnimation", "sendDocument", "sendAudio",
  "editMessageCaption", "copyMessage",
]);
// https://github.com/Zulut30/premium-telegram-emoji/blob/main/references/emoji-catalog.md
const SELECTED_EMOJI_IDS: Record<string, string> = {
  "📋": "5877301185639091664",
  "↩️": "5875082500023258804",
};

function emojiId(emoji: string): string | undefined {
  return SELECTED_EMOJI_IDS[emoji] ?? CUSTOM_EMOJI_IDS[emoji] ?? EXTRA_CUSTOM_EMOJI_IDS[emoji] ??
    CUSTOM_EMOJI_IDS[emoji.replace(/\uFE0F/g, "")] ?? EXTRA_CUSTOM_EMOJI_IDS[emoji.replace(/\uFE0F/g, "")] ??
    CUSTOM_EMOJI_IDS[emoji + "\uFE0F"] ?? EXTRA_CUSTOM_EMOJI_IDS[emoji + "\uFE0F"];
}

function emojiSegments(text: string) {
  return [...segmenter.segment(text)].filter(part => emojiId(part.segment));
}

function decorateHtml(html: string): string {
  let excluded = 0;
  return html.split(/(<[^>]+>)/g).map(part => {
    const tag = part.match(/^<\s*(\/?)\s*(a|code|pre|tg-emoji)\b/i);
    if (tag) {
      excluded += tag[1] ? -1 : 1;
      return part;
    }
    if (part.startsWith("<") || excluded > 0) return part;
    return [...segmenter.segment(part)].map(({ segment }) => {
      const id = emojiId(segment);
      return id ? `<tg-emoji emoji-id="${id}">${segment}</tg-emoji>` : segment;
    }).join("");
  }).join("");
}

function decoratePlain(payload: Payload, field: "text" | "caption"): Payload {
  const value = payload[field];
  if (typeof value !== "string") return payload;
  const key = field === "text" ? "entities" : "caption_entities";
  const existing = Array.isArray(payload[key]) ? payload[key] : [];
  const additions = emojiSegments(value).filter(({ index, segment }) =>
    !existing.some((entity: any) =>
      !["bold", "italic", "underline", "strikethrough", "spoiler"].includes(entity.type) &&
      index < entity.offset + entity.length && index + segment.length > entity.offset,
    ),
  ).map(({ index, segment }) => ({
    type: "custom_emoji", offset: index, length: segment.length,
    custom_emoji_id: emojiId(segment),
  }));
  return additions.length ? { ...payload, [key]: [...existing, ...additions] } : payload;
}

function decorateButton(button: Button): Button {
  if (button.icon_custom_emoji_id || !button.text) return button;
  const first = segmenter.segment(button.text)[Symbol.iterator]().next().value;
  if (!first || first.index !== 0) return button;
  const id = emojiId(first.segment);
  if (!id || !/^\s/.test(button.text.slice(first.segment.length))) return button;
  return { ...button, text: button.text.slice(first.segment.length).trimStart(), icon_custom_emoji_id: id };
}

export function decorateTelegramPayload(method: string, original: Payload): Payload {
  let payload = original;
  const keyboard = payload.reply_markup;
  if (keyboard?.inline_keyboard || keyboard?.keyboard) {
    const key = keyboard.inline_keyboard ? "inline_keyboard" : "keyboard";
    const rows = keyboard[key].map((row: Button[]) => row.map(decorateButton));
    if (rows.some((row: Button[], i: number) => row.some((button, j) => button !== keyboard[key][i][j]))) {
      payload = { ...payload, reply_markup: { ...keyboard, [key]: rows } };
    }
  }
  const field = textMethods.has(method) ? "text" : captionMethods.has(method) ? "caption" : null;
  if (field && typeof payload[field] === "string") {
    if (payload.parse_mode === "HTML") {
      const decorated = decorateHtml(payload[field]);
      if (decorated !== payload[field]) payload = { ...payload, [field]: decorated };
    } else if (!payload.parse_mode) {
      payload = decoratePlain(payload, field);
    }
  }
  return payload;
}
