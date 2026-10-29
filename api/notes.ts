// Логика заметок без сети и Redis: оформление, списки, дополнение, поиск дублей.
// Вынесена из webhook.ts, чтобы её можно было проверять отдельно.

export type ListItem = { text: string; done?: boolean };

export type Note = {
  topic: string; // название топика
  title: string;
  body: string;
  emoji?: string;
  tags?: string[];
  who?: string;
  amount?: string;
  direction?: "owes_me" | "i_owe";
  deadline?: string;
  items?: ListItem[]; // пункты списка: покупки, дела, фильмы на вечер...
};

export type SavedNote = { id: string; chat: string; thread: number; message: number; photo: boolean; note: Note; ts?: number };

export type NoteUpdate = {
  items?: ListItem[];
  id: string;
  // amend: точечно дополнить заметку или список (add_*, check_*, remove_*), не переписывая остальное
  action: "edit" | "paid" | "delete" | "watched" | "done" | "amend";
  remaining_amount?: string; topic?: string; title?: string; body?: string; emoji?: string;
  who?: string; amount?: string; direction?: "owes_me" | "i_owe"; deadline?: string; tags?: string[];
  clear_fields?: string[];
  add_lines?: string[]; add_items?: string[]; check_items?: string[]; uncheck_items?: string[]; remove_items?: string[];
  clear_done?: boolean;
};

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const safeEmoji = (e?: string) => (e && e.length <= 8 ? e : "📌");

export const MAX_TEXT = 3900; // лимит Telegram 4096, оставляем запас
export const MAX_CAPTION = 1000; // подпись к фото: лимит 1024

// ---------- сравнение текста ----------

export const normText = (s: string) =>
  String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const words = (s: string) => normText(s).split(" ").filter((w) => w.length > 2 || /\d/.test(w));
export const wordCount = (s: string) => words(s).length;

// Слова считаем одинаковыми, если у них общее начало: «молоко»/«молока», «Дюна»/«Дюне». Числа сравниваем строго.
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  const n = Math.min(a.length, b.length);
  let m = 0;
  while (m < n && a[m] === b[m]) m++;
  return m >= Math.max(3, n - 2);
}

export function overlap(a: string, b: string): { dice: number; contain: number; matched: number; longest: number } {
  const A = words(a);
  const B = words(b);
  if (!A.length || !B.length) {
    const same = normText(a) !== "" && normText(a) === normText(b) ? 1 : 0;
    return { dice: same, contain: same, matched: same, longest: 0 };
  }
  const used = new Set<number>();
  let matched = 0;
  let longest = 0;
  for (const w of A) {
    const j = B.findIndex((x, k) => !used.has(k) && sameWord(w, x));
    if (j >= 0) {
      used.add(j);
      matched++;
      longest = Math.max(longest, w.length);
    }
  }
  return { dice: (2 * matched) / (A.length + B.length), contain: matched / Math.min(A.length, B.length), matched, longest };
}

// Строка ничего не добавляет, если она повторяет одну из уже имеющихся (или целиком в неё входит)
function isRedundant(text: string, others: string[]): boolean {
  const key = normText(text);
  if (!key) return true;
  return others.some((o) => {
    const k = normText(o);
    if (!k) return false;
    if (k === key) return true;
    return false; // Похожие строки могут содержать разные условия и отрицания.
  });
}

// ---------- строки и пункты ----------

const BULLET = /^\s*(?:[•·*▪☐☑✅⬜✔]\s*|[–—-]\s+|\d{1,2}[.)]\s+)+/u;

export function strList(v: unknown, maxN = 20, maxLen = 200): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n|;/) : [];
  return raw.map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen)).filter(Boolean).slice(0, maxN);
}

const cleanItemText = (s: unknown, max = 120) => String(s ?? "").replace(BULLET, "").replace(/\s+/g, " ").trim().slice(0, max);
const sameItem = (a: string, b: string) => normText(a) === normText(b);

export function uniqueItems(list: unknown, max = 60): ListItem[] {
  const raw: unknown[] = Array.isArray(list) ? list : typeof list === "string" ? list.split(/\n|;/) : [];
  const out: ListItem[] = [];
  for (const r of raw) {
    const obj = r && typeof r === "object" ? (r as Record<string, unknown>) : null;
    const text = cleanItemText(obj ? obj.text : r);
    if (!text || out.some((x) => sameItem(x.text, text))) continue;
    out.push(obj?.done === true ? { text, done: true } : { text });
    if (out.length >= max) break;
  }
  return out;
}

// Убирает пустые строки и повторы: строки, которые не добавляют ничего нового к `against` и друг к другу
export function tidyLines(lines: string[], against: string[] = []): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = String(raw ?? "").replace(/[ \t]+/g, " ").trim();
    const text = line.replace(BULLET, "");
    if (!text || isRedundant(text, [...against, ...out.map((x) => x.replace(BULLET, ""))])) continue;
    out.push(line);
  }
  return out;
}

// Ищет пункт списка по смыслу: «хлеб» найдёт «Хлеб белый», если он один; если подходят несколько, вернёт "ambiguous"
export function findItem(items: ListItem[], query: string): ListItem | "ambiguous" | null {
  const q = cleanItemText(query);
  if (!q) return null;
  const exact = items.find((i) => normText(i.text) === normText(q));
  if (exact) return exact;
  const need = wordCount(q);
  if (!need) return null;
  const cands = items
    .map((i) => ({ i, o: overlap(q, i.text) }))
    .filter((x) => x.o.matched === need)
    .sort((a, b) => b.o.dice - a.o.dice);
  if (!cands.length) return null;
  if (cands.length > 1 && cands[0].o.dice === cands[1].o.dice) return "ambiguous";
  return cands[0].i;
}

// ---------- оформление ----------

function cloneNote(n: Note): Note {
  const c: Note = { ...n };
  if (n.items) c.items = n.items.map((i) => ({ ...i }));
  else delete c.items;
  return c;
}

// Длину проверяет отправитель: нельзя молча удалять пункты ради лимита.
export function fitNote(note: Note): Note {
  return cloneNote(note);
}

// Приводит то, что вернула нейросеть, к аккуратной заметке: чистит пустое, повторы и мусорные поля
export function cleanNote(raw: any): Note | null {
  if (!raw || typeof raw !== "object") return null;
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const items = uniqueItems(raw.items);
  const bodyLines = s(raw.body, 2000).split(/\n+/);
  let title = s(raw.title, 100).replace(/^(?:заметка|запись)\s*[:\-—]\s*/i, "").trim();
  if (!title) {
    const first = bodyLines.find((l) => l.replace(BULLET, "").trim());
    title = items.length ? "Список" : first ? first.replace(BULLET, "").trim().slice(0, 60) : "";
  }
  if (!title) return null;
  const who = s(raw.who, 100);
  const amount = s(raw.amount, 80);
  const lines = tidyLines(bodyLines, [title, ...(who || amount ? [`${who} ${amount}`] : []), ...items.map((i) => i.text)]);
  const note: Note = { topic: s(raw.topic, 100), title, body: lines.join("\n").slice(0, 2000) };
  const emoji = s(raw.emoji, 8);
  if (emoji) note.emoji = emoji;
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((t: unknown) => typeof t === "string").map((t: string) => t.replace(/^#/, "").trim()).filter(Boolean).slice(0, 10);
    if (tags.length) note.tags = tags;
  }
  if (who) note.who = who;
  if (amount) note.amount = amount;
  if (raw.direction === "owes_me" || raw.direction === "i_owe") note.direction = raw.direction;
  if (typeof raw.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.deadline)) note.deadline = raw.deadline;
  if (items.length) note.items = items;
  return fitNote(note);
}

export function formatNote(n: Note): string {
  const total = n.items?.length ?? 0;
  const done = n.items?.filter((i) => i.done).length ?? 0;
  const lines: string[] = [`${safeEmoji(n.emoji)} <b>${esc(n.title)}</b>`];
  if (total) lines.push(`<i>Выполнено: ${done} из ${total}</i>`);
  lines.push("");

  if (n.who || n.amount) {
    const who = n.who ? esc(n.who) : "";
    const amount = n.amount ? esc(n.amount) : "";
    if (n.direction) lines.push(n.direction === "i_owe" ? "💸 Я должен" : "💰 Мне должны");
    if (who) lines.push(`${n.direction === "i_owe" ? "Кому" : "Кто"}: <b>${who}</b>`);
    if (amount) lines.push(`Сумма: <b>${amount}</b>`);
  }

  const bodyLines = tidyLines(String(n.body ?? "").split(/\n+/), [n.title, ...(n.items ?? []).map((i) => i.text)]);
  if (bodyLines.length) {
    if (n.who || n.amount) lines.push("");
    lines.push(esc(bodyLines.join("\n")));
  }

  if (n.items?.length) {
    if (bodyLines.length) lines.push("");
    for (const it of n.items) lines.push(it.done ? `✅ <s>${esc(it.text)}</s>` : `⬜ ${esc(it.text)}`);
  }
  if (n.deadline) lines.push("", `📅 Дата: ${esc(n.deadline.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3.$2.$1"))}`);
  const tags = [...new Set((n.tags ?? []).map(t => t.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "").toLowerCase()).filter(Boolean))];
  if (tags.length) lines.push("", tags.map(t => `#${esc(t)}`).join(" "));
  return lines.join("\n").trimEnd();
}

// ---------- дополнение заметок и списков ----------

const plural = (n: number, a: string, b: string, c: string) => {
  const m = n % 100;
  const d = n % 10;
  return `${n} ${m >= 11 && m <= 14 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c}`;
};

// Добавляет новые строки (как «• факт») и пункты списка. Повторы пропускает; уже отмеченный пункт возвращает в список.
export function addToNote(note: Note, lines: string[], itemTexts: string[]): { note: Note; addedLines: number; addedItems: number; reopened: number } {
  const next = cloneNote(note);
  let addedLines = 0;
  let addedItems = 0;
  let reopened = 0;

  const have = [next.title, ...String(next.body ?? "").split(/\n+/), ...(next.items ?? []).map((i) => i.text)];
  const fresh = tidyLines(lines.map((l) => String(l ?? "").replace(BULLET, "")), have);
  if (fresh.length) {
    next.body = [next.body, ...fresh.map((l) => `• ${l}`)].filter(Boolean).join("\n");
    addedLines = fresh.length;
  }

  const wanted = uniqueItems(itemTexts, 40);
  if (wanted.length) {
    const items = (next.items ??= []);
    for (const t of wanted) {
      const ex = items.find((i) => sameItem(i.text, t.text));
      if (ex) {
        if (ex.done) {
          delete ex.done;
          reopened++;
        }
      } else if (items.length < 100) {
        items.push({ text: t.text });
        addedItems++;
      }
    }
  }
  if (next.items && !next.items.length) delete next.items;
  return { note: next, addedLines, addedItems, reopened };
}

export type AmendResult = { note: Note; changed: boolean; summary: string; problems: string[] };

// Применяет update_note с action=amend к заметке: дописать строки, добавить пункты, отметить, снять отметку, убрать
export function amendNote(note: Note, u: NoteUpdate): AmendResult {
  const parts: string[] = [];
  const problems: string[] = [];
  let next = cloneNote(note);

  const lines = strList(u.add_lines, 10, 300);
  const add = strList(u.add_items, 40, 120);
  if (lines.length || add.length) {
    const r = addToNote(next, lines, add);
    next = r.note;
    if (r.addedLines) parts.push(`+${plural(r.addedLines, "строка", "строки", "строк")}`);
    if (r.addedItems) parts.push(`+${plural(r.addedItems, "пункт", "пункта", "пунктов")}`);
    if (r.reopened) parts.push(`вернул в список: ${r.reopened}`);
  }

  const check = strList(u.check_items, 40, 120);
  const uncheck = strList(u.uncheck_items, 40, 120);
  const remove = strList(u.remove_items, 40, 120);
  if (check.length || uncheck.length || remove.length || u.clear_done) {
    if (!next.items?.length) problems.push("в заметке нет списка");
    else {
      let items = next.items;
      let checked = 0;
      let unchecked = 0;
      let removed = 0;
      const lookup = (q: string): ListItem | null => {
        const r = findItem(items, q);
        if (r === "ambiguous") problems.push(`«${q}»: подходит несколько пунктов, уточни`);
        else if (!r) problems.push(`не нашёл «${q}»`);
        return r && r !== "ambiguous" ? r : null;
      };
      for (const q of check) {
        const it = lookup(q);
        if (it && !it.done) {
          it.done = true;
          checked++;
        }
      }
      for (const q of uncheck) {
        const it = lookup(q);
        if (it?.done) {
          delete it.done;
          unchecked++;
        }
      }
      for (const q of remove) {
        const it = lookup(q);
        if (it) {
          items = items.filter((x) => x !== it);
          removed++;
        }
      }
      if (u.clear_done) {
        const before = items.length;
        items = items.filter((x) => !x.done);
        removed += before - items.length;
      }
      next.items = items;
      if (!items.length) delete next.items;
      if (checked) parts.push(`отмечено: ${checked}`);
      if (unchecked) parts.push(`снял отметку: ${unchecked}`);
      if (removed) parts.push(`убрал: ${removed}`);
    }
  }
  if (!lines.length && !add.length && !check.length && !uncheck.length && !remove.length && !u.clear_done) problems.push("не вижу, что добавить или отметить");
  return { note: next, changed: parts.length > 0, summary: parts.join(", "), problems };
}

// ---------- дубли ----------

const MERGE_DAYS = 14;

// Если нейросеть по ошибке создаёт новую заметку про то, что уже записано, находим старую, чтобы дополнить её
export function findSimilarSaved(saved: SavedNote[], note: Note, now = Date.now()): SavedNote | null {
  if (note.who || note.amount) return null;
  let best: SavedNote | null = null;
  let bestDice = 0;
  for (const s of saved) {
    const o = s.note;
    if (o.who || o.amount || o.topic !== note.topic) continue;
    if ((o.deadline || note.deadline) && o.deadline !== note.deadline) continue;
    const isList = Boolean(o.items?.length || note.items?.length);
    if (!isList && !(s.ts && now - s.ts < MERGE_DAYS * 86400000)) continue;
    const ov = overlap(note.title, o.title);
    if ((ov.dice >= 0.75 || (ov.contain === 1 && ov.longest >= 4)) && ov.dice >= bestDice) {
      best = s;
      bestDice = ov.dice;
    }
  }
  return best;
}

// Несколько одинаковых заметок в одном ответе нейросети схлопываем в одну
export function dedupeNotes(notes: Note[]): Note[] {
  const out: Note[] = [];
  for (const n of notes) {
    const idx = out.findIndex((o) => o.topic === n.topic && !o.who && !n.who && !o.amount && !n.amount && o.deadline === n.deadline && overlap(o.title, n.title).dice >= 0.75);
    if (idx < 0) out.push(n);
    else out[idx] = fitNote(addToNote(out[idx], n.body.split(/\n+/), (n.items ?? []).map((i) => i.text)).note);
  }
  return out;
}
