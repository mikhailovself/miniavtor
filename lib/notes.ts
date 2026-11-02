// Типы заметок, оформление, списки и поиск дублей. Используется в webhook.ts.

export const MAX_TEXT = 4096;
export const MAX_CAPTION = 1024;

export type NoteItem = { text: string; done: boolean };

export type Note = {
  topic: string;
  title: string;
  body: string;
  emoji?: string;
  tags?: string[];
  items?: NoteItem[];
  who?: string;
  amount?: string;
  direction?: "owes_me" | "i_owe";
  deadline?: string;
};

export type SavedNote = {
  id: string;
  chat: string;
  thread: number;
  message: number;
  photo: boolean;
  note: Note;
  ts?: number;
};

export type NoteUpdate = {
  id: string;
  action: "amend" | "edit" | "paid" | "delete" | "watched" | "done";
  add_lines?: string[];
  add_items?: string[];
  check_items?: string[];
  uncheck_items?: string[];
  remove_items?: string[];
  clear_done?: boolean;
  remaining_amount?: string;
  topic?: string;
  title?: string;
  body?: string;
  emoji?: string;
  tags?: string[];
  who?: string;
  amount?: string;
  direction?: "owes_me" | "i_owe";
  deadline?: string;
  clear_fields?: string[];
  items?: { text: string; done?: boolean }[];
};

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const norm = (s: string): string =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];

export function uniqueItems(raw: unknown): NoteItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NoteItem[] = [];
  for (const x of raw) {
    const text = String(typeof x === "string" ? x : (x as any)?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const done = typeof x === "object" && x !== null && (x as any).done === true;
    const key = norm(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, done });
    if (out.length >= 100) break;
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Приводит ответ нейросети к аккуратной заметке. null, если заметка пустая.
export function cleanNote(raw: any): Note | null {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!title) return null;
  const titleKey = norm(title);
  const bodyLines = String(raw.body ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l, i, a) => l && norm(l) !== titleKey && a.findIndex((z) => norm(z) === norm(l)) === i);
  const note: Note = {
    topic: String(raw.topic ?? "").trim(),
    title,
    body: bodyLines.join("\n").slice(0, 2000),
  };
  const emoji = String(raw.emoji ?? "").trim();
  if (emoji) note.emoji = Array.from(emoji).slice(0, 2).join("");
  const tags = strList(raw.tags).map((t) => t.replace(/^#/, "").replace(/\s+/g, "_")).filter(Boolean).slice(0, 10);
  if (tags.length) note.tags = tags;
  const items = uniqueItems(raw.items);
  if (items.length) note.items = items;
  const who = String(raw.who ?? "").trim().slice(0, 100);
  const amount = String(raw.amount ?? "").trim().slice(0, 80);
  if (who) note.who = who;
  if (amount) note.amount = amount;
  if (raw.direction === "owes_me" || raw.direction === "i_owe") note.direction = raw.direction;
  if (typeof raw.deadline === "string" && DATE_RE.test(raw.deadline.trim())) note.deadline = raw.deadline.trim();
  return note;
}

export function dedupeNotes(notes: Note[]): Note[] {
  const seen = new Set<string>();
  const out: Note[] = [];
  for (const n of notes) {
    const key = `${norm(n.title)}|${norm(n.who ?? "")}|${norm(n.amount ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

const fmtDate = (d: string) => (DATE_RE.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : d);

// Готовый HTML-текст заметки для Telegram
export function formatNote(n: Note): string {
  const lines: string[] = [];
  lines.push(`${n.emoji ? `${esc(n.emoji)} ` : ""}<b>${esc(n.title)}</b>`);
  if (n.who || n.amount) {
    const dir = n.direction === "owes_me" ? "должен мне" : n.direction === "i_owe" ? "я должен" : "";
    const parts = [n.who ? esc(n.who) : "", dir, n.amount ? `<b>${esc(n.amount)}</b>` : ""].filter(Boolean);
    lines.push(`💸 ${parts.join(" · ")}`);
  }
  if (n.deadline) lines.push(`📅 ${esc(fmtDate(n.deadline))}`);
  if (n.body) lines.push("", esc(n.body));
  if (n.items?.length) {
    lines.push("", ...n.items.map((i) => `${i.done ? "✅" : "⬜"} ${esc(i.text)}`));
  }
  if (n.tags?.length) lines.push("", n.tags.map((t) => `#${esc(t)}`).join(" "));
  return lines.join("\n");
}

function findItem(items: NoteItem[], query: string): NoteItem | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return (
    items.find((i) => norm(i.text) === q) ??
    items.find((i) => q.length >= 3 && (norm(i.text).includes(q) || (norm(i.text).length >= 3 && q.includes(norm(i.text)))))
  );
}

export function amendNote(note: Note, update: NoteUpdate): { changed: boolean; note: Note; summary: string; problems: string[] } {
  const next: Note = { ...note, items: note.items ? note.items.map((i) => ({ ...i })) : undefined };
  const summary: string[] = [];
  const problems: string[] = [];

  const lines = strList(update.add_lines);
  if (lines.length) {
    const existing = (next.body ? next.body.split("\n") : []).map(norm);
    const added: string[] = [];
    for (const l of lines) {
      const key = norm(l);
      if (!key || existing.includes(key)) continue;
      existing.push(key);
      added.push(l.slice(0, 300));
    }
    if (added.length) {
      next.body = [next.body, ...added].filter(Boolean).join("\n").slice(0, 2000);
      summary.push(`добавил: ${added.join(", ")}`);
    }
  }

  const addItems = strList(update.add_items);
  if (addItems.length) {
    const items = next.items ?? [];
    const before = items.length;
    const merged = uniqueItems([...items, ...addItems]);
    next.items = merged;
    if (merged.length > before) summary.push(`пункты: ${merged.slice(before).map((i) => i.text).join(", ")}`);
  }

  const items = next.items ?? [];
  const toggle = (queries: unknown, done: boolean, label: string) => {
    const done_: string[] = [];
    for (const q of strList(queries)) {
      const it = findItem(items, q);
      if (!it) problems.push(`не нашёл пункт «${q}»`);
      else if (it.done !== done) {
        it.done = done;
        done_.push(it.text);
      }
    }
    if (done_.length) summary.push(`${label}: ${done_.join(", ")}`);
  };
  toggle(update.check_items, true, "отметил");
  toggle(update.uncheck_items, false, "снял отметку");

  const removed: string[] = [];
  for (const q of strList(update.remove_items)) {
    const it = findItem(items, q);
    if (!it) problems.push(`не нашёл пункт «${q}»`);
    else {
      items.splice(items.indexOf(it), 1);
      removed.push(it.text);
    }
  }
  if (removed.length) summary.push(`убрал: ${removed.join(", ")}`);

  if (update.clear_done) {
    const left = items.filter((i) => !i.done);
    if (left.length !== items.length) {
      summary.push(`убрал выполненные (${items.length - left.length})`);
      items.length = 0;
      items.push(...left);
    }
  }

  if (next.items || items.length) next.items = items;
  if (!next.items?.length) delete next.items;
  return { changed: summary.length > 0, note: next, summary: summary.join("; "), problems };
}

// Ищет среди сохранённых заметку про то же самое
export function findSimilarSaved(saved: SavedNote[], note: Note): SavedNote | undefined {
  const t = norm(note.title);
  if (!t) return undefined;
  const words = new Set(t.split(" "));
  return saved.find((s) => {
    const n = s.note;
    if (note.amount || n.amount) {
      if (!note.amount || !n.amount || norm(note.who ?? "") !== norm(n.who ?? "")) return false;
    }
    const st = norm(n.title);
    if (!st) return false;
    if (st === t) return true;
    if (note.items?.length || n.items?.length) return false;
    if (Math.min(st.length, t.length) >= 4 && (st.includes(t) || t.includes(st))) return true;
    const sw = new Set(st.split(" "));
    const common = [...words].filter((w) => sw.has(w)).length;
    return common > 0 && common / new Set([...words, ...sw]).size >= 0.8;
  });
}
