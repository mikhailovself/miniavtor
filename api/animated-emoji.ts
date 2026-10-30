// Public packs listed as animated in the CustomEmojiPacks directory.
// Sticker metadata is read from Telegram's Bot API; static and adaptive icons are excluded.
import { EMOJI_CANDIDATES } from "./emoji-candidates.js";
const PACKS = [
  "FluentEmojiSet1", "FluentEmojiSet2", "FluentEmojiSet3", "FluentEmojiSet4", "FluentEmojiSet5",
  "RestrictedEmoji", "NewsEmoji", "SignsEmoji", "HeartsEmoji", "WaterworldEmoji",
  "AnimatedAsianEmoji", "GummyBearEmoji", "ApplicationEmoji", "SparklesEmoji",
];
const segmenter = new Intl.Segmenter("ru", { granularity: "grapheme" });
const emojiGrapheme = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}\u20e3\ufe0f]/u;
function withoutEmoji(value: string): string {
  let cleaned = "";
  let removed = false;
  for (const { segment } of segmenter.segment(value)) {
    if (emojiGrapheme.test(segment)) { removed = true; continue; }
    if (removed && segment === " " && (!cleaned || /\s$/.test(cleaned))) { removed = false; continue; }
    cleaned += segment;
    removed = false;
  }
  return cleaned;
}
export const stripUnanimatedEmoji = withoutEmoji;
type Payload = Record<string, any>;
type Sticker = { type?: string; emoji?: string; custom_emoji_id?: string; is_animated?: boolean; is_video?: boolean; needs_repainting?: boolean };

let cached: Promise<Map<string, string>> | undefined;
let expires = 0;

export async function animatedEmojiIds(token: string): Promise<Map<string, string>> {
  if (cached && Date.now() < expires) return cached;
  expires = Date.now() + 3000;
  cached = (async () => {
    const setsPromise = Promise.all(PACKS.map(async name => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getStickerSet`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }), signal: AbortSignal.timeout(5000),
        });
        const data: any = await response.json();
        return data.ok && data.result?.sticker_type === "custom_emoji" ? data.result.stickers as Sticker[] : [];
      } catch { return [] as Sticker[]; }
    }));
    const candidatesPromise = (async (): Promise<Sticker[]> => {
      try {
        const custom_emoji_ids = [...new Set(Object.values(EMOJI_CANDIDATES).flat())];
        const response = await fetch(`https://api.telegram.org/bot${token}/getCustomEmojiStickers`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ custom_emoji_ids }), signal: AbortSignal.timeout(5000),
        });
        const data: any = await response.json();
        return data.ok && Array.isArray(data.result) ? data.result as Sticker[] : [];
      } catch { return []; }
    })();
    const sets = await setsPromise;
    const candidates = await candidatesPromise;
    const ids = new Map<string, string>();
    for (const sticker of candidates) {
      if (sticker.type === "custom_emoji" && sticker.emoji && sticker.custom_emoji_id &&
          EMOJI_CANDIDATES[sticker.emoji]?.includes(sticker.custom_emoji_id) &&
          (sticker.is_animated || sticker.is_video) && !sticker.needs_repainting && !ids.has(sticker.emoji)) {
        ids.set(sticker.emoji, sticker.custom_emoji_id);
      }
    }
    for (const sticker of sets.flat()) {
      if (sticker.type === "custom_emoji" && sticker.emoji && sticker.custom_emoji_id &&
          (sticker.is_animated || sticker.is_video) && !sticker.needs_repainting && !ids.has(sticker.emoji)) {
        ids.set(sticker.emoji, sticker.custom_emoji_id);
      }
    }
    expires = Date.now() + (ids.size ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000);
    console.info("Verified animated emoji", ids.size);
    return ids;
  })();
  return cached;
}

function decorateHtml(html: string, ids: Map<string, string>): string {
  const excluded: string[] = [];
  return html.split(/(<[^>]+>)/g).map(part => {
    const tag = part.match(/^<\s*(\/?)\s*(a|code|pre|tg-emoji)\b/i);
    if (tag) {
      if (tag[1]) excluded.pop(); else excluded.push(tag[2].toLowerCase());
      return part;
    }
    if (part.startsWith("<") || excluded.includes("tg-emoji")) return part;
    if (excluded.length) return withoutEmoji(part);
    let cleaned = "";
    let removed = false;
    for (const { segment } of segmenter.segment(part)) {
      const id = ids.get(segment);
      if (id) { cleaned += `<tg-emoji emoji-id="${id}">${segment}</tg-emoji>`; removed = false; continue; }
      if (emojiGrapheme.test(segment)) { removed = true; continue; }
      if (removed && segment === " " && (!cleaned || /\s$/.test(cleaned))) { removed = false; continue; }
      cleaned += segment;
      removed = false;
    }
    return cleaned;
  }).join("");
}

function decoratePlain(payload: Payload, field: "text" | "caption", ids: Map<string, string>): Payload {
  const value = payload[field];
  if (typeof value !== "string") return payload;
  const key = field === "text" ? "entities" : "caption_entities";
  const existing = Array.isArray(payload[key]) ? payload[key] : [];
  const deleted: { start: number; end: number }[] = [];
  const added: any[] = [];
  let cleaned = "";
  let removed = false;
  for (const { segment, index } of segmenter.segment(value)) {
    const id = ids.get(segment);
    if (!id && emojiGrapheme.test(segment)) {
      deleted.push({ start: index, end: index + segment.length });
      removed = true;
      continue;
    }
    if (removed && segment === " " && (!cleaned || /\s$/.test(cleaned))) {
      deleted.push({ start: index, end: index + segment.length });
      removed = false;
      continue;
    }
    const offset = cleaned.length;
    cleaned += segment;
    removed = false;
    if (id && !existing.some((entity: any) =>
      !["bold", "italic", "underline", "strikethrough", "spoiler"].includes(entity.type) &&
      index < entity.offset + entity.length && index + segment.length > entity.offset)) {
      added.push({ type: "custom_emoji", offset, length: segment.length, custom_emoji_id: id });
    }
  }
  if (!deleted.length && !added.length) return payload;
  const remap = (position: number) => position - deleted.reduce((removed, item) =>
    removed + Math.max(0, Math.min(position, item.end) - item.start), 0);
  const adjusted = existing.map((entity: any) => {
    const offset = remap(entity.offset);
    return { ...entity, offset, length: remap(entity.offset + entity.length) - offset };
  }).filter((entity: any) => entity.length > 0);
  return { ...payload, [field]: cleaned, [key]: [...adjusted, ...added] };
}

export function decorateAnimatedEmoji(method: string, original: Payload, ids: Map<string, string>): Payload {
  let payload = original;
  const keyboard = original.reply_markup;
  const rows = keyboard?.inline_keyboard ?? keyboard?.keyboard;
  if (Array.isArray(rows)) {
    const decorated = rows.map((row: any[]) => row.map(button => {
      if (typeof button.text !== "string") return button;
      const first = segmenter.segment(button.text)[Symbol.iterator]().next().value;
      const id = first && ids.get(first.segment);
      const hasPrefix = first && emojiGrapheme.test(first.segment) && /^\s/.test(button.text.slice(first.segment.length));
      const text = withoutEmoji(hasPrefix ? button.text.slice(first.segment.length).trimStart() : button.text);
      return hasPrefix && id && !button.icon_custom_emoji_id
        ? { ...button, text, icon_custom_emoji_id: id }
        : text !== button.text ? { ...button, text } : button;
    }));
    if (decorated.some((row: any[], i: number) => row.some((button, j) => button !== rows[i][j]))) {
      payload = { ...payload, reply_markup: { ...keyboard, [keyboard.inline_keyboard ? "inline_keyboard" : "keyboard"]: decorated } };
    }
  }
  const field = ["sendMessage", "editMessageText"].includes(method) ? "text" :
    ["sendPhoto", "sendVideo", "sendAnimation", "sendDocument", "sendAudio", "editMessageCaption", "copyMessage"].includes(method) ? "caption" : null;
  if (!field || typeof payload[field] !== "string") return payload;
  if (payload.parse_mode === "HTML") {
    const decorated = decorateHtml(payload[field], ids);
    return decorated === payload[field] ? payload : { ...payload, [field]: decorated };
  }
  return payload.parse_mode ? payload : decoratePlain(payload, field, ids);
}

export function plainEmojiFallback(method: string, original: Payload): Payload {
  const noAnimation = decorateAnimatedEmoji(method, original, new Map());
  const keyboard = noAnimation.reply_markup;
  const rows = keyboard?.inline_keyboard ?? keyboard?.keyboard;
  if (!Array.isArray(rows)) return noAnimation;
  const plain = rows.map((row: any[]) => row.map(button => {
    if (!button.icon_custom_emoji_id) return button;
    const { icon_custom_emoji_id: _icon, ...rest } = button;
    return rest;
  }));
  return { ...noAnimation, reply_markup: { ...keyboard, [keyboard.inline_keyboard ? "inline_keyboard" : "keyboard"]: plain } };
}
