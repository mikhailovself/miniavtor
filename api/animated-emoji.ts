// Public packs listed as animated in the CustomEmojiPacks directory.
// Sticker metadata is read from Telegram's Bot API; static and adaptive icons are excluded.
const PACKS = ["NewsEmoji", "SignsEmoji", "HeartsEmoji", "WaterworldEmoji", "AnimatedAsianEmoji", "GummyBearEmoji"];
const segmenter = new Intl.Segmenter("ru", { granularity: "grapheme" });
type Payload = Record<string, any>;
type Sticker = { type?: string; emoji?: string; custom_emoji_id?: string; is_animated?: boolean; is_video?: boolean; needs_repainting?: boolean };

let cached: Promise<Map<string, string>> | undefined;
let expires = 0;

export async function animatedEmojiIds(token: string): Promise<Map<string, string>> {
  if (cached && Date.now() < expires) return cached;
  expires = Date.now() + 3000;
  cached = (async () => {
    const sets = await Promise.all(PACKS.map(async name => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getStickerSet`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }), signal: AbortSignal.timeout(2500),
        });
        const data: any = await response.json();
        return data.ok && data.result?.sticker_type === "custom_emoji" ? data.result.stickers as Sticker[] : [];
      } catch { return [] as Sticker[]; }
    }));
    const ids = new Map<string, string>();
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
  let excluded = 0;
  return html.split(/(<[^>]+>)/g).map(part => {
    const tag = part.match(/^<\s*(\/?)\s*(a|code|pre|tg-emoji)\b/i);
    if (tag) { excluded += tag[1] ? -1 : 1; return part; }
    if (part.startsWith("<") || excluded > 0) return part;
    return [...segmenter.segment(part)].map(({ segment }) => {
      const id = ids.get(segment);
      return id ? `<tg-emoji emoji-id="${id}">${segment}</tg-emoji>` : segment;
    }).join("");
  }).join("");
}

function decoratePlain(payload: Payload, field: "text" | "caption", ids: Map<string, string>): Payload {
  const value = payload[field];
  if (typeof value !== "string") return payload;
  const key = field === "text" ? "entities" : "caption_entities";
  const existing = Array.isArray(payload[key]) ? payload[key] : [];
  const added = [...segmenter.segment(value)].flatMap(({ segment, index }) => {
    const id = ids.get(segment);
    if (!id || existing.some((entity: any) =>
      !["bold", "italic", "underline", "strikethrough", "spoiler"].includes(entity.type) &&
      index < entity.offset + entity.length && index + segment.length > entity.offset)) return [];
    return [{ type: "custom_emoji", offset: index, length: segment.length, custom_emoji_id: id }];
  });
  return added.length ? { ...payload, [key]: [...existing, ...added] } : payload;
}

export function decorateAnimatedEmoji(method: string, original: Payload, ids: Map<string, string>): Payload {
  if (!ids.size) return original;
  let payload = original;
  const rows = original.reply_markup?.inline_keyboard;
  if (Array.isArray(rows)) {
    const decorated = rows.map((row: any[]) => row.map(button => {
      if (button.icon_custom_emoji_id || typeof button.text !== "string") return button;
      const first = segmenter.segment(button.text)[Symbol.iterator]().next().value;
      const id = first && ids.get(first.segment);
      return id && /^\s/.test(button.text.slice(first.segment.length))
        ? { ...button, text: button.text.slice(first.segment.length).trimStart(), icon_custom_emoji_id: id }
        : button;
    }));
    if (decorated.some((row: any[], i: number) => row.some((button, j) => button !== rows[i][j]))) {
      payload = { ...payload, reply_markup: { ...original.reply_markup, inline_keyboard: decorated } };
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
