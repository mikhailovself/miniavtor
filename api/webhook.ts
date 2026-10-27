import type { VercelRequest, VercelResponse } from "@vercel/node";

const {
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
  OWNER_ID, // твой Telegram user id: бот слушает только тебя
  GROUP_CHAT_ID, // необязательно: запасной вариант, если нет базы
  TOPICS, // необязательно: запасной вариант, если нет базы
} = process.env;

// Upstash Redis (бесплатно). Vercel сам добавляет эти переменные при подключении.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

type TopicKey = "movies" | "debts" | "tracks" | "ttd" | "other";

const TOPIC_META: Record<TopicKey, { emoji: string; label: string }> = {
  movies: { emoji: "🎬", label: "Кино" },
  debts: { emoji: "💸", label: "Долги" },
  tracks: { emoji: "🎧", label: "Идеи для треков" },
  ttd: { emoji: "✅", label: "ТТД" },
  other: { emoji: "📝", label: "Заметки" },
};
const KEYS = Object.keys(TOPIC_META) as TopicKey[];

// По каким словам в названии топика бот понимает, к какой теме он относится
const KEYWORDS: Record<TopicKey, string[]> = {
  movies: ["кино", "фильм", "сериал", "movie", "film"],
  debts: ["долг", "должн", "debt"],
  tracks: ["трек", "музык", "бит", "track", "music"],
  ttd: ["ттд", "ttd", "дела", "задач", "todo"],
  other: ["заметк", "разное", "другое", "other", "notes"],
};

function guessCategory(name: string): TopicKey | null {
  const n = name.toLowerCase();
  for (const k of KEYS) if (KEYWORDS[k].some((w) => n.includes(w))) return k;
  return null;
}

const SYSTEM_PROMPT = `Ты личный секретарь владельца. Он пишет тебе сырые мысли, иногда сумбурно, с опечатками, голосом или пересланным текстом. Твоя задача: понять, о чём это, выбрать тему и вызвать функцию save_note с аккуратно оформленной заметкой.

Темы:
- movies: фильмы, сериалы, мультфильмы, которые хочется посмотреть. Укажи название, год если знаешь, кто посоветовал и почему интересно.
- debts: кто кому должен денег. Заполни who, amount (число с валютой, по умолчанию ₽) и direction: "owes_me" если должны мне, "i_owe" если должен я. В body коротко за что.
- tracks: идеи для музыки: строчки, темы, референсы, настроение, биты. Сохрани мысль как есть, но чище.
- ttd: дела и задачи (things to do). Если названа дата или срок, укажи в deadline в формате ГГГГ-ММ-ДД, считая от сегодняшней даты. Если дел несколько, оформи списком в body.
- other: всё, что не подходит выше.

Правила оформления:
- title: коротко, до 60 символов, без эмодзи.
- body: чистый русский текст, без воды, можно списки через "•". Ничего не выдумывай: если данных нет, не добавляй их.
- Не меняй смысл и не добавляй советов.
- Если в сообщении несколько независимых заметок, вызови save_note несколько раз.
- Если сообщение вообще непонятно и тему выбрать невозможно, всё равно сохрани в other.

Сегодня: {{TODAY}} (часовой пояс Москва).`;

const functionDeclaration = {
  name: "save_note",
  description: "Сохраняет оформленную заметку в нужную тему группы.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", enum: KEYS },
      title: { type: "string" },
      body: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      who: { type: "string", description: "Только для debts" },
      amount: { type: "string", description: "Только для debts, например '3000 ₽'" },
      direction: { type: "string", enum: ["owes_me", "i_owe"], description: "Только для debts" },
      deadline: { type: "string", description: "Только для ttd, ГГГГ-ММ-ДД" },
    },
    required: ["topic", "title", "body"],
  },
};

type Note = {
  topic: TopicKey;
  title: string;
  body: string;
  tags?: string[];
  who?: string;
  amount?: string;
  direction?: "owes_me" | "i_owe";
  deadline?: string;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Telegram ----------

async function tg(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) console.error("Telegram error", method, data);
  return data;
}

// ---------- Хранилище (Upstash Redis через REST) ----------

async function redis(cmd: (string | number)[]): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const d = await r.json();
  if (d.error) console.error("Redis error", d.error);
  return d.result ?? null;
}

function toObj(r: any): Record<string, string> {
  if (!r) return {};
  if (Array.isArray(r)) {
    const o: Record<string, string> = {};
    for (let i = 0; i < r.length; i += 2) o[r[i]] = r[i + 1];
    return o;
  }
  return r;
}

async function getGroup(): Promise<string | null> {
  const g = await redis(["GET", "tg:group"]);
  if (g) return String(g);
  return GROUP_CHAT_ID && GROUP_CHAT_ID !== "0" ? GROUP_CHAT_ID : null;
}

async function getMap(): Promise<Partial<Record<TopicKey, number>>> {
  const map: Partial<Record<TopicKey, number>> = {};
  try {
    const env = JSON.parse(TOPICS ?? "{}");
    for (const k of KEYS) if (Number(env[k]) > 0) map[k] = Number(env[k]);
  } catch {}
  const fromDb = toObj(await redis(["HGETALL", "tg:map"]));
  for (const k of KEYS) if (Number(fromDb[k]) > 0) map[k] = Number(fromDb[k]);
  return map;
}

async function getTopicNames(): Promise<Record<string, string>> {
  return toObj(await redis(["HGETALL", "tg:topics"]));
}

// Запоминает топик и пытается сама привязать его к теме по названию
async function registerTopic(thread: number, name: string) {
  const known = await redis(["HGET", "tg:topics", String(thread)]);
  if (known !== name) await redis(["HSET", "tg:topics", String(thread), name]);
  const cat = guessCategory(name);
  let bound = false;
  if (cat) {
    const cur = await redis(["HGET", "tg:map", cat]);
    if (!cur) {
      await redis(["HSET", "tg:map", cat, String(thread)]);
      bound = true;
    } else {
      bound = String(cur) === String(thread);
    }
  }
  return { cat, bound };
}

// ---------- Оформление и Gemini ----------

function formatNote(n: Note): string {
  const meta = TOPIC_META[n.topic] ?? TOPIC_META.other;
  const lines: string[] = [`${meta.emoji} <b>${esc(n.title)}</b>`, ""];

  if (n.topic === "debts" && (n.who || n.amount)) {
    const who = n.who ? esc(n.who) : "?";
    const amount = n.amount ? esc(n.amount) : "";
    lines.push(
      n.direction === "i_owe"
        ? `Ты должен: <b>${who}</b>, ${amount}`
        : `<b>${who}</b> должен тебе ${amount}`
    );
  }

  if (n.body) lines.push(esc(n.body));
  if (n.deadline) lines.push("", `📅 До: ${esc(n.deadline)}`);
  if (n.tags?.length) {
    lines.push("", n.tags.map((t) => `#${esc(t.replace(/\s+/g, "_").replace(/^#/, ""))}`).join(" "));
  }
  return lines.join("\n");
}

async function extractNotes(text: string): Promise<Note[]> {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY ?? "" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT.replace("{{TODAY}}", today) }] },
        contents: [{ role: "user", parts: [{ text }] }],
        tools: [{ functionDeclarations: [functionDeclaration] }],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["save_note"] } },
      }),
    }
  );
  const data = await r.json();
  if (!r.ok) {
    console.error("Gemini error", r.status, JSON.stringify(data));
    throw new Error("Gemini request failed");
  }
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.functionCall?.name === "save_note")
    .map((p) => p.functionCall.args as Note);
}

// ---------- Статус для команды /topics ----------

async function statusText(): Promise<string> {
  const group = await getGroup();
  const map = await getMap();
  const names = await getTopicNames();
  const lines: string[] = [];

  lines.push(group ? `Группа: ${group}` : "Группа пока не определена. Напиши любое сообщение в своей группе (или /ids в топике).");
  lines.push("");
  lines.push("Куда что попадает:");
  for (const k of KEYS) {
    const t = map[k];
    lines.push(
      `${TOPIC_META[k].emoji} ${TOPIC_META[k].label}: ` +
        (t ? `«${names[String(t)] ?? "?"}» (${t})` : "не привязано ⚠️")
    );
  }

  const boundIds = new Set(Object.values(map).map(String));
  const free = Object.entries(names).filter(([id]) => !boundIds.has(id));
  if (free.length) {
    lines.push("", "Топики без привязки:");
    for (const [id, n] of free) lines.push(`• «${n}» (${id})`);
  }

  const unbound = KEYS.filter((k) => !map[k]);
  if (unbound.length) {
    lines.push(
      "",
      "Чтобы привязать вручную, зайди в нужный топик и напиши /bind и тему: " + KEYS.join(", ") + "."
    );
  }
  if (!REDIS_URL) {
    lines.push("", "⚠️ База не подключена: бот не запоминает топики. Подключи Upstash Redis в Vercel (Storage).");
  }
  return lines.join("\n");
}

// ---------- Основной обработчик ----------

const HELP =
  "Пиши мне что угодно: кино, долги, идеи для треков, дела. Я разложу всё по темам в группе.\n\n" +
  "Команды:\n" +
  "/topics: показать, куда что попадает\n\n" +
  "В группе (в нужном топике):\n" +
  "/ids: запомнить этот топик\n" +
  "/bind тема: привязать топик вручную (movies, debts, tracks, ttd, other)";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(200).send("ok");

  // Проверяем, что запрос реально от Telegram
  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  try {
    const msg = req.body?.message;
    if (!msg) return res.status(200).send("ok");

    const chatId = msg.chat.id;
    const fromOwner = String(msg.from?.id) === String(OWNER_ID);
    const text: string = msg.text ?? msg.caption ?? "";
    const cmd = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

    // ===== Сообщения в группе =====
    if (msg.chat.type !== "private") {
      let group = await getGroup();
      // Группу запоминаем только если пишет владелец, чужие группы игнорируем
      if (group ? String(chatId) !== group : !fromOwner) return res.status(200).send("ok");
      if (!group) {
        await redis(["SET", "tg:group", String(chatId)]);
        group = String(chatId);
      }

      const threadId: number | undefined = msg.message_thread_id;
      const service = Boolean(msg.forum_topic_created || msg.forum_topic_edited);
      const topicName: string | undefined =
        msg.forum_topic_created?.name ??
        msg.forum_topic_edited?.name ??
        msg.reply_to_message?.forum_topic_created?.name;

      let learned: { cat: TopicKey | null; bound: boolean } | null = null;
      if (REDIS_URL && threadId && topicName && (service || fromOwner)) {
        learned = await registerTopic(threadId, topicName);
      }

      const say = (t: string) =>
        tg("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: t });

      if (cmd === "/ids" && fromOwner) {
        if (!REDIS_URL) {
          await say(`chat_id: ${chatId}\nthread_id: ${threadId ?? "нет"}\n\nБаза не подключена, впиши эти числа в Vercel вручную.`);
        } else if (!threadId) {
          await say("Это общий топик (General), его я не запоминаю. Создай отдельный топик, например «Заметки».");
        } else if (!topicName) {
          await say(`Не вижу название топика (thread_id ${threadId}). Привяжи вручную: /bind movies, debts, tracks, ttd или other.`);
        } else if (!learned?.cat) {
          await say(`Запомнил топик «${topicName}» (${threadId}), но не понял, к какой теме он относится. Напиши /bind movies, debts, tracks, ttd или other.`);
        } else if (!learned.bound) {
          await say(`Топик «${topicName}» запомнил, но тема «${TOPIC_META[learned.cat].label}» уже привязана к другому топику. Чтобы перепривязать сюда: /bind ${learned.cat}`);
        } else {
          await say(`Готово: «${topicName}» (${threadId}) → ${TOPIC_META[learned.cat].emoji} ${TOPIC_META[learned.cat].label}`);
        }
      } else if (cmd === "/bind" && fromOwner) {
        const key = text.trim().split(/\s+/)[1]?.toLowerCase() as TopicKey | undefined;
        if (!REDIS_URL) {
          await say("База не подключена, привязывать некуда. Подключи Upstash Redis в Vercel (Storage).");
        } else if (!threadId) {
          await say("В общем топике (General) привязать нельзя. Создай отдельный топик.");
        } else if (!key || !KEYS.includes(key)) {
          await say("Напиши так: /bind movies (или debts, tracks, ttd, other)");
        } else {
          await redis(["HSET", "tg:map", key, String(threadId)]);
          if (topicName) await redis(["HSET", "tg:topics", String(threadId), topicName]);
          await say(`Привязал этот топик к теме ${TOPIC_META[key].emoji} ${TOPIC_META[key].label}`);
        }
      }
      return res.status(200).send("ok");
    }

    // ===== Личка: только владелец =====
    if (!fromOwner) return res.status(200).send("ok");

    if (cmd === "/start" || cmd === "/help") {
      await tg("sendMessage", { chat_id: chatId, text: HELP });
      return res.status(200).send("ok");
    }

    if (cmd === "/topics") {
      await tg("sendMessage", { chat_id: chatId, text: await statusText() });
      return res.status(200).send("ok");
    }

    if (!text.trim()) {
      await tg("sendMessage", { chat_id: chatId, text: "Пока понимаю только текст (и подписи к фото)." });
      return res.status(200).send("ok");
    }

    const group = await getGroup();
    if (!group) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Я ещё не знаю твою группу. Напиши любое сообщение в группе (лучше /ids в нужном топике), потом повтори.",
      });
      return res.status(200).send("ok");
    }

    const map = await getMap();
    const notes = await extractNotes(text);

    if (!notes.length) {
      await tg("sendMessage", { chat_id: chatId, text: "Не смог разобрать, попробуй переформулировать." });
      return res.status(200).send("ok");
    }

    const saved: string[] = [];
    for (const note of notes) {
      const meta = TOPIC_META[note.topic] ?? TOPIC_META.other;
      const direct = map[note.topic];
      const thread = direct ?? map.other;

      const r = await tg("sendMessage", {
        chat_id: group,
        ...(thread ? { message_thread_id: thread } : {}),
        text: formatNote(note),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });

      if (!r.ok) {
        saved.push(`⚠️ ${meta.label}: не отправилось (${r.description ?? "ошибка"})`);
      } else if (!direct) {
        saved.push(`${meta.emoji} ${meta.label}: ${note.title} (топик не привязан, положил в «Заметки»; смотри /topics)`);
      } else {
        saved.push(`${meta.emoji} ${meta.label}: ${note.title}`);
      }
    }

    await tg("sendMessage", { chat_id: chatId, text: `Записал:\n${saved.join("\n")}` });
  } catch (e) {
    console.error(e);
    // Всё равно отвечаем 200, иначе Telegram будет слать сообщение повторно
    const chatId = req.body?.message?.chat?.id;
    const isPrivate = req.body?.message?.chat?.type === "private";
    if (chatId && isPrivate) await tg("sendMessage", { chat_id: chatId, text: "Что-то сломалось, глянь логи в Vercel." });
  }

  return res.status(200).send("ok");
}
