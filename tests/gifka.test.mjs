import test from 'node:test';
import assert from 'node:assert/strict';
import { gifkaCandidates, chooseGifka } from '../api/gifka.ts';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
test('gifka response accepts only HTTPS MP4 renditions', () => {
  const result = gifkaCandidates({items:[{title:'кот',renditions:[{format:'mp4',url:'https://cdn.example/cat.mp4'}]},{renditions:[{format:'mp4',url:'http://bad.example/x.mp4'}]},{renditions:[{format:'webp',url:'https://cdn.example/a.webp'}]}]});
  assert.equal(result.length,1); assert.equal(result[0].title,'кот');
  assert.deepEqual(gifkaCandidates({}),[]);
});

const candidates = ['a', 'b', 'c'].map(key => ({ key, title: key, url: `https://cdn.example/${key}.mp4` }));

test('random choice covers unseen candidates and excludes recent results across queries', () => {
  assert.equal(chooseGifka(candidates, [], () => 0).key, 'a');
  assert.equal(chooseGifka(candidates, [], () => 0.999).key, 'c');
  assert.equal(chooseGifka(candidates, ['c', 'a'], () => 0.999).key, 'b');
});

test('exhausted results rotate oldest first and never repeat the last GIF', () => {
  assert.equal(chooseGifka(candidates, ['b', 'c', 'a']).key, 'a');
  assert.equal(chooseGifka([candidates[0]], ['a']), null);
  assert.equal(chooseGifka([], []), null);
  const recent = [];
  const sent = [];
  for (let i = 0; i < 9; i++) {
    const selected = chooseGifka(candidates, recent, () => 0);
    assert.notEqual(selected.key, recent[0]);
    sent.push(selected.key); recent.unshift(selected.key);
  }
  assert.deepEqual(sent, ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c']);
});

test('duplicates do not bias randomness and candidate list is bounded', () => {
  const item = (id, name = id) => ({ id, renditions: [{ format: 'mp4', url: `https://cdn.example/${name}.mp4` }] });
  const result = gifkaCandidates({ items: [item('a'), item('a', 'other'), item('b', 'a'), ...Array.from({ length: 20 }, (_, i) => item(String(i)))] });
  assert.equal(result.length, 10);
  assert.equal(result.filter(x => x.key === 'id:a').length, 1);
  assert.equal(result.filter(x => x.url.endsWith('/a.mp4')).length, 1);
});

test('test handler records only successful deliveries and bounds Redis history', async () => {
  const source = readFileSync(new URL('../api/webhook.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    if (state?.action === "gifka_test")');
  const end = source.indexOf('    // End of shared beta test.', start);
  assert.ok(start > 0 && end > start);
  for (const success of [false, true]) {
    const writes = [];
    const messages = [];
    const { run } = runInNewContext(`${stripTypeScriptTypes(`async function run() { ${source.slice(start, end)} }`)}\n({ run })`, {
      state: { action: 'gifka_test' }, text: 'ну и дела', chatId: 42, uid: '42', checkLimit: async () => ({ ok: true }),
      runLLM: async () => ({ reply: 'удивление' }), CHAT_DECLARATION: {},
      URLSearchParams, process: { env: {} }, console, gifkaCandidates, chooseGifka,
      fetchT: async () => ({ ok: true, json: async () => ({ items: [
        { id: 'a', renditions: [{ format: 'mp4', url: 'https://cdn.example/a.mp4' }] },
      ] }) }),
      redis: async (command) => { assert.deepEqual(Array.from(command), ['LRANGE', 'gifka:test:recent:42', 0, 29]); return []; },
      redisPipe: async (commands) => { writes.push(...Array.from(commands, c => Array.from(c))); return [1, 'OK', 1]; },
      tg: async () => ({ ok: success }), send: async text => messages.push(text),
    });
    await run();
    assert.equal(writes.length, success ? 3 : 0);
    if (success) assert.deepEqual(writes, [
      ['LPUSH', 'gifka:test:recent:42', 'id:a'], ['LTRIM', 'gifka:test:recent:42', 0, 29], ['EXPIRE', 'gifka:test:recent:42', 604800],
    ]);
    else assert.match(messages[0], /Telegram не смог/);
  }
});
