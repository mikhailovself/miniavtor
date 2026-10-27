import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";

const {
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_SECRET,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-haiku-5-5",
  OWNER_ID, // твой Telegram user id: бот слушает только тебя
  GROUP_CHAT_ID, // например -1001234567890
  TOPICS, // JSON: {"movies":5,"debts":8,"tracks":11,"ttd":14,"other":2}
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

type TopicKey = "movies" | "debts" | "tracks" | "ttd" | "other";

const TOPIC_META: Record<TopicKey, { emoji: string; label: string }> = {
  movies: { emoji: "🎬", label: "Кино" },
  debts: { emoji: "💸", label: "Долги" },
  tracks: { emoji: "🎧", label: "Идеи для треков" },
  ttd: { emoji: "✅", label: "ТТД" },
  other: { emoji: "📝", label: "Заметки" },
};

const SYSTEM_PROMPT = `Ты личный секретарь владельца. Он пишет тебе сырые мысли, иногда сумбурно, с опечатками, голосом или пересланным текстом. Твоя задача: понять, о чём это, выбрать тему и вызвать инструмент save_note с аккуратно оформленной заметкой.

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

const tools: Anthropic.Tool[] = [
  {
    name: "save_note",
    description: "Сохраняет оформленную заметку в нужную тему группы.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["movies", "debts", "tracks", "ttd", "other"] },
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
  },
];

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
  const resp = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT.replace("{{TODAY}}", today),
    tools,
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: text }],
  });
  return resp.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "save_note")
    .map((b) => b.input as Note);
}

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
    const text: string = msg.text ?? msg.caption ?? "";

    // Вспомогательная команда, чтобы узнать chat_id и thread_id.
    // Напиши /ids в нужном топике группы.
    if (text.trim().startsWith("/ids")) {
      await tg("sendMessage", {
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: `chat_id: ${chatId}\nthread_id: ${msg.message_thread_id ?? "нет (общий топик или не группа с темами)"}`,
      });
      return res.status(200).send("ok");
    }

    // Дальше слушаем только владельца и только в личке
    if (String(msg.from?.id) !== String(OWNER_ID) || msg.chat.type !== "private") {
      return res.status(200).send("ok");
    }

    if (text.trim() === "/start") {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Пиши мне что угодно: кино, долги, идеи для треков, дела. Я разложу всё по темам в группе.",
      });
      return res.status(200).send("ok");
    }

    if (!text.trim()) {
      await tg("sendMessage", { chat_id: chatId, text: "Пока понимаю только текст (и подписи к фото)." });
      return res.status(200).send("ok");
    }

    const topics: Record<string, number> = JSON.parse(TOPICS ?? "{}");
    const notes = await extractNotes(text);

    if (!notes.length) {
      await tg("sendMessage", { chat_id: chatId, text: "Не смог разобрать, попробуй переформулировать." });
      return res.status(200).send("ok");
    }

    const saved: string[] = [];
    for (const note of notes) {
      const threadId = topics[note.topic] ?? topics.other;
      await tg("sendMessage", {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: threadId,
        text: formatNote(note),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      const meta = TOPIC_META[note.topic] ?? TOPIC_META.other;
      saved.push(`${meta.emoji} ${meta.label}: ${note.title}`);
    }

    await tg("sendMessage", { chat_id: chatId, text: `Записал:\n${saved.join("\n")}` });
  } catch (e) {
    console.error(e);
    // Всё равно отвечаем 200, иначе Telegram будет слать сообщение повторно
    const chatId = req.body?.message?.chat?.id;
    if (chatId) await tg("sendMessage", { chat_id: chatId, text: "Что-то сломалось, глянь логи в Vercel." });
  }

  return res.status(200).send("ok");
}
