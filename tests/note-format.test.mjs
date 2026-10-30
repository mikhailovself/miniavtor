import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNote, cleanNote, uniqueItems, MAX_TEXT } from '../api/notes.ts';

test('distinct items and meaningful conditions are preserved', () => {
  assert.equal(uniqueItems(['Молоко 2 литра', 'Молоко 3 литра', 'Молоко 2 литра']).length, 2);
  const note = cleanNote({title:'Встреча', body:'Оплатить завтра\nНе оплатить завтра'});
  assert.match(note.body, /Оплатить завтра\nНе оплатить завтра/);
  assert.match(formatNote({title:'Долг', body:'Саша должен 2000 за билеты', who:'Саша', amount:'2000', direction:'owes_me'}), /за билеты/);
});
test('list, date and HTML text are formatted safely', () => {
  const note = cleanNote({title:'Купить <всё>',body:'',items:[{text:'Хлеб',done:true},{text:'Молоко'}],deadline:'2026-11-02'});
  const text = formatNote(note);
  assert.match(text, /Купить &lt;всё&gt;/);
  assert.match(text, /✅ Хлеб\n⬜ Молоко/);
  assert.match(text, /02\.11\.2026/);
});
test('incomplete debt does not invent a direction', () => {
  const text = formatNote({title:'Билеты',body:'',amount:'2000'});
  assert.match(text, /<b>2000<\/b>/);
  assert.doesNotMatch(text, /долж|\?/);
});
test('long list keeps its items so sender can detect length limit', () => {
  const note = cleanNote({title:'Список',body:'',items:Array.from({length:60},(_,i)=>({text:`${i} ${'текст '.repeat(18)}`}))});
  assert.equal(note.items.length,60);
  assert.ok(formatNote(note).length > MAX_TEXT);
});
