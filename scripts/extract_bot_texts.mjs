import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = ["api/webhook.ts", "api/notes.ts", "api/friends.ts"];

function* strings(source) {
  let line = 1;
  for (let i = 0; i < source.length;) {
    const c = source[i], next = source[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length - 1 && source.slice(i, i + 2) !== "*/") {
        if (source[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (["\"", "'", "`"].includes(c)) {
      const quote = c, start = line;
      i++;
      let value = "";
      while (i < source.length) {
        const ch = source[i];
        if (ch === "\\" && i + 1 < source.length) {
          value += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === quote) { i++; break; }
        if (ch === "\n") line++;
        value += ch;
        i++;
      }
      if (/[А-Яа-яЁё]/.test(value)) yield [start, value.replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll('\\"', '"')];
      continue;
    }
    if (c === "\n") line++;
    i++;
  }
}

let count = 0;
const out = [
  "# Тексты бота для правки",
  "",
  "Здесь собраны русскоязычные строки из исходников: готовые сообщения, кнопки, шаблоны и инструкции нейросети. `${...}` — подставляемые данные; сохрани их там, где они нужны. Это каталог для редактирования: изменение этого файла само по себе не меняет работающего бота. Пришли мне исправленный файл, и я перенесу правки в исходники.",
  "",
  "Ответы, которые нейросеть сочиняет во время разговора, перечислить заранее невозможно. На их стиль влияют инструкции ниже, прежде всего `VLAD_CHAT_PERSONA`, `VLAD_LORE`, `GROUP_RULES` и `NOTE_STYLE`.",
];
for (const file of files) {
  out.push("", `## ${file}`);
  for (const [line, value] of strings(readFileSync(resolve(root, file), "utf8"))) {
    count++;
    out.push("", `### ${file}:${line}`, "", "````text", value, "````");
  }
}
out.splice(2, 0, `Найдено русскоязычных строк и шаблонов: **${count}**.`, "");
const output = resolve(root, process.argv[2] || "BOT_TEXTS_FOR_EDIT.md");
writeFileSync(output, out.join("\n") + "\n", "utf8");
process.stdout.write(`${output} (${count} entries)\n`);
