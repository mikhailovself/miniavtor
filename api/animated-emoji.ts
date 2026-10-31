// Public packs listed as animated in the CustomEmojiPacks directory.
// Sticker metadata is read from Telegram's Bot API; static and adaptive icons are excluded.
import { EMOJI_CANDIDATES } from "./emoji-candidates.js";
const PACKS = [
  "FluentEmojiSet1", "FluentEmojiSet2", "FluentEmojiSet3", "FluentEmojiSet4", "FluentEmojiSet5",
  "RestrictedEmoji", "NewsEmoji", "SignsEmoji", "HeartsEmoji", "WaterworldEmoji",
  "AnimatedAsianEmoji", "GummyBearEmoji", "ApplicationEmoji", "SparklesEmoji",
];
const segmenter = new Intl.Segmenter("ru", { granularity: "grapheme" });
// Один и тот же значок бывает записан с селектором вариации (U+FE0F) и без него: в тексте бота, в списке кандидатов
// и в ответе Telegram он может отличаться. Поэтому всё сравниваем без селектора, иначе 🎞, 🛠 или ⬅️ теряют анимацию.
const norm = (value: string) => value.replace(/️/g, "");
const CANDIDATES = new Map(Object.entries(EMOJI_CANDIDATES).map(([emoji, list]) => [norm(emoji), list] as [string, string[]]));
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
let cacheToken = "";
let lastVerified = new Map<string, string>();
const CACHE_TTL = 6 * 60 * 60 * 1000;
type CatalogCache = { read: () => Promise<unknown>; write: (value: string) => Promise<unknown> };

export async function animatedEmojiIds(token: string, storage?: CatalogCache): Promise<Map<string, string>> {
  if (cached && token === cacheToken && Date.now() < expires) return cached;
  if (cacheToken !== token) lastVerified = new Map();
  cacheToken = token;
  // A slow Telegram response must not start a second pack load in the same process.
  expires = Infinity;
  cached = (async () => {
    if (storage) {
      try {
        const raw = await storage.read();
        const snapshot = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (snapshot?.version === 1 && Number.isFinite(snapshot.at) && snapshot.at <= Date.now() &&
            snapshot.at + CACHE_TTL > Date.now() && Array.isArray(snapshot.entries) && snapshot.entries.length &&
            snapshot.entries.every((entry: any) => Array.isArray(entry) && entry.length === 2 &&
              typeof entry[0] === "string" && emojiGrapheme.test(entry[0]) && typeof entry[1] === "string" && /^\d+$/.test(entry[1]))) {
          lastVerified = new Map(snapshot.entries);
          expires = snapshot.at + CACHE_TTL;
          return lastVerified;
        }
      } catch { /* Redis outage must not prevent verification directly with Telegram. */ }
    }
    const loadSets = () => Promise.all(PACKS.map(async name => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getStickerSet`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }), signal: AbortSignal.timeout(5000),
        });
        const data: any = await response.json();
        return data.ok && data.result?.sticker_type === "custom_emoji" && Array.isArray(data.result.stickers) ? data.result.stickers as Sticker[] : [];
      } catch { return [] as Sticker[]; }
    }));
    const candidatesPromise = (async (): Promise<Sticker[]> => {
      try {
        const custom_emoji_ids = [...new Set(Object.values(EMOJI_CANDIDATES).flat())];
        const batches: Sticker[][] = await Promise.all(Array.from({ length: Math.ceil(custom_emoji_ids.length / 200) }, async (_, i) => {
          const response = await fetch(`https://api.telegram.org/bot${token}/getCustomEmojiStickers`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ custom_emoji_ids: custom_emoji_ids.slice(i * 200, (i + 1) * 200) }), signal: AbortSignal.timeout(5000),
          });
          const data: any = await response.json();
          return data.ok && Array.isArray(data.result) ? data.result as Sticker[] : [];
        }));
        return batches.flat();
      } catch { return []; }
    })();
    const candidates = await candidatesPromise;
    const ids = new Map<string, string>();
    for (const sticker of candidates) {
      if (sticker.type === "custom_emoji" && sticker.emoji && sticker.custom_emoji_id &&
          CANDIDATES.get(norm(sticker.emoji))?.includes(sticker.custom_emoji_id) &&
          (sticker.is_animated || sticker.is_video) && !sticker.needs_repainting && !ids.has(norm(sticker.emoji))) {
        ids.set(norm(sticker.emoji), sticker.custom_emoji_id);
      }
    }
    // No pack discovery is necessary once the curated catalog is fully covered.
    const sets = [...CANDIDATES.keys()].every(emoji => ids.has(emoji)) ? [] : await loadSets();
    for (const sticker of sets.flat()) {
      if (sticker.type === "custom_emoji" && sticker.emoji && sticker.custom_emoji_id &&
          (sticker.is_animated || sticker.is_video) && !sticker.needs_repainting && !ids.has(norm(sticker.emoji))) {
        ids.set(norm(sticker.emoji), sticker.custom_emoji_id);
      }
    }
    const freshlyVerified = ids.size > 0;
    expires = Date.now() + (freshlyVerified ? CACHE_TTL : 15000);
    // Keep previously verified IDs during a temporary catalog outage.
    for (const [emoji, id] of lastVerified) if (!ids.has(emoji)) ids.set(emoji, id);
    lastVerified = ids;
    if (storage && freshlyVerified) {
      try { await storage.write(JSON.stringify({ version: 1, at: Date.now(), entries: [...ids] })); }
      catch { /* The in-process catalog remains usable without Redis. */ }
    }
    console.info("Verified animated emoji", ids.size);
    // Значки из списка кандидатов, которые Telegram не подтвердил как анимированные (для них нужен другой ID или другой значок).
    const missing = [...CANDIDATES.keys()].filter(emoji => !ids.has(emoji));
    if (missing.length) console.info("Emoji using animated alternatives", missing.join(" "));
    return ids;
  })().catch(() => {
    expires = Date.now() + 15000;
    return lastVerified;
  });
  return cached;
}

const ALTERNATIVE_GROUPS = [
  "🗂 📋 📚 📄 📝 🗒 📎 📌 💾", "🎶 🎵 🎧 🎛", "🎬 🎞 📷 🖼 📹",
  "⚙ 🛠 🔧 🔨", "⬅ ➡ ⬆ ⬇ 👉 👈 👇 ☝", "✅ 👍 ☑ ✔ 🟢", "❌ 🚫 ⛔ ⚠ ❗",
  "🗑 🧹", "👤 👥 🙋 🧑‍💻 🤖", "💬 📨 💌 📣 📢 ✉ 📬", "📅 🗓 🕒 🕘 ⏳ ⏰ 🔔",
  "🔒 🔐 🔑", "🔎 🔍 👀", "📥 📤 📦", "🔗 🌍 🌐", "💡 🧠 🤔 ❓ ℹ",
  "😎 😏 🤪 😁 😂 🤣 😊 🤡 🗿 👋", "😐 🤨 🥱 😭 💀 🌚 🥴 😈", "✨ ⭐ 🌟 💫",
].map(group => group.split(" "));

function animatedIcon(emoji: string, ids: Map<string, string>): { emoji: string; id: string } {
  const exact = ids.get(norm(emoji));
  if (exact) return { emoji, id: exact };
  const alternatives = ALTERNATIVE_GROUPS.find(group => group.includes(norm(emoji))) ?? [];
  for (const alt of [...alternatives, "✨", "⭐", "💫", "💬", "👉"]) {
    const id = ids.get(alt);
    if (id) return { emoji: alt, id };
  }
  // A verified decorative icon is preferable to silently losing the intended icon.
  const first = ids.entries().next().value;
  if (first) return { emoji: first[0], id: first[1] };
  throw new Error("ANIMATED_EMOJI_UNAVAILABLE: no verified animated icons; refusing static or missing icons");
}

function decorateHtml(html: string, ids: Map<string, string>): string {
  // Never trust pre-existing tg-emoji IDs: render their alt through our verified catalog.
  html = html.replace(/<\/?tg-emoji\b[^>]*>/gi, "");
  const excluded: { name: string; tag: string }[] = [];
  return html.split(/(<[^>]+>)/g).map(part => {
    const tag = part.match(/^<\s*(\/?)\s*(a|code|pre|tg-emoji)\b/i);
    if (tag) {
      if (tag[1]) excluded.pop(); else excluded.push({ name: tag[2].toLowerCase(), tag: part });
      return part;
    }
    if (part.startsWith("<")) return part;
    // Telegram decodes numeric entities, which otherwise bypass grapheme validation.
    part = part.replace(/&#(x[0-9a-f]+|\d+);/gi, (raw, value) => {
      const point = value[0].toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value);
      if (point > 0x10ffff || point < 0) return raw;
      const decoded = String.fromCodePoint(point);
      return /[<>&\"']/.test(decoded) ? raw : decoded;
    });
    let cleaned = "";
    for (const { segment } of segmenter.segment(part)) {
      if (emojiGrapheme.test(segment)) {
        const icon = animatedIcon(segment, ids);
        // Custom emoji cannot overlap code/pre or a link entity. Keep it beside that formatting.
        cleaned += [...excluded].reverse().map(item => `</${item.name}>`).join("") +
          `<tg-emoji emoji-id="${icon.id}">${icon.emoji}</tg-emoji>` + excluded.map(item => item.tag).join("");
        continue;
      }
      cleaned += segment;
    }
    return cleaned;
  }).join("");
}

function decoratePlain(payload: Payload, field: "text" | "caption", ids: Map<string, string>): Payload {
  const value = payload[field];
  if (typeof value !== "string") return payload;
  const key = field === "text" ? "entities" : "caption_entities";
  const existing = Array.isArray(payload[key]) ? payload[key].filter((entity: any) => entity.type !== "custom_emoji") : [];
  const replacements: { start: number; end: number; length: number }[] = [];
  const added: any[] = [];
  let cleaned = "";
  for (const { segment, index } of segmenter.segment(value)) {
    const offset = cleaned.length;
    if (!emojiGrapheme.test(segment)) { cleaned += segment; continue; }
    const icon = animatedIcon(segment, ids);
    cleaned += icon.emoji;
    replacements.push({ start: index, end: index + segment.length, length: icon.emoji.length });
    added.push({ type: "custom_emoji", offset, length: icon.emoji.length, custom_emoji_id: icon.id });
  }
  if (!added.length && existing.length === (payload[key]?.length ?? 0)) return payload;
  const remap = (position: number) => position + replacements.reduce((delta, item) =>
    delta + (position >= item.end ? item.length - (item.end - item.start) : 0), 0);
  const adjusted = existing.flatMap((entity: any) => {
    const offset = remap(entity.offset);
    const end = remap(entity.offset + entity.length);
    if (["bold", "italic", "underline", "strikethrough", "spoiler"].includes(entity.type)) return [{ ...entity, offset, length: end - offset }];
    // Split non-overlapping entities around each animated icon, preserving the rest.
    let spans = [{ start: offset, end }];
    for (const icon of added) spans = spans.flatMap(span => {
      const stop = icon.offset + icon.length;
      if (stop <= span.start || icon.offset >= span.end) return [span];
      return [{ start: span.start, end: icon.offset }, { start: stop, end: span.end }].filter(s => s.end > s.start);
    });
    return spans.map(span => ({ ...entity, offset: span.start, length: span.end - span.start }));
  }).filter((entity: any) => entity.length > 0);
  return { ...payload, [field]: field === "text" && !cleaned.trim() ? "…" : cleaned, [key]: [...adjusted, ...added] };
}

// Only inspect visible content, not file IDs, callback data or URLs.
export function needsAnimatedEmoji(payload: Payload): boolean {
  return [payload.text, payload.caption].some(value => typeof value === "string" && (emojiGrapheme.test(value) || /tg-emoji|&#/i.test(value))) ||
    [payload.entities, payload.caption_entities].some(items => items?.some((item: any) => item.type === "custom_emoji")) ||
    (payload.reply_markup?.inline_keyboard ?? payload.reply_markup?.keyboard ?? []).flat().some((button: any) =>
      typeof button === "string" ? emojiGrapheme.test(button) : button.icon_custom_emoji_id || emojiGrapheme.test(button.text ?? "")) ||
    (Array.isArray(payload.media) ? payload.media : payload.media ? [payload.media] : []).some(needsAnimatedEmoji);
}

export function decorateAnimatedEmoji(method: string, original: Payload, ids: Map<string, string>): Payload {
  let payload = original;
  const keyboard = original.reply_markup;
  const rows = keyboard?.inline_keyboard ?? keyboard?.keyboard;
  if (Array.isArray(rows)) {
    const verifiedIds = new Set(ids.values());
    const decorated = rows.map((row: any[]) => row.map(originalButton => {
      const button = typeof originalButton === "string" ? { text: originalButton } : originalButton;
      if (typeof button.text !== "string") return button;
      const firstEmoji = [...segmenter.segment(button.text)].find(item => emojiGrapheme.test(item.segment));
      const text = withoutEmoji(button.text).trim();
      const { icon_custom_emoji_id: previous, ...rest } = button;
      const icon = verifiedIds.has(previous) ? previous : firstEmoji || previous ? animatedIcon(firstEmoji?.segment ?? "✨", ids).id : undefined;
      return { ...rest, text: text.trim() ? text : "Открыть", ...(icon ? { icon_custom_emoji_id: icon } : {}) };
    }));
    if (decorated.some((row: any[], i: number) => row.some((button, j) => button !== rows[i][j]))) {
      payload = { ...payload, reply_markup: { ...keyboard, [keyboard.inline_keyboard ? "inline_keyboard" : "keyboard"]: decorated } };
    }
  }
  if (payload.media) payload = { ...payload, media: Array.isArray(payload.media)
    ? payload.media.map((item: Payload) => decorateAnimatedEmoji("media", item, ids))
    : decorateAnimatedEmoji("media", payload.media, ids) };
  const field = typeof payload.text === "string" ? "text" : typeof payload.caption === "string" ? "caption" : null;
  if (!field || typeof payload[field] !== "string") return payload;
  if (payload.parse_mode === "HTML") {
    const decorated = decorateHtml(payload[field], ids);
    return { ...payload, [field]: field === "text" && !decorated.replace(/<[^>]+>/g, "").trim() ? "…" : decorated };
  }
  // No current UI uses Markdown. Reject future unsupported formatting instead of dropping icons.
  if (payload.parse_mode) {
    if (emojiGrapheme.test(payload[field])) throw new Error("Animated emoji require HTML or entities, not Markdown");
    return payload;
  }
  return decoratePlain(payload, field, ids);
}

