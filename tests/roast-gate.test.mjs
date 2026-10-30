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

test("roast instructions are included in both conversation prompts", () => {
  const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
  assert.ok((source.match(/\$\{ROAST_ENGINE\}/g) ?? []).length >= 2);
});
