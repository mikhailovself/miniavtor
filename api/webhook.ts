import type { VercelRequest, VercelResponse } from "@vercel/node";

const {
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
  OWNER_ID, // твой Telegram user id: бот слушает только тебя
  GROUP_CHAT_ID, // необязательно: запасной вариант, если группа ещё не запомнена
} = process.env;

// Upstash Redis (бесплатно). Vercel сам добавляет эти переменные при подключении.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

type Note = {
  topic: string; // название топика
  title: string;
  body: string;
  emoji?: string;
  tags?: string[];
  who?: string;
  amount?: string;
  direction?: "owes_me" | "i_owe";
  deadline?: string;
};

type Topic = { id: number; name: string; desc?: string; label: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Названия, которые считаются «общим» топиком на случай, когда тема не подошла никуда
const DEFAULT_WORDS = ["заметк", "разное", "другое", "other", "notes", "inbox"];

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

async function loadTopics(): Promise<Topic[]> {
  const names = toObj(await redis(["HGETALL", "tg:topics"]));
  const descs = toObj(await redis(["HGETALL", "tg:desc"]));
  const list = Object.entries(names).map(([id, name]) => ({
    id: Number(id),
    name,
    desc: descs[id],
  }));
  const count: Record<string, number> = {};
  for (const t of list) count[t.name] = (count[t.name] ?? 0) + 1;
  return list
    .map((t) => ({ ...t, label: count[t.name] > 1 ? `${t.name} (#${t.id})` : t.name }))
    .sort((a, b) => a.id - b.id);
}

async function getDefault(): Promise<number | null> {
  const d = await redis(["GET", "tg:default"]);
  if (d) return Number(d);
  const legacy = await redis(["HGET", "tg:map", "other"]); // совместимость со старой версией
  return legacy ? Number(legacy) : null;
}

// Запоминает топик. Если название похоже на «Заметки» и запасного топика ещё нет, делает его запасным.
async function registerTopic(thread: number, name: string) {
  const known = await redis(["HGET", "tg:topics", String(thread)]);
  if (known !== name) await redis(["HSET", "tg:topics", String(thread), name]);
  let madeDefault = false;
  if (DEFAULT_WORDS.some((w) => name.toLowerCase().includes(w)) && !(await getDefault())) {
    await redis(["SET", "tg:default", String(thread)]);
    madeDefault = true;
  }
  return { madeDefault };
}

// ---------- Gemini ----------

function buildSystemPrompt(topics: Topic[], fallback: Topic | undefined): string {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
  const list = topics
    .map((t) => `- «${t.label}»${t.desc ? `: ${t.desc}` : ""}`)
    .join("\n");
  return `Ты личный секретарь владельца. Он пишет тебе сырые мысли, иногда сумбурно, с опечатками, голосом или пересланным текстом. Твоя задача: понять, о чём это, выбрать подходящий топик из списка и вызвать функцию save_note с аккуратно оформленной заметкой.

Топики его группы (выбирай только из них, название пиши ровно как в списке):
${list}

Как выбирать:
- Смотри на смысл и на название топика. «Купить» это покупки, «Идеи для YouTube» это идеи для видео и так далее.
- Если подходят два топика, выбери более конкретный.
${fallback ? `- Если ничего не подходит, выбери «${fallback.label}».` : "- Если ничего не подходит, выбери самый близкий по смыслу."}

Правила оформления:
- title: коротко, до 60 символов, без эмодзи.
- emoji: один эмодзи, подходящий по смыслу заметки.
- body: чистый русский текст, без воды, можно списки через «•». Ничего не выдумывай: если данных нет, не добавляй их. Не меняй смысл, не добавляй советов.
- Если в заметке про деньги кто-то кому-то должен, заполни who, amount (с валютой, по умолчанию ₽) и direction: "owes_me" если должны мне, "i_owe" если должен я.
- Если назван срок или дата (дело, напоминание, план), заполни deadline в формате ГГГГ-ММ-ДД, считая от сегодняшней даты.
- Ссылки оставляй как есть в body.
- Если в сообщении несколько независимых заметок, вызови save_note несколько раз.

Сегодня: ${today} (часовой пояс Москва).`;
}

async function extractNotes(text: string, topics: Topic[], fallback: Topic | undefined): Promise<Note[]> {
  const declaration = {
    name: "save_note",
    description: "Сохраняет оформленную заметку в нужный топик группы.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: topics.map((t) => t.label) },
        title: { type: "string" },
        body: { type: "string" },
        emoji: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        who: { type: "string", description: "Только для долгов" },
        amount: { type: "string", description: "Только для долгов, например '3000 ₽'" },
        direction: { type: "string", enum: ["owes_me", "i_owe"], description: "Только для долгов" },
        deadline: { type: "string", description: "Срок, ГГГГ-ММ-ДД" },
      },
      required: ["topic", "title", "body"],
    },
  };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY ?? "" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(topics, fallback) }] },
        contents: [{ role: "user", parts: [{ text }] }],
        tools: [{ functionDeclarations: [declaration] }],
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

function formatNote(n: Note): string {
  const emoji = n.emoji && n.emoji.length <= 8 ? n.emoji : "📌";
  const lines: string[] = [`${emoji} <b>${esc(n.title)}</b>`, ""];

  if (n.who || n.amount) {
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

// ---------- Статус для команды /topics ----------

async function statusText(): Promise<string> {
  const group = await getGroup();
  const topics = await loadTopics();
  const def = await getDefault();
  const lines: string[] = [];

  lines.push(group ? `Группа подключена (${group})` : "Группа пока не определена. Напиши /ids в любом топике группы.");
  lines.push("");

  if (!topics.length) {
    lines.push("Топиков пока нет. Зайди в каждый нужный топик группы и напиши там /ids.");
  } else {
    lines.push(`Топиков известно: ${topics.length}`);
    for (const t of topics) {
      lines.push(`• ${t.name}${t.id === def ? " (запасной)" : ""}${t.desc ? `: ${t.desc}` : ""}`);
    }
  }

  if (topics.length && !def) {
    lines.push("", "Запасной топик (куда класть то, что никуда не подошло) не задан. Зайди в нужный топик и напиши /default.");
  }
  if (!REDIS_URL) {
    lines.push("", "⚠️ База не подключена: бот не запоминает топики. Подключи Upstash Redis в Vercel (Storage).");
  }
  return lines.join("\n");
}

// ---------- Основной обработчик ----------

const HELP =
  "Пиши мне что угодно: идеи, долги, фильмы, дела, ссылки. Я сам выберу топик в группе и красиво оформлю.\n\n" +
  "В личке:\n" +
  "/topics: какие топики я знаю\n\n" +
  "В группе (в нужном топике, только ты):\n" +
  "/ids: запомнить этот топик\n" +
  "/desc текст: подсказать мне, что сюда класть (например «фильмы и сериалы, которые хочу посмотреть»)\n" +
  "/default: сделать этот топик запасным\n" +
  "/forget: забыть этот топик";

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
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].split("@")[0].toLowerCase();
    const arg = text.trim().slice(parts[0].length).trim();

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

      let madeDefault = false;
      if (REDIS_URL && threadId && topicName && (service || fromOwner)) {
        madeDefault = (await registerTopic(threadId, topicName)).madeDefault;
      }

      const say = (t: string) =>
        tg("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: t });

      if (fromOwner && ["/ids", "/desc", "/default", "/forget"].includes(cmd)) {
        if (!REDIS_URL) {
          await say("База не подключена. Подключи Upstash Redis в Vercel (Storage) и сделай Redeploy.");
        } else if (!threadId) {
          await say("Это общий топик (General), его я не запоминаю. Команды работают в обычных топиках.");
        } else if (cmd === "/ids") {
          if (!topicName) {
            await say(`Не вижу название этого топика (thread_id ${threadId}). Попробуй переименовать топик и снова написать /ids.`);
          } else {
            await say(
              `Запомнил «${topicName}». Теперь могу складывать сюда заметки.` +
                (madeDefault ? "\nЭтот топик стал запасным: сюда пойдёт то, что никуда не подошло." : "")
            );
          }
        } else if (cmd === "/desc") {
          if (!arg) {
            await say("Напиши так: /desc что сюда класть. Например: /desc фильмы и сериалы, которые хочу посмотреть");
          } else {
            if (topicName) await redis(["HSET", "tg:topics", String(threadId), topicName]);
            await redis(["HSET", "tg:desc", String(threadId), arg.slice(0, 300)]);
            await say("Записал подсказку для этого топика.");
          }
        } else if (cmd === "/default") {
          await redis(["SET", "tg:default", String(threadId)]);
          await say("Теперь это запасной топик: сюда пойдёт то, что никуда не подошло.");
        } else if (cmd === "/forget") {
          await redis(["HDEL", "tg:topics", String(threadId)]);
          await redis(["HDEL", "tg:desc", String(threadId)]);
          const def = await redis(["GET", "tg:default"]);
          if (def && Number(def) === threadId) await redis(["DEL", "tg:default"]);
          await say("Забыл этот топик. Чтобы вернуть, напиши /ids.");
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
    const topics = await loadTopics();

    if (!group || !topics.length) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Я ещё не знаю твои топики. Зайди в каждый нужный топик группы и напиши там /ids, потом проверь командой /topics.",
      });
      return res.status(200).send("ok");
    }

    const defId = await getDefault();
    const fallback = topics.find((t) => t.id === defId);
    const notes = await extractNotes(text, topics, fallback);

    if (!notes.length) {
      await tg("sendMessage", { chat_id: chatId, text: "Не смог разобрать, попробуй переформулировать." });
      return res.status(200).send("ok");
    }

    const saved: string[] = [];
    for (const note of notes) {
      const target = topics.find((t) => t.label === note.topic) ?? fallback;
      if (!target) {
        saved.push(`⚠️ «${note.title}»: не нашёл подходящий топик`);
        continue;
      }
      const r = await tg("sendMessage", {
        chat_id: group,
        message_thread_id: target.id,
        text: formatNote(note),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      saved.push(
        r.ok
          ? `${note.emoji && note.emoji.length <= 8 ? note.emoji : "📌"} ${target.name}: ${note.title}`
          : `⚠️ ${target.name}: не отправилось (${r.description ?? "ошибка"})`
      );
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
