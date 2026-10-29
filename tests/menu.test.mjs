import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const start = source.indexOf("async function mainView(");
const end = source.indexOf("\nasync function connectView(", start);
assert.ok(start >= 0 && end > start);
const code = stripTypeScriptTypes(source.slice(start, end));

test("start menu leads to abilities, ordinary group and secretary", async () => {
  const views = runInNewContext(`${code}\n({ mainView, abilitiesView, regularGroupView, secretaryView })`, {
    isOwner: () => false,
    redis: async () => null,
    botName: async () => "example_bot",
    btn: (text, callback_data) => ({ text, callback_data }),
    urlBtn: (text, url) => ({ text, url }),
    backBtn: (callback_data, text) => ({ text, callback_data }),
    esc: (value) => value,
  });
  const menu = await views.mainView({ id: "123" });
  const callbacks = menu.kb.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(Array.from(callbacks), ["abilities", "groupadd", "secretary", "author"]);
  assert.match(views.abilitiesView().text, /тематическим папкам/);
  assert.doesNotMatch(views.abilitiesView().text, /Смотрю и слушаю/);
  assert.match((await views.regularGroupView()).kb.inline_keyboard[0][0].url, /startgroup=chat/);
  assert.equal(views.secretaryView().kb.inline_keyboard[0][0].callback_data, "connect");
});
