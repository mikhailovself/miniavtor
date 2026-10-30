import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

test("old repeated threat is not reused as a conversation example", () => {
  const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  const start = source.indexOf("function buildTurns(");
  const end = source.indexOf("\nasync function callGemini(", start);
  const { buildTurns } = runInNewContext(
    `${stripTypeScriptTypes(source.slice(start, end))}\n({ buildTurns })`,
  );
  const turns = buildTurns([
    { r: "u", t: "Да ладно тебе" },
    { r: "b", t: "А ебало у тебя давно не разбитое?))" },
    { r: "u", t: "Объясни почему" },
    { r: "b", t: "Ну потому что это вообще не аргумент" },
  ], "И что дальше?");
  assert.equal(turns.some(turn => /разбитое/i.test(turn.text)), false);
  assert.equal(turns.some(turn => turn.role === "assistant" && /не аргумент/.test(turn.text)), true);
  assert.equal(turns.at(-1).text, "И что дальше?");
});
