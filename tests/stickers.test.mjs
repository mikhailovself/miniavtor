import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../api/webhook.ts", import.meta.url), "utf8");
const from = source.indexOf("function memeFromMessage(");
const until = source.indexOf("\nasync function pickMeme(", from);
const sendFrom = source.indexOf("async function sendMeme(", until);
const sendUntil = source.indexOf("\n// Настройки группы", sendFrom);
assert.ok(from >= 0 && until > from && sendFrom > until && sendUntil > sendFrom);
const code = stripTypeScriptTypes(`${source.slice(from, until)}\n${source.slice(sendFrom, sendUntil)}`);

test("imports regular stickers from a set and sends one as a meme", async () => {
  const stored = new Set();
  const calls = [];
  const f = runInNewContext(`${code}\n({ memeFromMessage, stickerSetName, importStickerSet, sendMeme })`, {
    tg: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "getStickerSet") return { ok: true, result: { title: "Наши приколы", stickers: [
        { file_id: "abc", type: "regular" },
        { file_id: "def", type: "regular", is_animated: true },
        { file_id: "mask", type: "mask" },
        { file_id: "emoji", type: "custom_emoji" },
      ] } };
      return { ok: true };
    },
    redis: async ([cmd, key, ...args]) => {
      if (cmd === "SADD") { const before = stored.size; args.forEach((x) => stored.add(x)); return stored.size - before; }
      if (cmd === "SET") return "OK";
      throw new Error(`Unexpected Redis command: ${cmd} ${key}`);
    },
  });
  assert.equal(f.stickerSetName("https://t.me/addstickers/friends_pack"), "friends_pack");
  assert.equal(f.memeFromMessage({ sticker: { type: "regular", file_id: "one" } }), "s:one");
  const result = await f.importStickerSet("friends_pack");
  assert.equal(result.added, 2);
  assert.equal(result.total, 2);
  assert.deepEqual([...stored], ["s:abc", "s:def"]);
  assert.equal(await f.sendMeme("123", "s:abc", 42, "ну ты"), true);
  const sticker = calls.find((x) => x.method === "sendSticker");
  assert.equal(sticker.payload.sticker, "abc");
  assert.equal(sticker.payload.reply_parameters.message_id, 42);
  assert.equal(calls.find((x) => x.method === "sendMessage").payload.text, "ну ты");
});
