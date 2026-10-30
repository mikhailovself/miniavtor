import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { isInsultToBot } from "../api/roast-gate.ts";

test("only insults directed at the bot count", () => {
  assert.equal(isInsultToBot("Ты тупой", true), true);
  assert.equal(isInsultToBot("Бот, ты долбоёб", true), true);
  assert.equal(isInsultToBot("Ты тупой", false), false);
  assert.equal(isInsultToBot("Я тупой", true), false);
  assert.equal(isInsultToBot("Бот, ты думаешь он тупой?", true), false);
  assert.equal(isInsultToBot("Я с тобой не согласен", true), false);
});

test("roast activates on the third consecutive insult and resets on normal talk", async () => {
  const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function updateRoastStreak(");
  const end = source.indexOf("\nasync function callGemini(", start);
  const state = new Map();
  const { updateRoastStreak } = runInNewContext(
    `${stripTypeScriptTypes(source.slice(start, end))}\n({ updateRoastStreak })`,
    { isInsultToBot, redis: async ([command, key]) => {
      if (command === "DEL") { state.delete(key); return 1; }
      if (command === "INCR") { const next = (state.get(key) ?? 0) + 1; state.set(key, next); return next; }
      if (command === "EXPIRE") return 1;
      throw new Error(`Unexpected Redis command: ${command}`);
    } },
  );
  assert.equal(await updateRoastStreak("private:1", "1", "Ты тупой", true), false);
  assert.equal(await updateRoastStreak("private:1", "1", "Ты лох", true), false);
  assert.equal(await updateRoastStreak("private:1", "1", "Ты идиот", true), true);
  assert.equal(await updateRoastStreak("private:1", "1", "Ладно, объясни", true), false);
  assert.equal(await updateRoastStreak("private:1", "1", "Ты лох", true), false);
  assert.equal(await updateRoastStreak("private:2", "2", "Ты лох", true), false);
});
