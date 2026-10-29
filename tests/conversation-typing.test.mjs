import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const src=readFileSync(new URL('../api/webhook.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(src.slice(src.indexOf('async function conversationalTyping('),src.indexOf('async function handlePrivate(')));
test('typo is corrected only on a later message and group reply',async()=>{
 let pending=JSON.stringify({message:20,text:'привет',incoming:10,group:true}); const calls=[];
 const correct=runInNewContext(`${code}\ncorrectConversationalTypo`,{redis:async cmd=>cmd[0]==='GET'?pending:(pending=null),tg:async (method,payload)=>(calls.push({method,payload}),{ok:true})});
 await correct('-1',{message_id:11}); assert.equal(calls.length,0);
 await correct('-1',{message_id:12,reply_to_message:{message_id:20}}); assert.equal(calls.length,1); assert.equal(calls[0].payload.text,'привет'); assert.equal(pending,null);
});
test('typos do not alter links or numbers',()=>{
 const make=runInNewContext(`${code}\nmakeConversationalTypo`,{Math:{random:()=>0}});
 assert.equal(make('ссылка https://example.com'),'ссылка https://example.com');
 assert.equal(make('завтра 2000'),'завтра 2000');
 assert.notEqual(make('привет'),'привет');
});
