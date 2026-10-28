import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const from = source.indexOf("async function usersView(");
const until = source.indexOf("\nasync function userView(", from);
assert.ok(from >= 0 && until > from);
const code = stripTypeScriptTypes(source.slice(from, until));

test("users pages have stable navigation and no empty keyboard rows", async () => {
  const ids = Array.from({ length: 11 }, (_, i) => String(i + 1));
  const f = runInNewContext(`${code}\n({ usersView })`, {
    redis: async ([cmd]) => cmd === "SMEMBERS" ? ids : ids.slice().reverse(),
    redisPipe: async (cmds) => cmds.map(([, key]) => key === "activity:1" ? [null, "Без username"] : [`user_${key.slice(9)}`, "Имя"]),
    profileUrl: (username) => username ? `https://t.me/${username}?profile` : null,
    profileLink: (uid, username) => username ? `https://t.me/${username}?profile` : `tg://user?id=${uid}`,
    urlBtn: (text, url) => ({ text, url }),
    btn: (text, callback_data) => ({ text, callback_data }),
    backBtn: (callback_data, text) => ({ text, callback_data }),
  });
  const first = await f.usersView(0);
  const second = await f.usersView(1, true);
  assert.ok(first.kb.inline_keyboard.flat().some((button) => button.callback_data === "users:1"));
  assert.ok(second.kb.inline_keyboard.flat().some((button) => button.callback_data === "users:0"));
  assert.equal(second.kb.inline_keyboard.flat().some((button) => button.callback_data === "users:2"), false);
  assert.ok(second.kb.inline_keyboard.every((row) => row.length > 0));
  assert.equal(second.kb.inline_keyboard.some((row) => row.some((button) => button.url?.startsWith("tg://"))), false);
});
