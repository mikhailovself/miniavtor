import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../api/webhook.ts', import.meta.url), 'utf8');
const owner = '1';
const btn = (text, callback_data) => ({ text, callback_data });
const backBtn = (callback_data = 'menu') => ({ text: 'Назад', callback_data, style: 'danger' });

test('beta button appears in personal settings only for ordinary users', async () => {
  const code = source.slice(source.indexOf('async function personalView('), source.indexOf('async function personalMemoryView('));
  const { personalView } = runInNewContext(`${stripTypeScriptTypes(code)}\n({ personalView })`, {
    isOwner: uid => uid === owner, redisPipe: async () => [0, 0], btn, backBtn,
  });
  for (const uid of ['1', '42']) {
    const view = await personalView(uid);
    const buttons = view.kb.inline_keyboard.flat();
    assert.equal(buttons.some(button => button.callback_data === 'featuretests'), uid !== owner);
  }
});

test('beta navigation opens for users without opening admin controls and Back ends the test', async () => {
  const code = source.slice(source.indexOf('async function handleCallback('), source.indexOf('// ---------- Группа ----------'));
  const states = new Map();
  const views = [];
  const { handleCallback } = runInNewContext(`${stripTypeScriptTypes(code)}\n({ handleCallback })`, {
    isOwner: uid => uid === owner, migrateLegacy: async () => {},
    checkSubscription: async () => 'subscribed', TELEGRAM_BOT_TOKEN: 'test', REDIS_URL: 'test',
    loadUser: async uid => ({ user: { id: uid }, banned: false }), btn, backBtn,
    tg: async () => ({ ok: true }), tgView: async (_, payload) => { views.push(payload); return { ok: true }; },
    redis: async ([cmd, key, value]) => { if (cmd === 'DEL') states.delete(key); if (cmd === 'SET') states.set(key, value); return 'OK'; },
  });
  for (const uid of ['1', '42']) {
    const cb = { id: 'cb', from: { id: Number(uid) }, message: { message_id: 7, chat: { id: Number(uid), type: 'private' } } };
    await handleCallback({ ...cb, data: 'featuretests' });
    assert.equal(views.at(-1).reply_markup.inline_keyboard.at(-1)[0].callback_data, uid === owner ? 'adm' : 'personal');
    await handleCallback({ ...cb, data: 'giphytest' });
    assert.equal(JSON.parse(states.get(`st:${uid}`)).action, 'gifka_test');
    await handleCallback({ ...cb, data: 'featuretests' });
    assert.equal(states.has(`st:${uid}`), false);
  }
  const count = views.length;
  await handleCallback({ id: 'cb', from: { id: 42 }, data: 'admp', message: { message_id: 7, chat: { id: 42, type: 'private' } } });
  assert.equal(views.length, count);
});

test('beta test respects the ordinary user AI quota before calling any services', async () => {
  const start = source.indexOf('    if (state?.action === "gifka_test")');
  const end = source.indexOf('    // End of shared beta test.', start);
  const messages = [];
  const { run } = runInNewContext(`${stripTypeScriptTypes(`async function run() { ${source.slice(start, end)} }`)}\n({ run })`, {
    state: { action: 'gifka_test' }, text: 'ну и дела', uid: '42',
    checkLimit: async uid => { assert.equal(uid, '42'); return { ok: false }; },
    runLLM: async () => { throw new Error('must not use AI'); },
    send: async text => messages.push(text), console,
  });
  await run();
  assert.match(messages[0], /лимит/);
});
