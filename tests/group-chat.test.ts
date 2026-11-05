// Запуск: node --experimental-strip-types group-chat.test.ts   (Node 22.6+)
import assert from "node:assert/strict";
import * as GC from "../lib/group-chat.ts";

// история: порядок и пометки рода
const raw = [
  GC.serializeLine({ ts: 3, uid: "1", name: "Софа", form: "она", text: "какой нахуй даня", to: "мини.автор" }),
  GC.serializeLine({ ts: 2, uid: "bot", name: "мини.автор", form: "он", bot: true, text: "даня ты рил пиздишь" }),
  GC.serializeLine({ ts: 1, uid: "2", name: "Влад", form: "он", text: "привет" }),
  "{битый json",
];
const h = GC.orderHistory(raw);
assert.equal(h.length, 3);
assert.equal(h[0].name, "Влад");
const f = GC.formatHistory(h);
assert.match(f, /Софа \(она\) → мини\.автор: какой нахуй даня/);
assert.match(f, /МИНИ\.АВТОР \(это ты\): даня/);

// повторы
assert.ok(GC.isRepeat("Ага бля мой взгляд говорит что ты заебала хахахаах", ["ага бля мой взгляд говорит что ты заебала хахахаах"]));
assert.ok(GC.isRepeat("Сама ты немощь бля, я оригинал вообще-то", ["Сама ты немощь, я оригинал вообще то бля"]));
assert.ok(!GC.isRepeat("иди нахуй со своими стикерами", ["Сама ты немощь бля, я оригинал вообще-то"]));
assert.ok(!GC.isRepeat("", ["что-то"]));

// счётчики: порог выбирается в диапазоне, достигается ровно на limit
for (const r of [0, 0.5, 0.999]) {
  let st: GC.Counter | null = null; let n = 0; let reached = false;
  while (!reached && n < 20) { const x = GC.stepCounter(st, 4, 7, () => r); st = x.state; reached = x.reached; n++; }
  assert.ok(n >= 4 && n <= 7, `порог ${n}`);
}
// порог не меняется внутри серии
const a = GC.stepCounter(null, 4, 6, () => 0.99); assert.equal(a.state.limit, 6);
const b = GC.stepCounter(a.state, 4, 6, () => 0); assert.equal(b.state.limit, 6); assert.equal(b.state.n, 2);

// регэкспы
assert.ok(GC.isHeated("нахуй он тут нужен"));
assert.ok(GC.isHeated("терпила"));
assert.ok(!GC.isHeated("а во сколько встречаемся"));
assert.ok(GC.isPushback("какой нахуй даня"));
assert.ok(GC.isPushback("тебя 7 человек поймали на лжи"));
assert.ok(!GC.isPushback("кидай стикер"));
assert.ok(GC.isApology("ладно прости"));
assert.ok(GC.isApology("мир?"));
assert.ok(!GC.isApology("пошёл нахуй"));

// обида: игнор, негативные реакции или «я уже всё сказал» (пересылка + точка)
let ignores = 0, reacts = 0, dots = 0;
for (let i = 0; i < 400; i++) { const s = GC.sulkAction(); if (s.kind === "ignore") ignores++; else if (s.kind === "dot") dots++; else { reacts++; assert.ok((GC.NEGATIVE_REACTIONS as readonly string[]).includes(s.emoji)); } }
assert.ok(ignores > 100 && reacts > 80 && dots > 50);

// род
assert.equal(GC.guessForm("cut.myhair💇‍♀️💅"), "она");
assert.equal(GC.guessForm("Настя Сони"), "она");
assert.equal(GC.guessForm("МашаКакаша"), "она");
assert.equal(GC.guessForm("Александра"), "она");
assert.equal(GC.guessForm("Софа Redmi c50"), "она");
assert.equal(GC.guessForm("Артюнз Сницкий"), "он");
assert.equal(GC.guessForm("Никита"), "он");
assert.equal(GC.guessForm("Саша"), "?");
assert.equal(GC.guessForm("mini.автор"), "?");
assert.equal(GC.statedForm("я женщина идиотина ты тупая"), "она");
assert.equal(GC.statedForm("Ало я мужчина вообще то"), "он");
assert.equal(GC.statedForm("он женщина"), "?");
assert.match(GC.formRule("она", "Софа"), /ЖЕНСКИЙ/);
assert.match(GC.formRule("?", "ГнаФак"), /неизвестен/);

// действия
assert.ok(GC.GROUP_ACTION_NAMES.has("send_sticker") && GC.GROUP_ACTION_NAMES.has("send_gif") && GC.GROUP_ACTION_NAMES.has("react"));
assert.equal(GC.pickByKind(["p:1", "s:2", "s:3", "v:4"], GC.MEME_KINDS.sticker, "s:2"), "s:3");
assert.equal(GC.pickByKind(["p:1", "v:4"], GC.MEME_KINDS.sticker), null);
assert.equal(GC.pickByKind(["s:2"], GC.MEME_KINDS.sticker, "s:2"), "s:2");

// подсказки о признании ошибки
assert.match(GC.pushbackHint({ n: 2, limit: 5 }), /не признавай/i);
assert.match(GC.pushbackHint({ n: 5, limit: 5 }), /признай/i);
console.log("все проверки группы прошли");

// номера сообщений в истории
const withIds = GC.formatHistory([{ ts: 1, uid: "1", name: "Влад", form: "он", mid: 42, text: "привет" }, { ts: 2, uid: "bot", name: "мини.автор", form: "он", bot: true, mid: 43, text: "здарова" }]);
assert.match(withIds, /\[#42\] Влад \(он\): привет/);
assert.match(withIds, /\[#43\] МИНИ\.АВТОР/);

// reply_to / react: номер должен быть в показанной истории и не быть сообщением бота
const hist = [{ ts: 1, uid: "1", name: "A", form: "?" as const, mid: 10, text: "x" }, { ts: 2, uid: "bot", name: "б", form: "он" as const, bot: true, mid: 11, text: "y" }];
assert.equal(GC.validMessageId(10, hist), 10);
assert.equal(GC.validMessageId("10", hist), 10);
assert.equal(GC.validMessageId(11, hist), null);
assert.equal(GC.validMessageId(11, hist, true), 11);
assert.equal(GC.validMessageId(999, hist), null);
assert.equal(GC.validMessageId("abc", hist), null);

// опрос
assert.deepEqual(GC.sanitizePoll({ question: "Кто душнит?", options: ["Я", "Ты", "я", " "] }), { question: "Кто душнит?", options: ["Я", "Ты"] });
assert.equal(GC.sanitizePoll({ question: "Один вариант?", options: ["да"] }), null);
assert.equal(GC.sanitizePoll({ question: "", options: ["а", "б"] }), null);
assert.equal(GC.sanitizePoll({ question: "Много?", options: ["1", "2", "3", "4", "5", "6", "7"] })?.options.length, 5);
assert.ok(GC.isDiceEmoji("🎲") && !GC.isDiceEmoji("💩"));

// свежая реплика бота (история от новых к старым); пометки в [] не считаются
const now = Date.now();
const newestFirst = [
  { ts: now - 1000, uid: "bot", name: "б", form: "он" as const, bot: true, mid: 5, text: "[кинул стикер]" },
  { ts: now - 5000, uid: "bot", name: "б", form: "он" as const, bot: true, mid: 4, text: "я уже всё сказал" },
];
assert.equal(GC.lastBotMessageId(newestFirst, now), 4);
assert.equal(GC.lastBotMessageId(newestFirst, now + 20 * 60 * 1000), null);

// какие функции видит модель: редкие приёмы почти никогда, stay_silent только при накале
const names = (d: { name: string }[]) => d.map((x) => x.name);
const calm = names(GC.pickActionDecls({ addressed: false, text: "ну такое", heated: false, rnd: () => 0.99 }));
assert.deepEqual(calm, ["react", "reply_to"]);
const calmAddressed = names(GC.pickActionDecls({ addressed: true, text: "привет", heated: false, rnd: () => 0.99 }));
assert.ok(calmAddressed.includes("send_sticker") && calmAddressed.includes("reply_to"));
for (const rare of ["send_poll", "send_dice", "edit_own", "delete_own", "stay_silent"]) assert.ok(!calmAddressed.includes(rare), rare);
assert.ok(names(GC.pickActionDecls({ addressed: true, text: "ты тупой", heated: true, rnd: () => 0.99 })).includes("stay_silent"));
assert.ok(!names(GC.pickActionDecls({ addressed: false, text: "ты тупой", heated: true, rnd: () => 0.99 })).includes("stay_silent"));
assert.ok(names(GC.pickActionDecls({ addressed: false, text: "давайте опрос", heated: false, rnd: () => 0.99 })).includes("send_poll"));
assert.ok(names(GC.pickActionDecls({ addressed: false, text: "кинь кубик", heated: false, rnd: () => 0.99 })).includes("send_dice"));
let rarePoll = 0;
for (let i = 0; i < 2000; i++) if (names(GC.pickActionDecls({ addressed: false, text: "ок", heated: false })).includes("send_poll")) rarePoll++;
assert.ok(rarePoll > 30 && rarePoll < 160, `poll offered ${rarePoll}/2000`);
for (const n of ["reply_to", "send_poll", "send_dice", "edit_own", "delete_own", "stay_silent", "react"]) assert.ok(GC.GROUP_ACTION_NAMES.has(n), n);
