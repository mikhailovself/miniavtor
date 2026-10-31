// Логика поведения бота в группе: история чата, «система обиды», признание ошибок, род и имена,
// защита от повторов и действия, которые бот может вызывать по просьбе (стикер, гифка, реакция и т. д.).
// Здесь нет Redis и Telegram: только чистые функции, чтобы их можно было проверить тестом (group-chat.test.ts).

// ───────────────────────── настройки (меняй числа тут) ─────────────────────────
export const HISTORY_LINES = 12;            // сколько последних сообщений чата видит нейросеть
export const HISTORY_KEEP = 30;             // сколько хранится в Redis
export const HISTORY_TTL_SEC = 6 * 3600;
export const LINE_MAX = 300;                // длина одной строки в истории

export const QUARREL_MIN = 4;               // слив из спора с одним человеком: после 4…7 обменов
export const QUARREL_MAX = 7;
export const QUARREL_WINDOW_SEC = 600;     // пауза в споре дольше 10 минут сбрасывает счётчик
export const CHAT_HEAT_MIN = 12;            // общий накал чата: после 12…16 ответов бот обижается на весь чат
export const CHAT_HEAT_MAX = 16;
export const OFFENSE_USER_SEC = 30 * 60;    // обида на человека
export const OFFENSE_CHAT_SEC = 20 * 60;    // обида на весь чат

export const PUSHBACK_MIN = 4;              // признать ошибку: после 4…6 «ты не прав»
export const PUSHBACK_MAX = 6;
export const PUSHBACK_WINDOW_SEC = 900;

export const LIMIT_NOTICE = "на сегодня я всё, чет вы подзаебали";

// ───────────────────────── история чата ─────────────────────────
export type Form = "он" | "она" | "?";
export type GroupLine = { ts: number; uid: string; name: string; form: Form; bot?: boolean; mid?: number; to?: string; text: string };

export function cleanLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
}

export function serializeLine(line: GroupLine): string {
  return JSON.stringify({ ...line, text: cleanLine(line.text) });
}

export function parseLine(raw: unknown): GroupLine | null {
  try {
    const x = JSON.parse(String(raw));
    if (!x || typeof x.text !== "string" || typeof x.name !== "string") return null;
    return {
      ts: Number(x.ts) || 0, uid: String(x.uid ?? ""), name: x.name, form: x.form === "он" || x.form === "она" ? x.form : "?",
      bot: x.bot === true, mid: typeof x.mid === "number" ? x.mid : undefined, to: typeof x.to === "string" ? x.to : undefined, text: x.text,
    };
  } catch { return null; }
}

// Redis отдаёт список от новых к старым. Возвращаем от старых к новым, не больше HISTORY_LINES.
export function orderHistory(raw: unknown[]): GroupLine[] {
  return raw.map(parseLine).filter((x): x is GroupLine => Boolean(x)).slice(0, HISTORY_LINES).reverse();
}

const FORM_LABEL: Record<Form, string> = { "он": " (он)", "она": " (она)", "?": " (род неизвестен)" };

export function formatHistory(lines: GroupLine[]): string {
  if (!lines.length) return "(пока пусто)";
  return lines.map((l) => {
    const who = l.bot ? "МИНИ.АВТОР (это ты)" : `${l.name}${FORM_LABEL[l.form]}`;
    return `${who}${l.to ? ` → ${l.to}` : ""}: ${l.text}`;
  }).join("\n");
}

// ───────────────────────── повторы ─────────────────────────
export const normText = (s: string): string =>
  String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9 ]+/g, " ").replace(/(.)\1{2,}/g, "$1$1").replace(/\s+/g, " ").trim();

function tokens(s: string): Set<string> { return new Set(normText(s).split(" ").filter((w) => w.length > 2)); }

// Строка повторяет одну из недавних реплик бота: точное совпадение или почти (Жаккар ≥ 0.75).
export function isRepeat(line: string, recent: string[]): boolean {
  const n = normText(line);
  if (!n) return false;
  const a = tokens(line);
  return recent.some((r) => {
    const m = normText(r);
    if (!m) return false;
    if (m === n) return true;
    const b = tokens(r);
    if (a.size < 3 || b.size < 3) return false;
    const common = [...a].filter((w) => b.has(w)).length;
    return common / new Set([...a, ...b]).size >= 0.75;
  });
}

// ───────────────────────── накал, ошибки, извинения ─────────────────────────
const HEATED = /(?:нах[уy]й|пизд|еб[ал]|ебу|ёб|долбо|туп(?:ой|ая|ое|ые)|дебил|идиот|мудил|чмо|лох|заткнись|соси|немощ|терпил|ублюд|мраз|урод|бесишь|заебал|сдох|кик(?:аю|нем)|удалите|вонюч|бесполезн)/i;
const PUSHBACK = /(?:не\s+прав|врёшь|врешь|лжёшь|лжешь|пиздишь|придума|выдума|газлайт|ошиб(?:ся|ка|лся|лась)|какой\s+нах[уy]й|какого\s+хуя|не\s+было\s+такого|откуда\s+ты\s+взял|тебя\s+поймал|поймали\s+на|ты\s+(?:же\s+)?(?:сам\s+)?(?:написал|сказал|говорил)|признай)/i;
const APOLOGY = /(?:извин|прости|простите|сорри|sorry|не\s+обижайся|погорячил|мир\??$|давай\s+мириться|мирись|я\s+был[аи]?\s+не\s+прав)/i;

export const isHeated = (t: string): boolean => HEATED.test(t);
export const isPushback = (t: string): boolean => PUSHBACK.test(t);
export const isApology = (t: string): boolean => APOLOGY.test(t);

export type Counter = { n: number; limit: number };
const roll = (min: number, max: number, rnd: () => number) => min + Math.floor(rnd() * (max - min + 1));

// Один шаг счётчика. Порог (limit) выбирается случайно в начале серии и хранится вместе со счётчиком.
export function stepCounter(prev: Counter | null, min: number, max: number, rnd: () => number = Math.random): { state: Counter; reached: boolean } {
  const state: Counter = prev && prev.limit >= min && prev.limit <= max ? { n: prev.n + 1, limit: prev.limit } : { n: 1, limit: roll(min, max, rnd) };
  return { state, reached: state.n >= state.limit };
}

export function parseCounter(raw: unknown): Counter | null {
  try {
    const x = JSON.parse(String(raw));
    return Number.isFinite(x?.n) && Number.isFinite(x?.limit) ? { n: Number(x.n), limit: Number(x.limit) } : null;
  } catch { return null; }
}

// Подсказки для нейросети. Газлайтинг первые разы остаётся частью характера, признание наступает на пороге.
export function pushbackHint(state: Counter): string {
  return state.n >= state.limit
    ? `[ТЕБЯ ЛОВЯТ НА ОШИБКЕ УЖЕ ${state.n}-Й РАЗ: хватит выкручиваться. Если по истории чата ты правда ошибся или выдумал, признай это коротко и по-своему («ладно, ну да, проебался»), без пафоса и без длинных извинений, и можешь сразу свернуть тему. Больше это не отрицай.]`
    : `[ПОХОЖЕ, ТЕБЯ ЛОВЯТ НА ОШИБКЕ (${state.n}-й раз из нескольких): пока держись характера: отрицай, выкручивайся, газлайти, переводи стрелки, упирайся в шутку. Не признавай вину. Но не выдумывай новых фактов, чтобы прикрыть старые. Если по истории чата тебя на самом деле ни в чём не ловят, а просто спрашивают, игнорируй эту пометку.]`;
}

export const WITHDRAW_USER_HINT = "[СЛИВ: ты устал спорить с ЭТИМ человеком. Ответь одной короткой злой/усталой репликой в духе «бля чел, дос, мне больше не о чем с тобой разговаривать». Своими словами, с матом, без оправданий и без нового наезда по теме спора. Это последняя реплика: потом ты на него обижен.]";
export const WITHDRAW_CHAT_HINT = "[СЛИВ: весь чат тебя задолбал. Ответь одной короткой репликой в духе «всё, вы меня заебали, я ушёл». Своими словами, без нового наезда по теме. Это последняя реплика: потом ты обижен на всех.]";
export const FORGIVE_HINT = "[ОН ИЗВИНИЛСЯ: прости неохотно и коротко, с ворчанием («ладно, живи»), без нового наезда. Обида снята.]";

export const WITHDRAW_FALLBACK = [
  "бля чел, дос, мне больше не о чем с тобой разговаривать",
  "всё, нахуй, заебал, разговор окончен",
  "ты меня утомил, я пошёл, дальше сам с собой спорь",
  "не, с тобой каши не сваришь, я всё",
];
export const WITHDRAW_CHAT_FALLBACK = [
  "всё, вы меня заебали, я ушёл",
  "бля, вы все достали, дальше без меня",
];

// ───────────────────────── обида ─────────────────────────
export const NEGATIVE_REACTIONS = ["👎", "🤡", "💩", "🥱", "🗿", "🌚", "🤨", "😐", "🤮", "😴"] as const;

// Пока бот обижен: примерно 55% обращений игнорируются совсем, остальные получают негативную реакцию.
export function sulkAction(rnd: () => number = Math.random): { kind: "ignore" } | { kind: "react"; emoji: string } {
  if (rnd() < 0.55) return { kind: "ignore" };
  return { kind: "react", emoji: NEGATIVE_REACTIONS[Math.floor(rnd() * NEGATIVE_REACTIONS.length)] };
}

// ───────────────────────── имена и род ─────────────────────────
const FEMALE = new Set(("настя анастасия настюша маша мария машка аня анна соня софа софия софья софийка поли полина катя екатерина оля ольга лена елена ира ирина юля юлия даша дарья наташа наталья вика виктория ксения ксюша лиза елизавета алина алиса диана кристина света светлана таня татьяна милена вера надя надежда люба любовь марина валерия лера карина арина варя варвара ева злата мила маргарита рита александра василиса евгения ангелина яна влада").split(" "));
const MALE = new Set(("влад владислав владос артем артём артюнз ваня иван герман никита глеб макс максим данил данила даня даниил дима дмитрий саня александр алексей леша андрей сергей серёжа сережа антон егор кирилл миша михаил павел паша роман рома ярослав илья денис костя константин николай коля олег игорь виктор тимур евгений федор фёдор степан матвей григорий гриша лев лёва богдан семён семен ренат руслан марк").split(" "));
const AMBIGUOUS = new Set("саша женя валя шура слава ника".split(" "));

export function guessForm(firstName: string): Form {
  const raw = String(firstName ?? "");
  if (/♀/.test(raw)) return "она";
  if (/♂/.test(raw)) return "он";
  const first = raw.toLowerCase().replace(/ё/g, "е").split(/[\s_.\-]+/).map((w) => w.replace(/[^a-zа-я]/g, "")).find(Boolean) ?? "";
  if (!first) return "?";
  const key = first.replace(/ё/g, "е");
  const male = new Set([...MALE].map((x) => x.replace(/ё/g, "е")));
  if (AMBIGUOUS.has(key)) return "?";
  if (FEMALE.has(key)) return "она";
  if (male.has(key)) return "он";
  // «МашаКакаша», «Ваня123»: известное имя в начале слитного ника
  const prefix = (set: Iterable<string>) => [...set].some((n) => n.length >= 4 && key.startsWith(n.replace(/ё/g, "е")));
  if (prefix(FEMALE) && !prefix(male)) return "она";
  if (prefix(male) && !prefix(FEMALE)) return "он";
  return "?";
}

// Человек сам сказал, кто он: «я женщина», «я парень». Главнее любых догадок.
export function statedForm(text: string): Form {
  const t = text.toLowerCase();
  if (/(?:^|[^а-яё])я\s+(?:же\s+|тут\s+|вообще\s+|вообще-то\s+)?(?:женщина|девушка|девочка|баба|тян)(?![а-яё])/.test(t)) return "она";
  if (/(?:^|[^а-яё])я\s+(?:же\s+|тут\s+|вообще\s+|вообще-то\s+)?(?:мужчина|парень|пацан|мальчик|мужик)(?![а-яё])/.test(t)) return "он";
  return "?";
}

export function formRule(form: Form, name: string): string {
  if (form === "она") return `${name}: ЖЕНСКИЙ род. Согласуй всё: «ты сказала», «ты пришла», «тупая», «ебланка». Никогда «сказал/тупой».`;
  if (form === "он") return `${name}: МУЖСКОЙ род. Согласуй всё: «ты сказал», «ты пришёл», «тупой».`;
  return `${name}: род неизвестен. Не гадай: формулируй нейтрально без родовых окончаний («ты это уже говорил(а)» не годится, лучше «ты об этом уже писал в чате», «ну ты даёшь») или обратись по нику.`;
}

// ───────────────────────── действия по просьбе ─────────────────────────
export const REACT_CHOICES = ["👍", "👎", "❤", "🔥", "👏", "🎉", "🤔", "🤯", "😱", "😢", "🤡", "💩", "🥱", "🗿", "🌚", "🤨", "😐", "😁", "🤣", "😈", "💯", "👀", "🙈", "😎", "🤪", "🥴"] as const;

const ONLY_ON_REQUEST = "Вызывай ТОЛЬКО если человек в последнем сообщении прямо просит об этом (или ты сам решил это кинуть как часть ответа). Всегда вместе с chat_reply: короткая реплика в твоём стиле, а если слова не нужны, text = «-».";

export const GROUP_ACTION_DECLARATIONS = [
  {
    name: "send_sticker",
    description: `Кинуть в чат случайный стикер из запаса бота. ${ONLY_ON_REQUEST} Никогда не говори «я не юзаю стикеры»: ты умеешь их кидать.`,
    parameters: { type: "object", properties: { note: { type: "string", description: "Необязательно: к какому настроению стикер, для логов." } } },
  },
  {
    name: "send_meme",
    description: `Кинуть мем из запаса бота (картинку, видео или гифку). ${ONLY_ON_REQUEST}`,
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["any", "photo", "video", "gif"], description: "Какой формат мема. По умолчанию any." } } },
  },
  {
    name: "send_gif",
    description: `Найти и кинуть гифку-реакцию по поисковому тегу. ${ONLY_ON_REQUEST}`,
    parameters: { type: "object", properties: { query: { type: "string", description: "1–2 обычных русских слова: эмоция или действие («фейспалм», «смех», «недоумение»). Без слов «гифка», «gif», «мем»." } }, required: ["query"] },
  },
  {
    name: "react",
    description: `Поставить эмодзи-реакцию на сообщение (на то, что просят, или на сообщение человека). ${ONLY_ON_REQUEST}`,
    parameters: { type: "object", properties: { emoji: { type: "string", enum: [...REACT_CHOICES] } }, required: ["emoji"] },
  },
  {
    name: "remember_fact",
    description: `Запомнить факт для этого чата («запомни, что…»). ${ONLY_ON_REQUEST} Факт формулируй коротко и ровно так, как сказал человек, ничего не добавляя от себя.`,
    parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
  },
  {
    name: "forget_fact",
    description: `Забыть ранее запомненный в этом чате факт («забудь…»). ${ONLY_ON_REQUEST}`,
    parameters: { type: "object", properties: { text: { type: "string", description: "Часть текста факта, который нужно забыть." } }, required: ["text"] },
  },
  {
    name: "send_channel_post",
    description: `Переслать случайный пост из канала автора. ${ONLY_ON_REQUEST}`,
    parameters: { type: "object", properties: { note: { type: "string" } } },
  },
] as const;

export const GROUP_ACTION_NAMES: ReadonlySet<string> = new Set(GROUP_ACTION_DECLARATIONS.map((d) => d.name));

export type GroupAction = { name: string; args: Record<string, any> };

export const MEME_KINDS: Record<string, string[]> = { any: ["p", "v", "a", "s"], photo: ["p"], video: ["v"], gif: ["a"], sticker: ["s"] };

// Из случайной выборки мемов берём первый подходящего формата, не равный последнему отправленному.
export function pickByKind(pool: string[], kinds: string[], last?: string | null): string | null {
  const ok = pool.filter((x) => typeof x === "string" && kinds.includes(x[0]) && x[1] === ":");
  return ok.find((x) => x !== last) ?? ok[0] ?? null;
}
