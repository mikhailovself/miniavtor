import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
const source=readFileSync(new URL('../api/webhook.ts',import.meta.url),'utf8');
const block=stripTypeScriptTypes(source.slice(source.indexOf('function noteKeyboard('),source.indexOf('type Topic =')));
test('list keyboard shows status and identifies each item',()=>{
 const f=runInNewContext(`${block}\nnoteKeyboard`,{});
 const k=f({items:[{text:'Хлеб',done:false},{text:'Сыр',done:true}]});
 assert.equal(k.inline_keyboard[0][0].callback_data,'noteitem:0');
 assert.match(k.inline_keyboard[1][0].text,/✅ Сыр/);
});
test('undo restores deleted text as new message',async()=>{
 const commands=[]; const item={id:'4',chat:'-1001',thread:3,message:4,photo:false,note:{title:'Покупки',body:'',items:[]}};
 const undo=runInNewContext(`${block}\nundoLastNote`,{redis:async c=>(commands.push(c),c[0]==='GET'?JSON.stringify({kind:'delete',item}):1),tg:async()=>({ok:true,result:{message_id:9}}),formatNote:()=> 'text',rememberNote:async(u,n)=>commands.push(['save',n.id]),replaceReminder:async()=>{}});
 assert.match(await undo('1','-1001'),/Вернул/);
 assert.ok(commands.some(c=>c[0]==='save'&&c[1]==='9'));
});
