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

const MENU_BUTTON_TEXT = "📋 Менюшка";
const MENU_BUTTON_TEXTS = ["📋 Менюшка", "📋 Меню"]; // старая кнопка тоже работает

const GROUP_COMMANDS = ["/ids", "/desc", "/default", "/forget"];

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
  const isNew = known !== name;
  if (isNew) await redis(["HSET", "tg:topics", String(thread), name]);
  let madeDefault = false;
  if (DEFAULT_WORDS.some((w) => name.toLowerCase().includes(w)) && !(await getDefault())) {
    await redis(["SET", "tg:default", String(thread)]);
    madeDefault = true;
  }
  return { madeDefault, isNew };
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
- body: коротко, без воды, можно списки через «•». Ничего не выдумывай: если данных нет, не добавляй их. Не меняй смысл, не добавляй советов.

Стиль (это важно): ты маленький неряшливый дурачок-секретарь. Пиши title и body дурашливо, по-детски, с лёгкими шутками и парой настоящих глупых ошибок на заметку (например «щас», «чё», «каторый», «ихний», «пажалуста», «нипанятно», «тапик»). Ошибок немного, 1-3 на заметку, текст должен читаться легко. Эмодзи в тексте можно, но чуть-чуть.
Но там, где важна точность, никаких ошибок и шуток над написанием: имена людей, суммы, даты, названия фильмов, сериалов, игр и треков, ссылки, номера, теги и значения полей who, amount, deadline пиши абсолютно точно. Смысл заметки сохраняй полностью.
- Если в заметке про деньги кто-то кому-то должен, заполни who, amount (с валютой, по умолчанию ₽) и direction: "owes_me" если должны мне, "i_owe" если должен я.
- Если назван срок или дата (дело, напоминание, план), заполни deadline в формате ГГГГ-ММ-ДД, считая от сегодняшней даты.
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

const safeEmoji = (e?: string) => (e && e.length <= 8 ? e : "📌");

// Заметки в группе пишем дурашливо, но имена, суммы, даты и ссылки модель переносит точно (см. промпт)
function formatNote(n: Note): string {
  const lines: string[] = [`${safeEmoji(n.emoji)} <b>${esc(n.title)}</b>`, ""];

  if (n.who || n.amount) {
    const who = n.who ? esc(n.who) : "?";
    const amount = n.amount ? esc(n.amount) : "";
    lines.push(
      n.direction === "i_owe"
        ? `Ты должен (ой): <b>${who}</b>, ${amount}`
        : `<b>${who}</b> должон тибе ${amount}`
    );
  }

  if (n.body) lines.push(esc(n.body));
  if (n.deadline) lines.push("", `📅 Успей до: ${esc(n.deadline)}`);
  if (n.tags?.length) {
    lines.push("", n.tags.map((t) => `#${esc(t.replace(/\s+/g, "_").replace(/^#/, ""))}`).join(" "));
  }
  return lines.join("\n");
}

// ---------- Меню (кнопки) ----------

type Button = { text: string; callback_data: string };
type View = { text: string; kb: { inline_keyboard: Button[][] } };

const btn = (text: string, data: string): Button => ({ text, callback_data: data });
const backBtn = (data = "menu", text = "◀️ Назад"): Button => btn(text, data);

async function mainView(): Promise<View> {
  const group = await getGroup();
  const topics = await loadTopics();
  const defId = await getDefault();
  const def = topics.find((t) => t.id === defId);

  let text =
    "<b>Менюшка</b> 🤪\n\n" +
    `Групка: ${group ? "падключена ✅" : "не падключена, ой ⚠️"}\n` +
    `Тапиков: ${topics.length}\n` +
    `Запаснай тапик: ${def ? esc(def.name) : "нету"}`;
  if (!REDIS_URL) {
    text += "\n\n⚠️ Базы нету, я всё забываю как рыбка. Падключи Upstash Redis в Vercel (Storage).";
  }
  text += "\n\nЧтобы я записал заметку, просто пиши мне сообщение. Я панимаю (почти).";

  return {
    text,
    kb: {
      inline_keyboard: [
        [btn("📂 Мои тапики", "topics")],
        [btn("⭐ Запаснай тапик", "defmenu"), btn("➕ Добавить тапик", "add")],
        [btn("❓ Памагите", "help")],
      ],
    },
  };
}

async function topicsView(): Promise<View> {
  const topics = await loadTopics();
  const defId = await getDefault();
  if (!topics.length) {
    return {
      text:
        "Тапиков пока нету 😢\n\n" +
        "Зайди в нужнай тапик в группе и напиши там любое сообщение (или /ids). Я запомню, чесна-чесна. Один раз на тапик.",
      kb: { inline_keyboard: [[backBtn("menu", "◀️ В менюшку")]] },
    };
  }
  const rows: Button[][] = topics.map((t) => [btn(`${t.id === defId ? "⭐ " : ""}${t.name}`, `t:${t.id}`)]);
  rows.push([backBtn("menu", "◀️ В менюшку")]);
  return {
    text: `<b>Мои тапики</b> (${topics.length})\n\nТыкни на тапик, будем его настраивать, хихи.`,
    kb: { inline_keyboard: rows },
  };
}

async function topicView(id: number): Promise<View> {
  const topics = await loadTopics();
  const t = topics.find((x) => x.id === id);
  if (!t) return topicsView();
  const defId = await getDefault();
  const isDef = t.id === defId;

  const rows: Button[][] = [];
  rows.push([btn("✏️ Падсказка для меня", `d:${id}`), ...(t.desc ? [btn("🧹 Убрать", `dc:${id}`)] : [])]);
  if (!isDef) rows.push([btn("⭐ Сделать запасным", `s:${id}`)]);
  rows.push([btn("🧪 Праверить связь", `x:${id}`), btn("🗑 Забыть", `f:${id}`)]);
  rows.push([backBtn("topics", "◀️ К тапикам")]);

  return {
    text:
      `<b>${esc(t.name)}</b>${isDef ? " ⭐ запаснай" : ""}\n\n` +
      `Падсказка для меня: ${t.desc ? esc(t.desc) : "нету"}\n\n` +
      "Падсказка помогает мне панять, чё сюда класть. А то я путаю, я маленький.",
    kb: { inline_keyboard: rows },
  };
}

async function defView(): Promise<View> {
  const topics = await loadTopics();
  const defId = await getDefault();
  const rows: Button[][] = topics.map((t) => [btn(`${t.id === defId ? "✅ " : ""}${t.name}`, `s:${t.id}`)]);
  rows.push([backBtn("menu", "◀️ В менюшку")]);
  return {
    text: "<b>Запаснай тапик</b>\n\nСюда я кидаю всё, чё не смог панять куда деть. Выбири тапик:",
    kb: { inline_keyboard: rows },
  };
}

const addView = (): View => ({
  text:
    "<b>Как добавить тапик</b>\n\n" +
    "1. Зайди в нужнай тапик в группе.\n" +
    "2. Напиши там любое сообщение (или /ids).\n" +
    "3. Я поставлю 🤪 и запомню.\n\n" +
    "Новые тапики, каторые ты создашь потом, я замечу сам. Старые надо показать один раз: я их не вижу, у меня лапки.",
  kb: { inline_keyboard: [[backBtn("menu", "◀️ В менюшку")]] },
});

const helpView = (): View => ({
  text:
    "<b>Памагите, как этим пользоваться</b>\n\n" +
    "Пиши мне в личку чё угодна: идеи, долги, фильмы, дела, ссылки. Я сам выберу тапик в группе и оформлю заметку (ну я старааюсь).\n\n" +
    "Если я кладу заметки не туда, зайди в «Мои тапики», выбири тапик и задай «Падсказку для меня»: коротко, чё сюда класть.\n\n" +
    "В группе (в нужном тапике) работают команды:\n" +
    "/ids: запомнить тапик\n" +
    "/desc текст: падсказка для тапика\n" +
    "/default: сделать тапик запасным\n" +
    "/forget: забыть тапик",
  kb: { inline_keyboard: [[backBtn("menu", "◀️ В менюшку")]] },
});

async function sendView(chatId: number | string, v: View) {
  return tg("sendMessage", { chat_id: chatId, text: v.text, parse_mode: "HTML", reply_markup: v.kb });
}

async function setupCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "menu", description: "Открыть менюшку" },
      { command: "topics", description: "Мои тапики" },
      { command: "help", description: "Памагите" },
    ],
    scope: { type: "all_private_chats" },
  });
  await tg("setMyCommands", {
    commands: [
      { command: "ids", description: "Запомнить этот тапик" },
      { command: "desc", description: "Падсказка: чё сюда класть" },
      { command: "default", description: "Сделать запасным тапиком" },
      { command: "forget", description: "Забыть этот тапик" },
    ],
    scope: { type: "all_group_chats" },
  });
  await tg("setChatMenuButton", { menu_button: { type: "commands" } });
}

async function handleCallback(cb: any) {
  const ack = (text?: string) =>
    tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text } : {}) });

  if (String(cb.from?.id) !== String(OWNER_ID)) {
    await ack();
    return;
  }
  const chatId = cb.message?.chat?.id;
  const mid = cb.message?.message_id;
  if (!chatId || !mid) {
    await ack();
    return;
  }

  const [action, idStr] = String(cb.data ?? "").split(":");
  const id = Number(idStr);
  const show = (v: View) =>
    tg("editMessageText", {
      chat_id: chatId,
      message_id: mid,
      text: v.text,
      parse_mode: "HTML",
      reply_markup: v.kb,
    });

  let toast: string | undefined;

  switch (action) {
    case "menu":
      await show(await mainView());
      break;
    case "topics":
      await show(await topicsView());
      break;
    case "t":
      await show(await topicView(id));
      break;
    case "defmenu":
      await show(await defView());
      break;
    case "add":
      await show(addView());
      break;
    case "help":
      await show(helpView());
      break;
    case "d": {
      // Ждём следующее сообщение владельца как подсказку для этого топика
      const topics = await loadTopics();
      const t = topics.find((x) => x.id === id);
      if (!t) {
        await show(await topicsView());
        break;
      }
      await redis(["SET", "tg:state", JSON.stringify({ action: "desc", thread: id }), "EX", 600]);
      await show({
        text:
          `Напиши одним сообщением, чё класть в «${esc(t.name)}».\n\n` +
          "Например: фильмы и сериалы, каторые хочу пасматреть.",
        kb: { inline_keyboard: [[btn("Отмена", `cancel:${id}`)]] },
      });
      break;
    }
    case "cancel":
      await redis(["DEL", "tg:state"]);
      await show(await topicView(id));
      break;
    case "dc":
      await redis(["HDEL", "tg:desc", String(id)]);
      toast = "Падсказку убрал";
      await show(await topicView(id));
      break;
    case "s":
      await redis(["SET", "tg:default", String(id)]);
      toast = "Запаснай тапик теперь другой";
      await show(await topicView(id));
      break;
    case "x": {
      const group = await getGroup();
      if (!group) {
        toast = "Групки нету, ой";
        break;
      }
      const r = await tg("sendMessage", {
        chat_id: group,
        message_thread_id: id,
        text: "🧪 Праверка связи: я тут, я вижу тапик, ура!",
      });
      toast = r.ok ? "Кинул праверочку в тапик" : `Не палучилась: ${r.description ?? "ошипка"}`;
      break;
    }
    case "f": {
      const topics = await loadTopics();
      const t = topics.find((x) => x.id === id);
      if (!t) {
        await show(await topicsView());
        break;
      }
      await show({
        text:
          `Забыть тапик «${esc(t.name)}»?\n\n` +
          "Я перестану туда писать. Сам тапик в группе не удалится, а вернуть можно командой /ids.",
        kb: { inline_keyboard: [[btn("Да, забыть", `ff:${id}`), btn("Нет", `t:${id}`)]] },
      });
      break;
    }
    case "ff": {
      await redis(["HDEL", "tg:topics", String(id)]);
      await redis(["HDEL", "tg:desc", String(id)]);
      const def = await getDefault();
      if (def === id) await redis(["DEL", "tg:default"]);
      toast = "Забыл, ага";
      await show(await topicsView());
      break;
    }
  }

  await ack(toast);
}

// ---------- Основной обработчик ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(200).send("ok");

  // Проверяем, что запрос реально от Telegram
  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  try {
    // ===== Нажатия на кнопки меню =====
    if (req.body?.callback_query) {
      await handleCallback(req.body.callback_query);
      return res.status(200).send("ok");
    }

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

      // Любое сообщение владельца в топике запоминает этот топик (команда /ids не обязательна)
      let madeDefault = false;
      let isNew = false;
      if (REDIS_URL && threadId && topicName && (service || fromOwner)) {
        const r = await registerTopic(threadId, topicName);
        madeDefault = r.madeDefault;
        isNew = r.isNew;
      }

      // Тихо подтверждаем реакцией, что запомнил новый топик
      if (isNew && !service && !GROUP_COMMANDS.includes(cmd) && msg.message_id) {
        await tg("setMessageReaction", {
          chat_id: chatId,
          message_id: msg.message_id,
          reaction: [{ type: "emoji", emoji: "🤪" }],
        });
      }

      const say = (t: string) =>
        tg("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: t });

      if (fromOwner && GROUP_COMMANDS.includes(cmd)) {
        if (!REDIS_URL) {
          await say("Базы нету, я ничего не запомню 😭 Падключи Upstash Redis в Vercel (Storage) и сделай Redeploy.");
        } else if (!threadId) {
          await say("Это общий тапик (General), его я не запоминаю, он скучнай. Команды работают в обычных тапиках.");
        } else if (cmd === "/ids") {
          if (!topicName) {
            await say(`Не вижу как тапик называется (thread_id ${threadId}). Переименуй тапик и напиши /ids ищё раз, пажалуста.`);
          } else {
            await say(
              `Запомнил «${topicName}»! Теперь могу кидать сюда заметки 🤪` +
                (madeDefault ? "\nЭтот тапик стал запаснай: сюда пойдёт всё, чё некуда деть." : "")
            );
          }
        } else if (cmd === "/desc") {
          if (!arg) {
            await say("Напиши так: /desc чё сюда класть. Например: /desc фильмы и сериалы, каторые хочу пасматреть");
          } else {
            if (topicName) await redis(["HSET", "tg:topics", String(threadId), topicName]);
            await redis(["HSET", "tg:desc", String(threadId), arg.slice(0, 300)]);
            await say("Записал падсказку для этого тапика.");
          }
        } else if (cmd === "/default") {
          await redis(["SET", "tg:default", String(threadId)]);
          await say("Теперь это запаснай тапик: сюда пойдёт всё, чё некуда деть.");
        } else if (cmd === "/forget") {
          await redis(["HDEL", "tg:topics", String(threadId)]);
          await redis(["HDEL", "tg:desc", String(threadId)]);
          const def = await redis(["GET", "tg:default"]);
          if (def && Number(def) === threadId) await redis(["DEL", "tg:default"]);
          await say("Забыл этот тапик. Штобы вернуть, напиши /ids.");
        }
      }
      return res.status(200).send("ok");
    }

    // ===== Личка: только владелец =====
    if (!fromOwner) return res.status(200).send("ok");

    if (cmd === "/start") {
      await setupCommands();
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Прювет! Я бот-дурачок 🤪 Пиши мне чё угодна, а я раскидаю всё по тапикам в твоей группе (ну, я стараюсь). Менюшка всегда внизу, жми кнопку!",
        reply_markup: {
          keyboard: [[{ text: MENU_BUTTON_TEXT }]],
          resize_keyboard: true,
          is_persistent: true,
        },
      });
      await sendView(chatId, await mainView());
      return res.status(200).send("ok");
    }

    if (cmd === "/menu" || MENU_BUTTON_TEXTS.includes(text.trim())) {
      await redis(["DEL", "tg:state"]);
      await sendView(chatId, await mainView());
      return res.status(200).send("ok");
    }

    if (cmd === "/topics") {
      await sendView(chatId, await topicsView());
      return res.status(200).send("ok");
    }

    if (cmd === "/help") {
      await sendView(chatId, helpView());
      return res.status(200).send("ok");
    }

    if (cmd === "/cancel") {
      await redis(["DEL", "tg:state"]);
      await tg("sendMessage", { chat_id: chatId, text: "Ладна, атменил." });
      return res.status(200).send("ok");
    }

    // Если ждём подсказку для топика, это сообщение и есть подсказка
    if (text.trim() && !text.startsWith("/")) {
      const raw = await redis(["GET", "tg:state"]);
      if (raw) {
        let state: any = null;
        try {
          state = JSON.parse(String(raw));
        } catch {}
        if (state?.action === "desc" && state.thread) {
          await redis(["HSET", "tg:desc", String(state.thread), text.trim().slice(0, 300)]);
          await redis(["DEL", "tg:state"]);
          await sendView(chatId, await topicView(Number(state.thread)));
          return res.status(200).send("ok");
        }
      }
    }

    if (!text.trim()) {
      await tg("sendMessage", { chat_id: chatId, text: "Я пока панимаю только текст (и падписи к фоткам), у меня лапки." });
      return res.status(200).send("ok");
    }

    const group = await getGroup();
    const topics = await loadTopics();

    if (!group || !topics.length) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Я ищё не знаю твои тапики 😅 Зайди в каждый нужнай тапик группы и напиши там любое сообщение. Падробнее: кнопка «Менюшка».",
      });
      return res.status(200).send("ok");
    }

    const defId = await getDefault();
    const fallback = topics.find((t) => t.id === defId);
    const notes = await extractNotes(text, topics, fallback);

    if (!notes.length) {
      await tg("sendMessage", { chat_id: chatId, text: "Нипанятна, чё ты хочешь 🥴 Напиши по-другому?" });
      return res.status(200).send("ok");
    }

    const saved: string[] = [];
    for (const note of notes) {
      const target = topics.find((t) => t.label === note.topic) ?? fallback;
      if (!target) {
        saved.push(`⚠️ «${note.title}»: не нашёл куда деть, ой`);
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
          ? `${safeEmoji(note.emoji)} ${target.name}: ${note.title}`
          : `⚠️ ${target.name}: не отправилось (${r.description ?? "ошипка"})`
      );
    }

    await tg("sendMessage", { chat_id: chatId, text: `Записал, наверна всё правильна 🤪\n${saved.join("\n")}` });
  } catch (e) {
    console.error(e);
    // Всё равно отвечаем 200, иначе Telegram будет слать сообщение повторно
    const chatId = req.body?.message?.chat?.id;
    const isPrivate = req.body?.message?.chat?.type === "private";
    if (chatId && isPrivate) await tg("sendMessage", { chat_id: chatId, text: "Ой, чёта сломалось 💥 Глянь логи в Vercel." });
  }

  return res.status(200).send("ok");
}
