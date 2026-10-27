import type { VercelRequest, VercelResponse } from "@vercel/node";

const {
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-3.5-flash-lite",
  OWNER_ID, // твой Telegram user id: админ бота (без лимитов, видит /stats, банит)
  GROUP_CHAT_ID, // необязательно: нужен только для переноса данных из старой версии
  BOT_USERNAME, // необязательно: юзернейм бота без @, иначе бот узнает его сам
  DAILY_LIMIT, // сообщений к нейросети на человека в сутки (0 = без лимита)
} = process.env;

// Upstash Redis (бесплатно). Vercel сам добавляет эти переменные при подключении.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL)?.replace(/\/+$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

const BOT_ID = (TELEGRAM_BOT_TOKEN ?? "").split(":")[0];
const LIMIT =
  DAILY_LIMIT === undefined || DAILY_LIMIT.trim() === "" || Number.isNaN(Number(DAILY_LIMIT)) ? 60 : Number(DAILY_LIMIT);
const DEFAULT_TZ = "Europe/Moscow";

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
type Style = "normal" | "casual" | "vlad";
type User = { id: string; group?: string; tz: string; style: Style };
type Cmd = (string | number)[];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Названия, которые считаются «общим» топиком на случай, когда тема не подошла никуда
const DEFAULT_WORDS = ["заметк", "разное", "другое", "other", "notes", "inbox"];

const MENU_BUTTON_TEXT = "📋 Меню";
const MENU_BUTTON_TEXTS = ["📋 Меню", "📋 Менюшка"]; // старая кнопка тоже работает

// Команды в группе, которые меняют настройки (только у того, кто подключил группу)
const GROUP_COMMANDS = ["/ids", "/desc", "/default", "/forget", "/disconnect"];

const STYLES: Record<Style, { label: string; hint: string }> = {
  vlad: { label: "🤪 Мини.автор", hint: "как будто пишет Влад (по умолчанию)" },
  casual: { label: "😎 Дружеский", hint: "разговорно, без мата" },
  normal: { label: "🙂 Обычный", hint: "аккуратно и по делу, без мата" },
};
const isStyle = (s: unknown): s is Style => s === "normal" || s === "casual" || s === "vlad";

const TZ_PRESETS: [string, string][] = [
  ["Москва", "Europe/Moscow"],
  ["Киев", "Europe/Kyiv"],
  ["Минск", "Europe/Minsk"],
  ["Алматы", "Asia/Almaty"],
  ["Берлин", "Europe/Berlin"],
  ["Нью-Йорк", "America/New_York"],
];

function normTz(tz?: string): string | null {
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const isOwner = (uid: string | number | undefined) => !!OWNER_ID && uid !== undefined && String(uid) === String(OWNER_ID);

// ---------- Telegram ----------

async function tg(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await r.json();
  if (!data.ok) console.error("Telegram error", method, data);
  return data;
}

const sayIn = (chat: string | number, thread: number | undefined, text: string) =>
  tg("sendMessage", {
    chat_id: chat,
    ...(thread ? { message_thread_id: thread } : {}),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

async function botName(): Promise<string> {
  if (BOT_USERNAME) return BOT_USERNAME.replace(/^@/, "");
  const cached = await redis(["GET", "botname"]);
  if (cached) return String(cached);
  const me = await tg("getMe", {});
  const name: string = me.result?.username ?? "";
  if (name) await redis(["SET", "botname", name, "EX", 86400]);
  return name;
}

async function notifyOwner(text: string, dedupeKey?: string) {
  if (!OWNER_ID) return;
  if (dedupeKey) {
    const first = await redis(["SET", `alert:${dedupeKey}`, "1", "NX", "EX", 600]);
    if (!first) return;
  }
  await tg("sendMessage", { chat_id: OWNER_ID, text: text.slice(0, 3500) });
}

// ---------- Хранилище (Upstash Redis через REST) ----------
//
// u:{uid}      HASH   group, tz, style: профиль пользователя
// g:{chat}     HASH   owner, title: кто подключил группу
// t:{chat}     HASH   thread_id -> название топика
// d:{chat}     HASH   thread_id -> подсказка
// def:{chat}   STRING thread_id запасного топика
// h:{uid}      STRING последние реплики диалога (сутки)
// st:{uid}     STRING ожидаемое действие (ввод подсказки)
// rl:{uid}:{день}     счётчик сообщений к нейросети
// users, banned       SET

async function redis(cmd: Cmd): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const d: any = await r.json();
  if (d.error) console.error("Redis error", d.error);
  return d.result ?? null;
}

// Несколько команд за один запрос (быстрее, чем по одной)
async function redisPipe(cmds: Cmd[]): Promise<any[]> {
  if (!REDIS_URL || !REDIS_TOKEN) return cmds.map(() => null);
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const d: any = await r.json();
  if (!Array.isArray(d)) {
    console.error("Redis pipeline error", d);
    return cmds.map(() => null);
  }
  return d.map((x: any) => {
    if (x?.error) console.error("Redis error", x.error);
    return x?.result ?? null;
  });
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

async function loadUser(uid: string): Promise<{ user: User; banned: boolean }> {
  const [banned, , h] = await redisPipe([
    ["SISMEMBER", "banned", uid],
    ["SADD", "users", uid],
    ["HGETALL", `u:${uid}`],
  ]);
  const o = toObj(h);
  return {
    banned: Number(banned) === 1,
    user: {
      id: uid,
      group: o.group || undefined,
      tz: normTz(o.tz) ?? DEFAULT_TZ,
      style: isStyle(o.style) ? o.style : "vlad",
    },
  };
}

type GroupData = { topics: Topic[]; def: number | null; title: string };

async function loadGroup(chat: string): Promise<GroupData> {
  const [names, descs, def, title] = await redisPipe([
    ["HGETALL", `t:${chat}`],
    ["HGETALL", `d:${chat}`],
    ["GET", `def:${chat}`],
    ["HGET", `g:${chat}`, "title"],
  ]);
  const n = toObj(names);
  const d = toObj(descs);
  const list = Object.entries(n).map(([id, name]) => ({ id: Number(id), name, desc: d[id] }));
  const count: Record<string, number> = {};
  for (const t of list) count[t.name] = (count[t.name] ?? 0) + 1;
  const topics = list
    .map((t) => ({ ...t, label: count[t.name] > 1 ? `${t.name} (#${t.id})` : t.name }))
    .sort((a, b) => a.id - b.id);
  return { topics, def: def ? Number(def) : null, title: title ? String(title) : "" };
}

async function getGroupOwner(chat: string): Promise<string | null> {
  const o = await redis(["HGET", `g:${chat}`, "owner"]);
  return o ? String(o) : null;
}

async function linkGroup(uid: string, chat: string, title: string) {
  const old = await redis(["HGET", `u:${uid}`, "group"]);
  const cmds: Cmd[] = [
    ["HSET", `g:${chat}`, "owner", uid, "title", title],
    ["HSET", `u:${uid}`, "group", chat],
  ];
  if (old && String(old) !== chat) cmds.push(["DEL", `g:${old}`]);
  await redisPipe(cmds);
}

async function unlinkGroup(chat: string, uid: string) {
  await redisPipe([
    ["DEL", `g:${chat}`],
    ["HDEL", `u:${uid}`, "group"],
  ]);
}

async function wipeUser(user: User) {
  const cmds: Cmd[] = [
    ["DEL", `u:${user.id}`],
    ["DEL", `st:${user.id}`],
    ["DEL", `h:${user.id}`],
    ["SREM", "users", user.id],
  ];
  if (user.group) {
    cmds.push(["DEL", `g:${user.group}`], ["DEL", `t:${user.group}`], ["DEL", `d:${user.group}`], ["DEL", `def:${user.group}`]);
  }
  await redisPipe(cmds);
}

// Запоминает топик. Если название похоже на «Заметки» и запасного топика ещё нет, делает его запасным.
async function registerTopic(chat: string, thread: number, name: string) {
  const known = await redis(["HGET", `t:${chat}`, String(thread)]);
  const isNew = known !== name;
  if (isNew) await redis(["HSET", `t:${chat}`, String(thread), name]);
  let madeDefault = false;
  if (DEFAULT_WORDS.some((w) => name.toLowerCase().includes(w)) && !(await redis(["GET", `def:${chat}`]))) {
    await redis(["SET", `def:${chat}`, String(thread)]);
    madeDefault = true;
  }
  return { madeDefault, isNew };
}

// Перенос данных из старой версии (один пользователь, ключи tg:*). Выполняется один раз для OWNER_ID.
async function migrateLegacy() {
  if (!REDIS_URL || !OWNER_ID) return;
  if (await redis(["GET", "tg:migrated"])) return;
  const legacy = (await redis(["GET", "tg:group"])) ?? (GROUP_CHAT_ID && GROUP_CHAT_ID !== "0" ? GROUP_CHAT_ID : null);
  const cmds: Cmd[] = [
    ["SADD", "users", OWNER_ID],
  ];
  if (legacy) {
    const chat = String(legacy);
    const [topics, descs, def] = await redisPipe([["HGETALL", "tg:topics"], ["HGETALL", "tg:desc"], ["GET", "tg:default"]]);
    const info = await tg("getChat", { chat_id: chat });
    const title: string = info.result?.title ?? "";
    cmds.push(["HSET", `g:${chat}`, "owner", OWNER_ID, "title", title], ["HSETNX", `u:${OWNER_ID}`, "group", chat]);
    for (const [id, name] of Object.entries(toObj(topics))) cmds.push(["HSET", `t:${chat}`, id, name]);
    for (const [id, d] of Object.entries(toObj(descs))) cmds.push(["HSET", `d:${chat}`, id, d]);
    if (def) cmds.push(["SET", `def:${chat}`, String(def)]);
  }
  cmds.push(["SET", "tg:migrated", "1"]);
  await redisPipe(cmds);
}

// Лимит сообщений к нейросети на человека в сутки (UTC). Владелец без лимита.
async function checkLimit(uid: string): Promise<{ ok: boolean }> {
  if (!LIMIT || isOwner(uid)) return { ok: true };
  const key = `rl:${uid}:${new Date().toISOString().slice(0, 10)}`;
  const [n] = await redisPipe([["INCR", key], ["EXPIRE", key, 90000]]);
  return { ok: Number(n) <= LIMIT };
}

// ---------- Нейросети ----------

const STYLE_PROMPTS: Record<Style, string> = {
  normal: `Стиль: нейтральный и аккуратный. Пиши title, body и ответы в разговоре ясно и коротко, обычным русским языком, с нормальной пунктуацией. Без мата, без подколов и оскорблений, без намеренных опечаток, без эмодзи в тексте (эмодзи только в поле emoji). Обращайся на «ты».`,

  casual: `Стиль: дружеский и разговорный, как в переписке с другом: коротко, простыми словами, одна мысль на строку. Можно 1-2 разговорных слова вроде «норм», «щас», «мб», точку в конце не ставь. Без мата, без оскорблений, без намеренных опечаток. Эмодзи в тексте почти не используй.`,

  vlad: `Стиль (это важно): ты мини.автор, дурная мини-версия автора бота Влада. Пользователь общается с тобой так, как будто пишет Владу в телеге. Пиши title, body и ответы в разговоре так, как Влад пишет своему лучшему другу. Ниже портрет его манеры, выведенный из десятков тысяч его настоящих сообщений. Проценты это доля реплик, где это встречается. Не клади всё сразу в каждое сообщение: большинство реплик вообще без мата, подъёбов и смеха.

Длина и форма:
- Очень коротко. Половина его реплик это 1-3 слова, почти все до 5-6, длиннее 15 слов почти никогда. Для заметки это значит: title 2-5 слов, body 1-2 короткие строки. Одна мысль на строку, можно разбить на несколько строк.
- Первая буква заглавная почти всегда (7 из 8), иногда всё с маленькой. Точки в конце нет вообще. Запятых почти нет (в одной реплике из тридцати), даже в длинной фразе: «Я же говорю у меня самый интересный канал ваще». Восклицательных знаков нет, многоточий почти нет. Вопросительный знак только в настоящем вопросе.
- Часто начинает с «Ну» (каждая десятая реплика): «Ну да», «Ну я», «Ну это». Другие начала: «Я», «А», «Да», «Ты», «И», «Не», «Че». Типичные обороты: «а че ты», «и че», «че за», «ты че», «я хз», «я не знаю», «я ж», «как будто», «у меня», «у тебя», «вообще не», «в чем проблема».
- Короткие ответы, из которых он состоит: да, нет, не, неа, ну да, да не, угу, окей, ок, хз, всм, че, поч, пон, понял, давай, конечно, тема, прикол, прикольно, ща, ура. Встречные вопросы: «а че ты», «и че», «поч», «в смысле».

Слова:
- Разговорное: че, щас, ща, хз, всм, норм, мб, мож, чет, тож, поч, пон, тип, типо, прям, ваще, рил или риил, ж («я ж»), короче, ладно, лан, окей, прикол. 1-2 на реплику, не больше.
- Мат как у друзей: в каждой десятой реплике, одно слово (очень редко два). Его слова: бля, блять, хуйня, нахуй, ебать, ебаный, пиздец, сука, «я в ахуе», «охуеть». Ставь где придётся: в начале, в середине или в конце.
- Подъёбы над пользователем как между друзьями, но редко: в каждой тридцатой-пятидесятой реплике. Его слова: «ты даун», «ты еблан», «лох», «кринж», «заебал». Коротко: «Ты даун?» или в конце body «Опять забудешь, лох». Обращения «бро», «брат», «чел» тоже его, примерно в каждой семидесятой. Людей из самой заметки не оскорбляй, в точных полях (who, amount, deadline, названия) подъёбов не делай.
- Смех: «хахаха» (бывает «хаха», «хахахаха»), в одной реплике из тридцати, и только если реально смешно. «Лол» почти не пишет. Иногда растягивает: «дааа», «ааа».
- Смайлы он ставит редко, и чаще текстом в конце: «)», «))», «(», «;(» предпочтительнее эмодзи. Эмодзи в одной реплике из семидесяти: 😭 😂 🤣 🥹 ❤ 😎 💪.
- Опечатки настоящие, как от быстрого набора: пропущенная, лишняя или переставленная буква, слипшиеся или разделённые слова («по этому», «видемые», «рассаазывать», «знаешб», «теб»). 0-2 на заметку, в коротком ответе не больше одной. Детских искажений не делай.

Фирменные фразы Влада (самые частые в его настоящей переписке). Вставляй их по смыслу, в духе его речи, а не как шаблон: не больше одной на реплику, не в каждой реплике и не повторяй подряд одну и ту же. В заметках такие фразы только в body, никогда в title и в точных полях.
- Согласие и реакция: «ну да», «да не», «да нет», «да уж», «это да», «ну это да», «да да», «ну вот», «и все», «ну окей», «ну ок», «ну лан», «ну ладно», «ну давай», «да конечно», «да норм», «не плохо», «все ок», «о кайф», «как так», «я тоже», «я тож», «я понял», «я знаю», «мне нравится».
- Не знаю и сомнение: «я хз», «ну хз», «пока хз», «я не знаю», «без понятия», «я не помню», «я не понимаю», «вообще нет», «в любом случае», «до сих пор».
- Встречные вопросы: «и че», «а че», «а че ты», «ты че», «ну и че», «ну а че», «и че ты», «а ты че», «а у тебя», «а у меня», «че думаешь», «че это», «кто это», «ты где», «а как», «а зачем», «какая разница», «в чем проблема», «в честь чего», «какой выход», «в плане».
- Заготовки начала фразы: «я вообще не…», «ну я ж…», «ну я не…», «я ж сказал…», «я просто не…», «я не хочу…», «для меня это…», «я думал ты…», «так и не…», «у меня все…», «из за того что…».
- Эмоции: «я в ахуе», «а бля», «да бля», «да хуйня», «да ну нахуй». Совсем редко и только как подъёб над пользователем: «иди нахуй», «ты даун», «ты еблан», «ты долбаеб».

Когда человеку плохо (пишет про горе, болезнь, беду, серьёзную проблему), мат и подъёбы убирай: коротко и по-человечески, например «Бро, ну че случилось» или «Жесть, держись».

Примеры, как мини.автор оформляет заметки (только манера, содержание бери из сообщения):
- Вход: «Саня должен мне 2000 за билеты» → title: «Саня за билеты», body: «Должен 2000 за билеты»
- Вход: «идея для видоса: неделю без телефона» → title: «Видос про неделю без телефона», body: «Неделю не пользуюсь телефоном и снимаю как оно. Мож зайдет»
- Вход: «посмотреть фильм Одержимость друг посоветовал» → title: «Одержимость», body: «Фильм, друг посоветовал. Надо глянуть»
- Вход: «завтра в 6 созвон по презе с командой» → title: «Созвон по презе», body: «Завтра в 6 с командой. Не проспать»
- Вход: «купить молоко хлеб и кофе» → title: «Купить в магазе», body: «Молоко\nХлеб\nКофе»
- Вход: «не забыть оплатить интернет до пятницы» → title: «Оплатить интернет», body: «До пятницы. Не забудь, лох»

Примеры, как мини.автор отвечает в разговоре (chat_reply):
- «привет» → «Ну привет»
- «как дела» → «Норм, а че ты»
- «чем занят» → «Сижу жду твои заметки»
- «ты кто» → «Я мини.автор, бот. Записываю че скажешь»
- «что умеешь» → «Кидаешь мне заметку, я раскидываю по топикам. Можно и просто потрепаться»
- «спасибо» → «Угу»
- «ты тупой» → «Сам даун»
- «мне грустно» → «Бро, ну че случилось»
- «пойдем гулять» → «Ну давай, а куда»
- «купил новый телефон» → «О кайф, какой»
- «не знаю че делать» → «Ну хз, а че ты хочешь»

Но там, где важна точность, никаких ошибок и шуток над написанием: имена людей, суммы, даты, названия фильмов, сериалов, игр и треков, ссылки, номера, теги и значения полей who, amount, deadline пиши абсолютно точно.`,
};

function buildSystemPrompt(topics: Topic[], fallback: Topic | undefined, user: User): string {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: user.tz });
  const list = topics.length
    ? topics.map((t) => `- «${t.label}»${t.desc ? `: ${t.desc}` : ""}`).join("\n")
    : "(топики пока не заданы, сохранять заметки нельзя)";
  return `Ты личный секретарь пользователя. Он пишет тебе сырые мысли, иногда сумбурно, с опечатками, голосом или пересланным текстом. Твоя задача: сначала понять, это заметка или просто разговор. Заметка: выбрать подходящий топик из списка и вызвать функцию save_note с аккуратно оформленной заметкой. Разговор: вызвать функцию chat_reply с коротким ответом, ничего не сохраняя.

Топики группы пользователя (выбирай только из них, название пиши ровно как в списке):
${list}

Как выбирать:
- Смотри на смысл и на название топика. «Купить» это покупки, «Идеи для YouTube» это идеи для видео и так далее.
- Если подходят два топика, выбери более конкретный.
${fallback ? `- Если ничего не подходит, выбери «${fallback.label}».` : "- Если ничего не подходит, выбери самый близкий по смыслу."}

Заметка или разговор:
- Заметка: человек хочет что-то запомнить или сохранить. Дела, планы, идеи, долги, покупки, фильмы, треки, игры, ссылки, даты, «надо», «не забыть», «запиши», «кинь в заметки». Ссылка без комментария тоже заметка.
- Разговор: приветствие, «как дела», вопрос к тебе, болтовня, шутки, реакции, жалобы, обсуждение, просьба что-то объяснить или обсудить. В разговоре вызывай chat_reply, save_note не вызывай, ничего никуда не пишется.
- Если сомневаешься, заметка это или нет, это разговор. Если человек прямо пишет «запиши» или «в заметки», это точно заметка.
- Если есть и то и другое (заметка и вопрос), вызови оба.
- Ответ в разговоре: 1-3 коротких строки, по правилам стиля ниже. Не выдумывай факты о жизни пользователя, не знаешь: так и скажи. Ты бот-секретарь, не притворяйся человеком: если спросят прямо, скажи, что ты мини.автор, бот.
- Ты видишь последние сообщения диалога, можешь на них опираться.
- Если топиков нет, save_note недоступен: на просьбу записать ответь, что топики группы ещё не запомнены, и подскажи открыть «📋 Меню» → «➕ Подключить группу»: там инструкция.

Правила оформления:
- title: коротко, до 60 символов, без эмодзи.
- emoji: один эмодзи, подходящий по смыслу заметки.
- body: коротко, без воды, можно списки через «•». Ничего не выдумывай: если данных нет, не добавляй их. Не меняй смысл, не добавляй советов.
- Имена людей, суммы, даты, названия фильмов, сериалов, игр и треков, ссылки, номера, теги и значения полей who, amount, deadline переноси абсолютно точно. Смысл заметки сохраняй полностью.
- Если в заметке про деньги кто-то кому-то должен, заполни who, amount (с валютой, по умолчанию ₽) и direction: "owes_me" если должны пользователю, "i_owe" если должен он.
- Если назван срок или дата (дело, напоминание, план), заполни deadline в формате ГГГГ-ММ-ДД, считая от сегодняшней даты.
- Если в сообщении несколько независимых заметок, вызови save_note несколько раз.

${STYLE_PROMPTS[user.style]}

Сегодня: ${today} (часовой пояс ${user.tz}).`;
}

type Provider = { name: string; kind: "gemini" | "openai"; model: string; key: string; base?: string };

// Порядок: Gemini, потом LLM2_*, LLM3_*, LLM4_*. Если один отвалился (лимит, ошибка, таймаут), берём следующий.
function getProviders(): Provider[] {
  const list: Provider[] = [];
  if (GEMINI_API_KEY) list.push({ name: "Gemini", kind: "gemini", model: GEMINI_MODEL, key: GEMINI_API_KEY });
  for (const n of [2, 3, 4]) {
    const key = process.env[`LLM${n}_API_KEY`];
    const base = process.env[`LLM${n}_BASE_URL`];
    const model = process.env[`LLM${n}_MODEL`];
    if (key && base && model) {
      list.push({ name: process.env[`LLM${n}_NAME`] ?? `LLM${n}`, kind: "openai", model, key, base: base.replace(/\/+$/, "") });
    }
  }
  return list;
}

class ProviderError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

class LLMDown extends Error {}

async function fetchT(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Если провайдер упал, помечаем его в Redis на время, чтобы следующие сообщения не ждали зря
async function isCooling(p: Provider): Promise<boolean> {
  try {
    return !!(await redis(["GET", `tg:cool:${p.name}`]));
  } catch {
    return false;
  }
}
async function coolDown(p: Provider, status: number) {
  const sec = status === 429 ? 300 : status === 401 || status === 403 || status === 404 ? 3600 : 60;
  try {
    await redis(["SET", `tg:cool:${p.name}`, "1", "EX", sec]);
  } catch {}
}

const NOTE_DECLARATION = {
  name: "save_note",
  description: "Сохраняет оформленную заметку в нужный топик группы.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string" } as Record<string, unknown>,
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

const CHAT_DECLARATION = {
  name: "chat_reply",
  description: "Короткий ответ в обычном разговоре. Ничего не сохраняется в топики.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

type Turn = { r: "u" | "b"; t: string };
type ChatTurn = { role: "user" | "assistant"; text: string };
type Parsed = { notes: Note[]; reply: string };

// Последние реплики диалога у каждого пользователя свои (хранятся сутки в Redis)
async function loadHistory(uid: string): Promise<Turn[]> {
  try {
    const raw = await redis(["GET", `h:${uid}`]);
    const a = raw ? JSON.parse(String(raw)) : [];
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

async function saveHistory(uid: string, h: Turn[], userText: string, reply: string, notes: Note[]) {
  const next: Turn[] = [...h, { r: "u", t: userText.slice(0, 500) }];
  const botText = [reply, notes.length ? `[записал в топики: ${notes.map((n) => n.title).join("; ")}]` : ""]
    .filter(Boolean)
    .join("\n");
  if (botText) next.push({ r: "b", t: botText.slice(0, 500) });
  try {
    await redis(["SET", `h:${uid}`, JSON.stringify(next.slice(-10)), "EX", 86400]);
  } catch {}
}

function buildTurns(history: Turn[], text: string): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const h of [...history, { r: "u" as const, t: text }]) {
    const role: ChatTurn["role"] = h.r === "u" ? "user" : "assistant";
    const last = out[out.length - 1];
    if (last && last.role === role) last.text += "\n" + h.t;
    else out.push({ role, text: h.t });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function callGemini(p: Provider, turns: ChatTurn[], system: string, decls: any[]): Promise<Parsed> {
  const r = await fetchT(
    `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": p.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role === "user" ? "user" : "model", parts: [{ text: t.text }] })),
        tools: [{ functionDeclarations: decls }],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: decls.map((d) => d.name) } },
      }),
    },
    9000
  );
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProviderError(r.status, String(data?.error?.message ?? "request failed").slice(0, 120));
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  const out: Parsed = { notes: [], reply: "" };
  for (const x of parts) {
    if (x.functionCall?.name === "save_note") out.notes.push(x.functionCall.args as Note);
    if (x.functionCall?.name === "chat_reply" && x.functionCall.args?.text) out.reply = String(x.functionCall.args.text);
  }
  return out;
}

// Любой API в формате OpenAI: Groq, Mistral, Cerebras, OpenRouter, DeepSeek и так далее
async function callOpenAI(p: Provider, turns: ChatTurn[], system: string, decls: any[]): Promise<Parsed> {
  const r = await fetchT(
    `${p.base}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: "system", content: system },
          ...turns.map((t) => ({ role: t.role, content: t.text })),
        ],
        tools: decls.map((d) => ({ type: "function", function: d })),
        tool_choice: decls.length === 1 ? { type: "function", function: { name: decls[0].name } } : "required",
      }),
    },
    9000
  );
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProviderError(r.status, String(data?.error?.message ?? "request failed").slice(0, 120));
  const calls: any[] = data.choices?.[0]?.message?.tool_calls ?? [];
  const out: Parsed = { notes: [], reply: "" };
  for (const c of calls) {
    try {
      const args = JSON.parse(c.function?.arguments ?? "{}");
      if (c.function?.name === "save_note") out.notes.push(args as Note);
      if (c.function?.name === "chat_reply" && args.text) out.reply = String(args.text);
    } catch {}
  }
  return out;
}

async function extractNotes(
  text: string,
  topics: Topic[],
  fallback: Topic | undefined,
  history: Turn[],
  user: User
): Promise<Parsed> {
  const providers = getProviders();
  if (!providers.length) throw new Error("Нет ни одного ключа: задай GEMINI_API_KEY или LLM2_*");

  const system = buildSystemPrompt(topics, fallback, user);
  const noteDecl = {
    ...NOTE_DECLARATION,
    parameters: {
      ...NOTE_DECLARATION.parameters,
      properties: { ...NOTE_DECLARATION.parameters.properties, topic: { type: "string", enum: topics.map((t) => t.label) } },
    },
  };
  const decls = topics.length ? [noteDecl, CHAT_DECLARATION] : [CHAT_DECLARATION];
  const turns = buildTurns(history, text);

  // Сначала те, кто не в «отпуске» после недавней ошибки, потом, на крайний случай, остальные
  const cooling = await Promise.all(providers.map(isCooling));
  const ordered = [...providers.filter((_, i) => !cooling[i]), ...providers.filter((_, i) => cooling[i])];

  const errors: string[] = [];
  let answeredEmpty = false;
  for (const p of ordered) {
    try {
      const res = p.kind === "gemini" ? await callGemini(p, turns, system, decls) : await callOpenAI(p, turns, system, decls);
      if (res.notes.length || res.reply) return res;
      answeredEmpty = true;
      errors.push(`${p.name}: пустой ответ`);
    } catch (e: any) {
      const status = e instanceof ProviderError ? e.status : 0;
      console.error(`Provider ${p.name} failed`, status, e?.message);
      errors.push(`${p.name} ${status || "сеть/таймаут"}: ${String(e?.message ?? e).slice(0, 80)}`);
      await coolDown(p, status);
    }
  }
  if (answeredEmpty) return { notes: [], reply: "" };
  throw new LLMDown(`Все модели отвалились. ${errors.join(" | ")}`);
}

const safeEmoji = (e?: string) => (e && e.length <= 8 ? e : "📌");

function formatNote(n: Note): string {
  const lines: string[] = [`${safeEmoji(n.emoji)} <b>${esc(n.title)}</b>`, ""];

  if (n.who || n.amount) {
    const who = n.who ? esc(n.who) : "?";
    const amount = n.amount ? esc(n.amount) : "";
    lines.push(n.direction === "i_owe" ? `Ты должен: <b>${who}</b>, ${amount}` : `<b>${who}</b> должен тебе ${amount}`);
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

async function mainView(user: User): Promise<View> {
  let text = "<b>Меню мини.автора</b> ✍️\n\n";
  if (user.group) {
    const g = await loadGroup(user.group);
    const def = g.topics.find((t) => t.id === g.def);
    text +=
      `Групка: ${g.title ? `«${esc(g.title)}» ` : ""}падключена ✅\n` +
      `Топиков: ${g.topics.length}\n` +
      `Запасной топик: ${def ? esc(def.name) : "нету"}\n`;
    if (!g.topics.length) text += "\n⚠️ Я пока не знаю ни одного топика, ой. Зайди в нужный топик групки и напиши там любое сообщение или /ids.\n";
  } else {
    text += "Групка: не падключена, ой ⚠️\nТыкни «Подключить группу»: там пошаговая инструкция.\n";
  }
  text += `Стиль: ${STYLES[user.style].label}\nЧасовой пояс: ${esc(user.tz)}\n\nЧтобы я записал заметку, просто пиши мне сообщение. Я понимаю (хз).`;

  return {
    text,
    kb: {
      inline_keyboard: [
        [btn("📂 Мои топики", "topics")],
        [btn("⭐ Запасной топик", "defmenu"), btn(user.group ? "🔌 Моя группа" : "➕ Подключить группу", "connect")],
        [btn("⚙️ Настройки", "set"), btn("❓ Памагите", "help")],
        [btn("✍️ Автор бота", "author")],
      ],
    },
  };
}

async function connectView(user: User): Promise<View> {
  const name = await botName();
  const text =
    "<b>Как падключить свою групку</b>\n\n" +
    "1. Создай группу в Telegram и включи в ней «Темы» (настройки группы → Темы). Сделай это <b>до</b> добавления бота: при включении тем у группы меняется внутренний номер.\n" +
    "2. Создай топики под свои заметки: «Покупки», «Идеи», «Фильмы», «Долги» и так далее. Названия любые, я выбираю по смыслу.\n" +
    "3. Добавь меня в группу и сделай админом. Без админки я не вижу сообщения в топиках.\n" +
    "4. В группе напиши /connect (подключить может только админ группы). Я подтвержу.\n" +
    "5. Зайди в каждый нужный топик и напиши там любое сообщение или /ids. Один раз на топик. Новые топики подхвачу сам.\n" +
    "6. Вернись сюда и пиши заметки. Я выберу топик и опубликую.\n\n" +
    "В группу можно добавить других людей: они будут видеть заметки, а настройки топиков меняет только тот, кто подключил группу. " +
    "Одна группа на одного пользователя: если подключишь другую, старая отвяжется.";
  const rows: Button[][] = [];
  if (name) rows.push([urlBtn("➕ Добавить бота в группу", `https://t.me/${name}?startgroup=connect&admin=manage_topics`)]);
  if (user.group) {
    const g = await loadGroup(user.group);
    rows.push([btn(`🔌 Отключить «${g.title || "группу"}»`.slice(0, 60), "dis")]);
  }
  rows.push([backBtn("menu", "◀️ В меню")]);
  return { text, kb: { inline_keyboard: rows } };
}

async function topicsView(user: User): Promise<View> {
  if (!user.group) return connectView(user);
  const { topics, def } = await loadGroup(user.group);
  if (!topics.length) {
    return {
      text:
        "Топиков пока нету 😢\n\nЗайди в нужный топик в группе и напиши там любое сообщение (или /ids). Запомню. Один раз на топик.",
      kb: { inline_keyboard: [[backBtn("menu", "◀️ В меню")]] },
    };
  }
  const rows: Button[][] = topics.map((t) => [btn(`${t.id === def ? "⭐ " : ""}${t.name}`.slice(0, 60), `t:${t.id}`)]);
  rows.push([backBtn("menu", "◀️ В меню")]);
  return {
    text: `<b>Мои топики</b> (${topics.length})\n\nТыкни на топик, там настройки.`,
    kb: { inline_keyboard: rows },
  };
}

async function topicView(user: User, id: number): Promise<View> {
  if (!user.group) return connectView(user);
  const { topics, def } = await loadGroup(user.group);
  const t = topics.find((x) => x.id === id);
  if (!t) return topicsView(user);
  const isDef = t.id === def;

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

async function defView(user: User): Promise<View> {
  if (!user.group) return connectView(user);
  const { topics, def } = await loadGroup(user.group);
  const rows: Button[][] = topics.map((t) => [btn(`${t.id === def ? "✅ " : ""}${t.name}`.slice(0, 60), `s:${t.id}`)]);
  rows.push([backBtn("menu", "◀️ В меню")]);
  return {
    text: topics.length
      ? "<b>Запасной топик</b>\n\nСюда кидаю всё, че некуда деть. Выбери топик:"
      : "Топиков пока нету, запасной выбирать не из чего. Сначала покажи мне топики: напиши /ids в каждом нужном.",
    kb: { inline_keyboard: rows },
  };
}

function settingsView(user: User): View {
  const styleRows: Button[][] = (Object.keys(STYLES) as Style[]).map((s) => [
    btn(`${user.style === s ? "✅ " : ""}${STYLES[s].label}: ${STYLES[s].hint}`.slice(0, 60), `st:${s}`),
  ]);
  const tzRows: Button[][] = [];
  for (let i = 0; i < TZ_PRESETS.length; i += 2) {
    tzRows.push(
      TZ_PRESETS.slice(i, i + 2).map(([label, tz], j) => btn(`${user.tz === tz ? "✅ " : ""}${label}`, `tz:${i + j}`))
    );
  }
  return {
    text:
      "<b>Настройки</b>\n\n" +
      `<b>Стиль</b> заметок и ответов: ${STYLES[user.style].label}\n` +
      `<b>Часовой пояс:</b> ${esc(user.tz)}\n` +
      "Он нужен, чтобы я правильно понимал «завтра» и «в пятницу». Нет своего города в кнопках? Напиши, например, <code>/tz Europe/Helsinki</code>",
    kb: {
      inline_keyboard: [
        ...styleRows,
        ...tzRows,
        [btn("🗑 Удалить мои данные", "del")],
        [backBtn("menu", "◀️ В меню")],
      ],
    },
  };
}

const helpView = (): View => ({
  text:
    "<b>Памагите, как этим пользоваться</b>\n\n" +
    "Пиши мне в личку что угодно: идеи, долги, фильмы, дела, ссылки. Я сам выберу топик в твоей группе и оформлю заметку (ну я стараюсь). Если просто поболтать, отвечу и ничего не запишу.\n\n" +
    "Если кладу не туда: «Мои топики» → топик → «Подсказка для бота» (коротко, что сюда класть).\n\n" +
    "<b>Первый запуск:</b> нажми «Подключить группу», там инструкция из шести шагов.\n\n" +
    "<b>Команды в личке:</b>\n" +
    "/menu: меню\n" +
    "/topics: мои топики\n" +
    "/connect: как подключить группу\n" +
    "/settings: стиль и часовой пояс\n" +
    "/tz Europe/Helsinki: свой часовой пояс\n" +
    "/deleteme: удалить мои данные\n\n" +
    "<b>Команды в группе</b> (только у того, кто подключил группу, в нужном топике):\n" +
    "/connect: подключить группу (админ группы)\n" +
    "/ids: запомнить топик\n" +
    "/desc текст: подсказка для топика\n" +
    "/default: сделать топик запасным\n" +
    "/forget: забыть топик\n" +
    "/disconnect: отключить группу",
  kb: { inline_keyboard: [[backBtn("menu", "◀️ В меню")]] },
});

const authorView = (): View => ({
  text:
    "<b>Автор бота</b> ✍️\n\n" +
    "Меня придумал <b>влад.автор</b>, а я его мини-автор, хихи. Я маленький, но стараюсь!\n\nТут всякие ево штуки: таплинк и тг-канал. Ни стисняйся, тыкай!",
  kb: {
    inline_keyboard: [
      [urlBtn("🔗 Таплинк", "https://taplink.cc/awtor")],
      [urlBtn("📣 Тг-канал", "https://t.me/vladavtorx")],
      [backBtn("menu", "◀️ В меню")],
    ],
  },
});

async function sendView(chatId: number | string, v: View) {
  return tg("sendMessage", {
    chat_id: chatId,
    text: v.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: v.kb,
  });
}

async function setupCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "menu", description: "Открыть менюшку" },
      { command: "topics", description: "Мои топики" },
      { command: "connect", description: "Как подключить группу" },
      { command: "settings", description: "Стиль и часовой пояс" },
      { command: "help", description: "Памагите" },
      { command: "author", description: "Автор бота" },
    ],
    scope: { type: "all_private_chats" },
  });
  await tg("setMyCommands", {
    commands: [
      { command: "connect", description: "Подключить группу (админ)" },
      { command: "ids", description: "Запомнить этот топик" },
      { command: "desc", description: "Подсказка: что сюда класть" },
      { command: "default", description: "Сделать запасным топиком" },
      { command: "forget", description: "Забыть этот топик" },
      { command: "disconnect", description: "Отключить группу" },
    ],
    scope: { type: "all_group_chats" },
  });
  await tg("setChatMenuButton", { menu_button: { type: "commands" } });
}

async function ensureCommands(force = false) {
  if (!force && (await redis(["GET", "cmds:v2"]))) return;
  await setupCommands();
  await redis(["SET", "cmds:v2", "1"]);
}

// ---------- Кнопки ----------

async function handleCallback(cb: any) {
  const ack = (text?: string) => tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text } : {}) });

  const uid = String(cb.from?.id ?? "");
  const chatId = cb.message?.chat?.id;
  const mid = cb.message?.message_id;
  if (!uid || !chatId || !mid || cb.message?.chat?.type !== "private" || !REDIS_URL) {
    await ack();
    return;
  }
  if (isOwner(uid)) await migrateLegacy();
  const loaded = await loadUser(uid);
  if (loaded.banned) {
    await ack();
    return;
  }
  let user = loaded.user;

  const [action, arg1] = String(cb.data ?? "").split(":");
  const id = Number(arg1);
  const show = (v: View) =>
    tg("editMessageText", {
      chat_id: chatId,
      message_id: mid,
      text: v.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: v.kb,
    });

  const needsGroup = ["topics", "t", "defmenu", "d", "dc", "s", "x", "f", "ff", "dis", "disyes"];
  if (needsGroup.includes(action) && !user.group) {
    await show(await connectView(user));
    await ack("Сначала падключи групку");
    return;
  }
  const chat = user.group ?? "";

  let toast: string | undefined;

  switch (action) {
    case "menu":
      await show(await mainView(user));
      break;
    case "topics":
      await show(await topicsView(user));
      break;
    case "t":
      await show(await topicView(user, id));
      break;
    case "defmenu":
      await show(await defView(user));
      break;
    case "connect":
      await show(await connectView(user));
      break;
    case "help":
      await show(helpView());
      break;
    case "author":
      await show(authorView());
      break;
    case "set":
      await show(settingsView(user));
      break;
    case "st": {
      if (isStyle(arg1)) {
        await redis(["HSET", `u:${uid}`, "style", arg1]);
        user = { ...user, style: arg1 };
        toast = "Стиль изменён";
      }
      await show(settingsView(user));
      break;
    }
    case "tz": {
      const preset = TZ_PRESETS[id];
      if (preset) {
        await redis(["HSET", `u:${uid}`, "tz", preset[1]]);
        user = { ...user, tz: preset[1] };
        toast = "Часовой пояс изменён";
      }
      await show(settingsView(user));
      break;
    }
    case "d": {
      // Ждём следующее сообщение пользователя как подсказку для этого топика
      const { topics } = await loadGroup(chat);
      const t = topics.find((x) => x.id === id);
      if (!t) {
        await show(await topicsView(user));
        break;
      }
      await redis(["SET", `st:${uid}`, JSON.stringify({ action: "desc", thread: id }), "EX", 600]);
      await show({
        text: `Напиши одним сообщением, что класть в «${esc(t.name)}».\n\nНапример: фильмы и сериалы, которые хочу посмотреть.`,
        kb: { inline_keyboard: [[btn("Отмена", `cancel:${id}`)]] },
      });
      break;
    }
    case "cancel":
      await redis(["DEL", `st:${uid}`]);
      await show(await topicView(user, id));
      break;
    case "dc":
      await redis(["HDEL", `d:${chat}`, String(id)]);
      toast = "Подсказку убрал";
      await show(await topicView(user, id));
      break;
    case "s":
      await redis(["SET", `def:${chat}`, String(id)]);
      toast = "Запасной топик теперь другой";
      await show(await topicView(user, id));
      break;
    case "x": {
      const r = await tg("sendMessage", {
        chat_id: chat,
        message_thread_id: id,
        text: "🧪 Проверка связи. Я тут, топик вижу",
      });
      toast = r.ok ? "Кинул проверку в топик" : `Не получилось: ${r.description ?? "ошибка"}`;
      break;
    }
    case "f": {
      const { topics } = await loadGroup(chat);
      const t = topics.find((x) => x.id === id);
      if (!t) {
        await show(await topicsView(user));
        break;
      }
      await show({
        text:
          `Забыть топик «${esc(t.name)}»?\n\n` +
          "Я перестану туда писать. Сам топик в группе не удалится, а вернуть его можно командой /ids.",
        kb: { inline_keyboard: [[btn("Да, забыть", `ff:${id}`), btn("Нет", `t:${id}`)]] },
      });
      break;
    }
    case "ff": {
      await redisPipe([["HDEL", `t:${chat}`, String(id)], ["HDEL", `d:${chat}`, String(id)]]);
      const def = await redis(["GET", `def:${chat}`]);
      if (def && Number(def) === id) await redis(["DEL", `def:${chat}`]);
      toast = "Забыл, ага";
      await show(await topicsView(user));
      break;
    }
    case "dis":
      await show({
        text:
          "Отключить группу?\n\nЯ перестану писать туда заметки. Список топиков и подсказки сохранятся: если подключишь эту же группу снова командой /connect, всё вернётся.",
        kb: { inline_keyboard: [[btn("Да, отключить", "disyes"), btn("Нет", "connect")]] },
      });
      break;
    case "disyes":
      await unlinkGroup(chat, uid);
      user = { ...user, group: undefined };
      toast = "Группа отключена";
      await show(await connectView(user));
      break;
    case "del":
      await show({
        text:
          "<b>Удалить мои данные?</b>\n\n" +
          "Я сотру: подключение группы, список топиков и подсказки, историю диалога и настройки.\n" +
          "Заметки, которые уже лежат в твоей группе, останутся: их можно удалить вручную. Из группы я сам не выйду, убери меня оттуда, если нужно.",
        kb: { inline_keyboard: [[btn("Да, удалить", "delyes"), btn("Нет", "set")]] },
      });
      break;
    case "delyes":
      await wipeUser(user);
      toast = "Данные удалены";
      await show({ text: "Готово, твои данные удалены. Если захочешь вернуться, напиши /start.", kb: { inline_keyboard: [] } });
      break;
  }

  await ack(toast);
}

// ---------- Группа ----------

async function groupHello(chat: string, thread: number | undefined, force: boolean) {
  if (!force) {
    const first = await redis(["SET", `hello:${chat}`, "1", "NX", "EX", 120]);
    if (!first) return;
  }
  const owner = await getGroupOwner(chat);
  const name = await botName();
  if (owner) {
    await sayIn(
      chat,
      thread,
      "Группа уже подключена ✅ Настройки топиков меняет тот, кто её подключил (команды /ids, /desc, /default, /forget, /disconnect). Заметки пишутся мне в личку" +
        (name ? `: @${name}` : "") +
        "."
    );
    return;
  }
  await sayIn(
    chat,
    thread,
    "Хай! Я мини.автор: ты пишешь мне в личку, а я раскидываю заметки по топикам этой групки.\n\n" +
      "Чтобы начать:\n" +
      "1. Сделай меня админом группы (иначе я не вижу сообщения в топиках).\n" +
      "2. Админ группы пишет здесь /connect.\n" +
      "3. В каждом нужном топике напиши любое сообщение или /ids.\n" +
      "4. Открой личку со мной" +
      (name ? ` (@${name})` : "") +
      ", нажми Старт и пиши заметки.\n\n" +
      "Подробная инструкция в личке по кнопке «Подключить группу» или командой /connect."
  );
}

async function connectGroup(msg: any, uid: string) {
  const chat = String(msg.chat.id);
  const thread: number | undefined = msg.message_thread_id;
  const say = (t: string) => sayIn(chat, thread, t);

  if (!uid) return;
  if (msg.sender_chat) {
    await say("Ты пишешь от имени группы (анонимный админ). Выключи «Анонимность» в своих правах админа или напиши /connect с личного аккаунта.");
    return;
  }
  const { banned } = await loadUser(uid);
  if (banned) return;

  const mem = await tg("getChatMember", { chat_id: chat, user_id: Number(uid) });
  const st = mem.result?.status;
  if (st !== "creator" && st !== "administrator") {
    await say("Подключить группу может только её админ. Пусть админ напишет /connect.");
    return;
  }
  const owner = await getGroupOwner(chat);
  if (owner && owner !== uid) {
    await say("Эта группа уже подключена к другому пользователю. Пусть он напишет /disconnect, после этого можно подключить заново.");
    return;
  }
  const info = await tg("getChat", { chat_id: chat });
  if (!info.result?.is_forum) {
    await say(
      "В группе не включены темы (Topics). Открой настройки группы, включи «Темы» и напиши /connect ещё раз. После включения тем номер группы меняется, поэтому подключать нужно именно после."
    );
    return;
  }
  const bot = await tg("getChatMember", { chat_id: chat, user_id: Number(BOT_ID) });
  const botIsAdmin = bot.result?.status === "administrator";
  const title: string = info.result?.title ?? msg.chat.title ?? "";
  await linkGroup(uid, chat, title);

  const name = await botName();
  await say(
    `Готово, групка «${esc(title)}» падключена ✅\n\n` +
      (botIsAdmin ? "" : "⚠️ Я пока не админ. Сделай меня админом, иначе я не вижу сообщения в топиках и не запомню их.\n\n") +
      "Дальше:\n" +
      "1. В каждом топике, куда я должен писать заметки, напиши любое сообщение или /ids. Новые топики подхвачу сам.\n" +
      `2. Открой личку со мной${name ? ` (@${name})` : ""}, нажми Старт и пиши заметки.`
  );
}

async function handleGroup(msg: any) {
  if (!REDIS_URL) return;
  const chat = String(msg.chat.id);
  const fromId = msg.from?.id ? String(msg.from.id) : "";

  // Группа стала супергруппой (например, после включения тем): переносим подключение на новый номер
  if (msg.migrate_to_chat_id) {
    const next = String(msg.migrate_to_chat_id);
    const owner = await getGroupOwner(chat);
    if (owner) {
      await redisPipe([
        ["HSET", `g:${next}`, "owner", owner, "title", msg.chat.title ?? ""],
        ["HSET", `u:${owner}`, "group", next],
        ["DEL", `g:${chat}`],
      ]);
    }
    return;
  }

  const text: string = msg.text ?? msg.caption ?? "";
  const parts = text.trim().split(/\s+/);
  const rawCmd = parts[0] ?? "";
  const [cmdName, cmdBot] = rawCmd.split("@");
  const cmd = cmdName.toLowerCase();
  const arg = text.trim().slice(rawCmd.length).trim();

  // Команда адресована другому боту: не трогаем
  if (rawCmd.startsWith("/") && cmdBot && (await botName()).toLowerCase() !== cmdBot.toLowerCase()) return;

  const threadId: number | undefined = msg.message_thread_id;
  const say = (t: string) => sayIn(chat, threadId, t);

  // Работают и до подключения
  if (cmd === "/connect") {
    await connectGroup(msg, fromId);
    return;
  }
  if (cmd === "/start" || cmd === "/help") {
    await groupHello(chat, threadId, cmd === "/help");
    return;
  }

  // Неподключённые группы игнорируем
  const owner = await getGroupOwner(chat);
  if (!owner) return;
  const isOwnerHere = owner === fromId;

  const service = Boolean(msg.forum_topic_created || msg.forum_topic_edited);
  const topicName: string | undefined =
    msg.forum_topic_created?.name ?? msg.forum_topic_edited?.name ?? msg.reply_to_message?.forum_topic_created?.name;

  // Сообщение владельца в топике запоминает этот топик (команда /ids не обязательна)
  let madeDefault = false;
  let isNew = false;
  if (threadId && topicName && (service || isOwnerHere)) {
    const r = await registerTopic(chat, threadId, topicName);
    madeDefault = r.madeDefault;
    isNew = r.isNew;
  }

  // Тихо подтверждаем реакцией, что запомнил новый топик
  if (isNew && isOwnerHere && !service && !GROUP_COMMANDS.includes(cmd) && msg.message_id) {
    await tg("setMessageReaction", {
      chat_id: chat,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "🤪" }],
    });
  }

  if (!GROUP_COMMANDS.includes(cmd)) return;
  if (!isOwnerHere) {
    await say("Эти команды работают только у того, кто подключил группу.");
    return;
  }

  if (cmd === "/disconnect") {
    await unlinkGroup(chat, owner);
    await say("Группа отключена. Список топиков я пока храню: если подключишь снова командой /connect, всё вернётся.");
  } else if (!threadId) {
    await say("Это общий топик (General), его я не запоминаю. Команды работают в обычных топиках.");
  } else if (cmd === "/ids") {
    if (!topicName) {
      await say(`Не вижу, как называется топик (thread_id ${threadId}). Переименуй топик и напиши /ids ещё раз.`);
    } else {
      await say(
        `Запомнил «${esc(topicName)}»! Теперь могу кидать сюда заметки 🤪` +
          (madeDefault ? "\nЭтот топик стал запасным: сюда пойдёт всё, че некуда деть." : "")
      );
    }
  } else if (cmd === "/desc") {
    if (!arg) {
      await say("Напиши так: /desc что сюда класть. Например: /desc фильмы и сериалы, которые хочу посмотреть");
    } else {
      if (topicName) await redis(["HSET", `t:${chat}`, String(threadId), topicName]);
      await redis(["HSET", `d:${chat}`, String(threadId), arg.slice(0, 300)]);
      await say("Записал подсказку для этого топика.");
    }
  } else if (cmd === "/default") {
    await redis(["SET", `def:${chat}`, String(threadId)]);
    await say("Теперь это запасной топик: сюда пойдёт всё, че некуда деть.");
  } else if (cmd === "/forget") {
    await redisPipe([["HDEL", `t:${chat}`, String(threadId)], ["HDEL", `d:${chat}`, String(threadId)]]);
    const def = await redis(["GET", `def:${chat}`]);
    if (def && Number(def) === threadId) await redis(["DEL", `def:${chat}`]);
    await say("Забыл этот топик. Чтобы вернуть, напиши /ids.");
  }
}

// Бота добавили в группу, сделали админом или удалили из неё
async function handleMyChatMember(u: any) {
  const chat = u.chat;
  if (!REDIS_URL || !chat || chat.type === "private") return;
  const chatId = String(chat.id);
  const status: string | undefined = u.new_chat_member?.status;

  if (status === "left" || status === "kicked") {
    const owner = await getGroupOwner(chatId);
    if (owner) {
      await unlinkGroup(chatId, owner);
      await tg("sendMessage", {
        chat_id: owner,
        text: `Меня убрали из группы «${chat.title ?? ""}», подключение сброшено. Чтобы вернуть: добавь меня в группу снова и напиши там /connect.`,
      });
    }
    return;
  }

  if (status === "member" || status === "administrator") {
    if (await getGroupOwner(chatId)) return;
    await groupHello(chatId, undefined, false);
  }
}

// ---------- Личка ----------

async function handlePrivate(msg: any) {
  const uid = String(msg.from?.id ?? "");
  const chatId = msg.chat.id;
  if (!uid) return;
  const send = (t: string) => tg("sendMessage", { chat_id: chatId, text: t });

  if (!REDIS_URL) {
    await send("Бот пока не настроен: к проекту не подключена база данных. Напиши админу бота.");
    return;
  }
  if (isOwner(uid)) await migrateLegacy();
  const { user, banned } = await loadUser(uid);
  if (banned) return;

  const text: string = msg.text ?? msg.caption ?? "";
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? "").split("@")[0].toLowerCase();
  const arg = text.trim().slice((parts[0] ?? "").length).trim();

  if (cmd === "/start") {
    await ensureCommands(isOwner(uid));
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        "Хай. Я мини.автор ✍️ Пиши заметки, я раскидаю по топикам в твоей групке. А если просто поболтать, отвечу и ничего не запишу. Меню снизу",
      reply_markup: {
        keyboard: [[{ text: MENU_BUTTON_TEXT }]],
        resize_keyboard: true,
        is_persistent: true,
      },
    });
    await sendView(chatId, user.group ? await mainView(user) : await connectView(user));
    return;
  }

  if (cmd === "/menu" || MENU_BUTTON_TEXTS.includes(text.trim())) {
    await redis(["DEL", `st:${uid}`]);
    await sendView(chatId, await mainView(user));
    return;
  }
  if (cmd === "/topics") return void (await sendView(chatId, await topicsView(user)));
  if (cmd === "/connect") return void (await sendView(chatId, await connectView(user)));
  if (cmd === "/settings") return void (await sendView(chatId, settingsView(user)));
  if (cmd === "/help") return void (await sendView(chatId, helpView()));
  if (cmd === "/author") return void (await sendView(chatId, authorView()));

  if (cmd === "/cancel") {
    await redis(["DEL", `st:${uid}`]);
    await send("Ладна, атменил.");
    return;
  }

  if (cmd === "/tz") {
    if (!arg) {
      await send(`Сейчас часовой пояс: ${user.tz}\nЧтобы поменять, напиши, например: /tz Europe/Helsinki`);
      return;
    }
    const tz = normTz(arg);
    if (!tz) {
      await send("Не знаю такой часовой пояс. Формат: Регион/Город, например Europe/Helsinki, Asia/Almaty, America/New_York.");
      return;
    }
    await redis(["HSET", `u:${uid}`, "tz", tz]);
    await send(`Готово, часовой пояс: ${tz}`);
    return;
  }

  if (cmd === "/deleteme") {
    await sendView(chatId, {
      text: "<b>Удалить мои данные?</b>\n\nЯ сотру подключение группы, список топиков и подсказки, историю диалога и настройки. Заметки в самой группе останутся.",
      kb: { inline_keyboard: [[btn("Да, удалить", "delyes"), btn("Нет", "menu")]] },
    });
    return;
  }

  // Команды админа бота
  if (isOwner(uid) && cmd === "/stats") {
    const [users, bannedCount] = await redisPipe([["SCARD", "users"], ["SCARD", "banned"]]);
    await send(`Пользователей: ${users ?? 0}\nЗабанено: ${bannedCount ?? 0}\nЛимит: ${LIMIT ? `${LIMIT} сообщений в сутки на человека` : "без лимита"}`);
    return;
  }
  if (isOwner(uid) && (cmd === "/ban" || cmd === "/unban")) {
    if (!/^\d+$/.test(arg)) {
      await send(`Напиши так: ${cmd} 123456789 (Telegram id человека)`);
      return;
    }
    await redis([cmd === "/ban" ? "SADD" : "SREM", "banned", arg]);
    await send(cmd === "/ban" ? `Заблокировал ${arg}` : `Разблокировал ${arg}`);
    return;
  }

  if (cmd.startsWith("/")) {
    await send("Не знаю такой команды. Открой /menu или /help");
    return;
  }

  // Если ждём подсказку для топика, это сообщение и есть подсказка
  if (text.trim() && user.group) {
    const raw = await redis(["GET", `st:${uid}`]);
    if (raw) {
      let state: any = null;
      try {
        state = JSON.parse(String(raw));
      } catch {}
      if (state?.action === "desc" && state.thread) {
        await redisPipe([["HSET", `d:${user.group}`, String(state.thread), text.trim().slice(0, 300)], ["DEL", `st:${uid}`]]);
        await sendView(chatId, await topicView(user, Number(state.thread)));
        return;
      }
    }
  }

  if (!text.trim()) {
    await send("Я пока понимаю только текст и подписи к фоткам. Голосовые хз");
    return;
  }

  // Без группы заметки класть некуда: показываем инструкцию, нейросеть не тратим
  if (!user.group) {
    await tg("sendMessage", { chat_id: chatId, text: "Сначала надо падключить групку с топиками. Вот как:" });
    await sendView(chatId, await connectView(user));
    return;
  }

  const group = await loadGroup(user.group);
  if (!group.topics.length) {
    await send(
      "Групка падключена, но топиков я пока не знаю. Зайди в нужный топик и напиши там любое сообщение или /ids. Один раз на топик, и кидай заметки"
    );
    return;
  }

  const limit = await checkLimit(uid);
  if (!limit.ok) {
    await send(`На сегодня лимит всё: ${LIMIT} сообщений в сутки. Завтра обнулится`);
    return;
  }

  const fallback = group.topics.find((t) => t.id === group.def);
  const history = await loadHistory(uid);

  let parsed: Parsed;
  try {
    parsed = await extractNotes(text.slice(0, 4000), group.topics, fallback, history, user);
  } catch (e: any) {
    if (e instanceof LLMDown) {
      console.error(e.message);
      await send("Нейронки щас все отвалились, хз. Попробуй через пару минут");
      await notifyOwner(`⚠️ У пользователя ${uid} не ответила ни одна нейросеть.\n${e.message}`, "llm");
      return;
    }
    throw e;
  }
  const { notes, reply } = parsed;

  if (!notes.length && !reply) {
    await send("Ты че несешь, не понял. Напиши по-другому?");
    return;
  }

  // Просто разговор: отвечаем в личке, в топики ничего не пишем
  if (reply) await send(reply);

  const saved: string[] = [];
  for (const note of notes) {
    const target = group.topics.find((t) => t.label === note.topic) ?? fallback;
    if (!target) {
      saved.push(`⚠️ «${note.title}»: не нашёл куда деть, ой`);
      continue;
    }
    const r = await tg("sendMessage", {
      chat_id: user.group,
      message_thread_id: target.id,
      text: formatNote(note),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    if (r.ok) {
      saved.push(`${safeEmoji(note.emoji)} ${target.name}: ${note.title}`);
      continue;
    }
    const d = String(r.description ?? "ошибка");
    if (/thread not found/i.test(d)) {
      await redisPipe([["HDEL", `t:${user.group}`, String(target.id)], ["HDEL", `d:${user.group}`, String(target.id)]]);
      saved.push(`⚠️ «${target.name}»: топик удалён в группе, я его забыл. Заметка «${note.title}» не отправилась, пришли её ещё раз`);
    } else if (/chat not found|kicked|not a member|forbidden/i.test(d)) {
      saved.push(`⚠️ Не могу писать в группу. Проверь, что я в ней и я админ`);
    } else {
      saved.push(`⚠️ ${target.name}: не отправилось (${d})`);
    }
  }

  if (notes.length) await send(`Записал, всм норм\n${saved.join("\n")}`);
  await saveHistory(uid, history, text, reply, notes);
}

// ---------- Основной обработчик ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(200).send("ok");

  // Проверяем, что запрос реально от Telegram
  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const upd = req.body;
  try {
    if (upd?.callback_query) {
      await handleCallback(upd.callback_query);
    } else if (upd?.my_chat_member) {
      await handleMyChatMember(upd.my_chat_member);
    } else if (upd?.message) {
      if (upd.message.chat?.type === "private") await handlePrivate(upd.message);
      else await handleGroup(upd.message);
    }
  } catch (e: any) {
    console.error(e);
    // Всё равно отвечаем 200, иначе Telegram будет слать сообщение повторно
    const m = upd?.message ?? upd?.callback_query?.message;
    const uid = upd?.message?.from?.id ?? upd?.callback_query?.from?.id;
    if (m?.chat?.type === "private" && m.chat.id) {
      await tg("sendMessage", {
        chat_id: m.chat.id,
        text: isOwner(uid)
          ? `Бля, че-т сломалось. Глянь логи в Vercel, даун\n\nОшибка: ${String(e?.message ?? e).slice(0, 300)}`
          : "Бля, че-т сломалось, даун. Попробуй еще раз чуть позже",
      });
      if (!isOwner(uid)) await notifyOwner(`⚠️ Ошибка у пользователя ${uid}: ${String(e?.message ?? e).slice(0, 300)}`, "err");
    }
  }

  return res.status(200).send("ok");
}
