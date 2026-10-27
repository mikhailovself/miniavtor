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

const MENU_BUTTON_TEXT = "📋 Меню";
const MENU_BUTTON_TEXTS = ["📋 Меню", "📋 Менюшка"]; // старая кнопка тоже работает

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

Стиль (это важно): ты мини.автор, дурная мини-версия Влада. Пиши title и body так, как Влад пишет близкому другу в телеге:
- Коротко. Типичная его реплика это 2-4 слова. Без вступлений и воды, одна мысль на строку. Можно разбить на несколько коротких строк вместо одного абзаца.
- Первая буква чаще заглавная, но в конце точки нет вообще. Запятых почти нет, восклицательных знаков нет, многоточий нет. Вопросительный знак только если это реально вопрос.
- Разговорные сокращения: че, щас, ща, хз, всм, норм, мож, мб, чет, тож, поч, пон, тип, вроде, прям, ну да, угу, неа, ок, окей, ага. Не пихай все сразу, 1-2 на заметку.
- Мат как у друзей, но редко: примерно в каждой десятой заметке и одно слово максимум (бля, пиздец, нахуй, похуй, хуйня, сука).
- Подъёбы как между друзьями. Самые частые у Влада: «ты даун», «ты еблан», «ты тупой», «чмо», «лох», «заебал», «кринж». Подъёбывай владельца (он сам так просит), редко, в каждой пятой-десятой заметке, коротко, например в конце body: «Ты даун, забыл?» или «Опять забудешь, еблан». Обращения «бро», «чел», «брат» тоже его. Людей из самой заметки не оскорбляй и в точных полях (who, amount, deadline, названия) подъёбов не делай.
- Смех пиши «хахаха» (бывает хаха, хахахаха) и только если реально смешно. Слова «лол» и «ахах» не используй.
- Эмодзи почти не нужны, у Влада они в одном сообщении из ста. Если очень надо: 😭 😂 🥹 ❤ 😎 или грустный смайл ;(
- Опечатки настоящие, как от быстрого набора: пропущенная или переставленная буква, слипшиеся слова (например «видемо», «спецально», «следуший»). 0-2 на заметку. Детских искажений вроде «пожалуйста» и «топик» не делай.

Примеры, как мини.автор оформляет (только манера, содержание бери из сообщения):
- Вход: «Саня должен мне 2000 за билеты» → title: «Саня за билеты», body: «Должен 2000 за билеты»
- Вход: «идея для видоса: неделю без телефона» → title: «Видос про неделю без телефона», body: «Неделю не пользуюсь телефоном и снимаю как оно. Мож зайдет»
- Вход: «посмотреть фильм Одержимость друг посоветовал» → title: «Одержимость», body: «Фильм, друг посоветовал. Надо глянуть»
- Вход: «завтра в 6 созвон по презе с командой» → title: «Созвон по презе», body: «Завтра в 6 с командой. Не проспать»

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

// ---------- Меню (кнопки) ----------

type Button = { text: string; callback_data?: string; url?: string };
type View = { text: string; kb: { inline_keyboard: Button[][] } };

const btn = (text: string, data: string): Button => ({ text, callback_data: data });
const urlBtn = (text: string, url: string): Button => ({ text, url });
const backBtn = (data = "menu", text = "◀️ Назад"): Button => btn(text, data);

async function mainView(): Promise<View> {
  const group = await getGroup();
  const topics = await loadTopics();
  const defId = await getDefault();
  const def = topics.find((t) => t.id === defId);

  let text =
    "<b>Меню мини.автора</b> ✍️\n\n" +
    `Групка: ${group ? "падключена ✅" : "не падключена, ой ⚠️"}\n` +
    `Топиков: ${topics.length}\n` +
    `Запасной топик: ${def ? esc(def.name) : "нету"}`;
  if (!REDIS_URL) {
    text += "\n\n⚠️ Базы нету, я всё забываю как рыбка. Подключи Upstash Redis в Vercel (Storage).";
  }
  text += "\n\nЧтобы я записал заметку, просто пиши мне сообщение. Я понимаю (хз).";

  return {
    text,
    kb: {
      inline_keyboard: [
        [btn("📂 Мои топики", "topics")],
        [btn("⭐ Запасной топик", "defmenu"), btn("➕ Добавить топик", "add")],
        [btn("❓ Памагите", "help"), btn("✍️ Автор бота", "author")],
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
        "Топиков пока нету 😢\n\n" +
        "Зайди в нужный топик в группе и напиши там любое сообщение (или /ids). Запомню. Один раз на топик.",
      kb: { inline_keyboard: [[backBtn("menu", "◀️ В менюшку")]] },
    };
  }
  const rows: Button[][] = topics.map((t) => [btn(`${t.id === defId ? "⭐ " : ""}${t.name}`, `t:${t.id}`)]);
  rows.push([backBtn("menu", "◀️ В менюшку")]);
  return {
    text: `<b>Мои топики</b> (${topics.length})\n\nТыкни на топик, там настройки.`,
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
  rows.push([btn("✏️ Подсказка для меня", `d:${id}`), ...(t.desc ? [btn("🧹 Убрать", `dc:${id}`)] : [])]);
  if (!isDef) rows.push([btn("⭐ Сделать запасным", `s:${id}`)]);
  rows.push([btn("🧪 Праверить связь", `x:${id}`), btn("🗑 Забыть", `f:${id}`)]);
  rows.push([backBtn("topics", "◀️ К топикам")]);

  return {
    text:
      `<b>${esc(t.name)}</b>${isDef ? " ⭐ запасной" : ""}\n\n` +
      `Подсказка для меня: ${t.desc ? esc(t.desc) : "нету"}\n\n` +
      "Подсказка помогает мне понять, че сюда класть. А то я путаю, я маленький.",
    kb: { inline_keyboard: rows },
  };
}

async function defView(): Promise<View> {
  const topics = await loadTopics();
  const defId = await getDefault();
  const rows: Button[][] = topics.map((t) => [btn(`${t.id === defId ? "✅ " : ""}${t.name}`, `s:${t.id}`)]);
  rows.push([backBtn("menu", "◀️ В менюшку")]);
  return {
    text: "<b>Запасной топик</b>\n\nСюда кидаю всё, че некуда деть. Выбери топик:",
    kb: { inline_keyboard: rows },
  };
}

const addView = (): View => ({
  text:
    "<b>Как добавить топик</b>\n\n" +
    "1. Зайди в нужный топик в группе.\n" +
    "2. Напиши там любое сообщение (или /ids).\n" +
    "3. Я поставлю 🤪 и запомню.\n\n" +
    "Новые топики, которые ты создашь потом, я замечу сам. Старые надо показать один раз: я их не вижу, хз почему.",
  kb: { inline_keyboard: [[backBtn("menu", "◀️ В менюшку")]] },
});

const helpView = (): View => ({
  text:
    "<b>Памагите, как этим пользоваться</b>\n\n" +
    "Пиши мне в личку че угодно: идеи, долги, фильмы, дела, ссылки. Я сам выберу топик в группе и оформлю заметку (ну я стараюсь).\n\n" +
    "Если я кладу заметки не туда, зайди в «Мои топики», выбери топик и задай «Подсказку для бота»: коротко, че сюда класть.\n\n" +
    "В группе (в нужном топике) работают команды:\n" +
    "/ids: запомнить топик\n" +
    "/desc текст: подсказка для топика\n" +
    "/default: сделать топик запасным\n" +
    "/forget: забыть топик",
  kb: { inline_keyboard: [[backBtn("menu", "◀️ В менюшку")]] },
});

const authorView = (): View => ({
  text:
    "<b>Автор бота</b> ✍️\n\n" +
    "Меня придумал <b>влад.автор</b>, а я его мини-автор, хихи. Я маленький, но стараюсь!\n\n" +
    "Тут всякие ево штуки: таплинк и тг-канал. Ни стисняйся, тыкай!",
  kb: {
    inline_keyboard: [
      [urlBtn("🔗 Таплинк", "https://taplink.cc/awtor")],
      [urlBtn("📣 Тг-канал", "https://t.me/vladavtorx")],
      [backBtn("menu", "◀️ В менюшку")],
    ],
  },
});

async function sendView(chatId: number | string, v: View) {
  return tg("sendMessage", { chat_id: chatId, text: v.text, parse_mode: "HTML", reply_markup: v.kb });
}

async function setupCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "menu", description: "Открыть менюшку" },
      { command: "topics", description: "Мои топики" },
      { command: "help", description: "Памагите" },
      { command: "author", description: "Автор бота" },
    ],
    scope: { type: "all_private_chats" },
  });
  await tg("setMyCommands", {
    commands: [
      { command: "ids", description: "Запомнить этот топик" },
      { command: "desc", description: "Подсказка: че сюда класть" },
      { command: "default", description: "Сделать запасным топиком" },
      { command: "forget", description: "Забыть этот топик" },
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
    case "author":
      await show(authorView());
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
          `Напиши одним сообщением, че класть в «${esc(t.name)}».\n\n` +
          "Например: фильмы и сериалы, которые хочу посмотреть.",
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
      toast = "Подсказку убрал";
      await show(await topicView(id));
      break;
    case "s":
      await redis(["SET", "tg:default", String(id)]);
      toast = "Запасной топик теперь другой";
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
        text: "🧪 Проверка связи. Я тут, топик вижу",
      });
      toast = r.ok ? "Кинул проверку в топик" : `Не получилось: ${r.description ?? "ошибка"}`;
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
          `Забыть топик «${esc(t.name)}»?\n\n` +
          "Я перестану туда писать. Сам топик в группе не удалится, а вернуть можно командой /ids.",
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
          await say("Базы нет, я нихуя не запомню 😭 Подключи Upstash Redis в Vercel (Storage) и сделай Redeploy.");
        } else if (!threadId) {
          await say("Это общий топик (General), его не запоминаю. Команды работают в обычных топиках.");
        } else if (cmd === "/ids") {
          if (!topicName) {
            await say(`Не вижу как топик называется (thread_id ${threadId}). Переименуй топик и напиши /ids ещё раз, пожалуйста.`);
          } else {
            await say(
              `Запомнил «${topicName}»! Теперь могу кидать сюда заметки 🤪` +
                (madeDefault ? "\nЭтот топик стал запасным: сюда пойдёт всё, че некуда деть." : "")
            );
          }
        } else if (cmd === "/desc") {
          if (!arg) {
            await say("Напиши так: /desc че сюда класть. Например: /desc фильмы и сериалы, которые хочу посмотреть");
          } else {
            if (topicName) await redis(["HSET", "tg:topics", String(threadId), topicName]);
            await redis(["HSET", "tg:desc", String(threadId), arg.slice(0, 300)]);
            await say("Записал подсказку для этого топика.");
          }
        } else if (cmd === "/default") {
          await redis(["SET", "tg:default", String(threadId)]);
          await say("Теперь это запасной топик: сюда пойдёт всё, че некуда деть.");
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

    if (cmd === "/start") {
      await setupCommands();
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Хай. Я мини.автор ✍️ Пиши че угодно, я запишу и раскидаю по топикам в группе. Меню снизу, жми",
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

    if (cmd === "/author") {
      await sendView(chatId, authorView());
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
      await tg("sendMessage", { chat_id: chatId, text: "Я пока понимаю только текст и подписи к фоткам. Голосовые хз" });
      return res.status(200).send("ok");
    }

    const group = await getGroup();
    const topics = await loadTopics();

    if (!group || !topics.length) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Я твои топики ещё не знаю. Зайди в каждый нужный топик группы и напиши там любое сообщение. Подробнее в меню",
      });
      return res.status(200).send("ok");
    }

    const defId = await getDefault();
    const fallback = topics.find((t) => t.id === defId);
    const notes = await extractNotes(text, topics, fallback);

    if (!notes.length) {
      await tg("sendMessage", { chat_id: chatId, text: "Ты че несешь, не понял. Напиши по-другому?" });
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
          : `⚠️ ${target.name}: не отправилось (${r.description ?? "ошибка"})`
      );
    }

    await tg("sendMessage", { chat_id: chatId, text: `Записал, всм норм\n${saved.join("\n")}` });
  } catch (e) {
    console.error(e);
    // Всё равно отвечаем 200, иначе Telegram будет слать сообщение повторно
    const chatId = req.body?.message?.chat?.id;
    const isPrivate = req.body?.message?.chat?.type === "private";
    if (chatId && isPrivate) await tg("sendMessage", { chat_id: chatId, text: "Бля, че-т сломалось. Глянь логи в Vercel, даун" });
  }

  return res.status(200).send("ok");
}
