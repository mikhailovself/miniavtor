import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../api/webhook.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.slice(source.indexOf('const missingNoteMessage ='), source.indexOf('// ---------- Меню (кнопки)')));
test('deleted note is purged, while edit replaces list items', async () => {
  for (const missing of [true, false]) {
    const calls = [], removed = [];
    const item = { id: '1', message: 1, chat: '-100', thread: 2, photo: false, note: { title: 'Покупки', body: '', items: [{ text: 'лук' }] } };
    const saved = [item];
    const apply = runInNewContext(`${code}\napplyNoteUpdate`, {
      noteKeyboard: () => ({inline_keyboard:[]}), redis: async () => "OK", uniqueItems: x => x, formatNote: n => JSON.stringify(n), MAX_TEXT: 3900, MAX_CAPTION: 1000,
      tg: async (method, payload) => { calls.push(payload); return missing ? { ok: false, description: 'Bad Request: message to edit not found' } : { ok: true }; },
      redisPipe: async cmds => removed.push(...cmds), replaceReminder: async () => {}, rememberNote: async () => {},
    });
    const reply = await apply('123', { id: '1', action: 'edit', items: [{ text: 'люк' }] }, saved, [{ id: 2 }]);
    if (missing) {
      assert.equal(saved.length, 0);
      assert.equal(removed[0][0], 'HDEL');
      assert.match(reply, /уже удалена/);
    } else {
      assert.equal(item.note.items[0].text, 'люк');
      assert.match(calls[0].text, /люк/);
    }
  }
});
