import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNote, cleanNote, uniqueItems, fitNote, tidyLines } from '../api/notes.ts';

test('notes preserve distinct list entries and conditions', () => {
  assert.equal(uniqueItems(['Молоко 2 литра', 'Молоко 3 литра', 'Молоко 2 литра']).length, 2);
  assert.equal(tidyLines(['Оплатить завтра', 'Не оплатить завтра']).length, 2);
  assert.match(formatNote({title:'Долг', body:'Саша должен 2000 за билеты', who:'Саша', amount:'2000', direction:'owes_me'}), /за билеты/);
});
test('consistent readable list, dates, tags and escaped text', () => {
  const text = formatNote({title:'Купить <всё>', body:'', items:[{text:'Хлеб',done:true},{text:'Молоко'}], deadline:'2026-11-02', tags:['#На выходные','на выходные','!!!']});
  assert.match(text, /Купить &lt;всё&gt;/);
  assert.match(text, /Выполнено: 1 из 2/);
  assert.match(text, /✅ <s>Хлеб<\/s>\n⬜ Молоко/);
  assert.match(text, /Дата: 02.11.2026/);
  assert.equal((text.match(/#на_выходные/g) || []).length, 1);
});
test('incomplete debt has no invented direction or placeholder', () => {
  const text = formatNote({title:'Билеты',body:'',amount:'2000'});
  assert.match(text, /Сумма: <b>2000<\/b>/);
  assert.doesNotMatch(text, /долж|\?/);
});
test('long note keeps all entries so caller can reject instead of truncating', () => {
  const note = {title:'Список',body:'',items:Array.from({length:60},(_,i)=>({text:`${i} ${'текст '.repeat(18)}`}))};
  assert.equal(fitNote(note).items.length,60);
  assert.ok(formatNote(cleanNote(note)).length > 3900);
});
