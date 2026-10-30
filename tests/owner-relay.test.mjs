import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../api/webhook.ts', import.meta.url), 'utf8');
const start = source.indexOf('function explicitOwnerRequest(');
const end = source.indexOf('async function relayToOwnerCard(', start);
const code = stripTypeScriptTypes(source.slice(start, end));
function fixture(outcome) {
 const calls=[];
 const functions=runInNewContext(`${code}\n({explicitOwnerRequest,handleExplicitOwnerRequest})`, {isOwner:()=>false, relayToOwnerCard:async (...args)=>(calls.push(['relay',...args]),outcome), tg:async (...args)=>(calls.push(args),{ok:true}), appendPrivateLog:async()=>{}});
 return {...functions,calls};
}
test('explicit requests go to owner, ordinary discussion does not',async()=>{
 const f=fixture('ok');
 for(const t of ['спроси у Влада, когда он придёт', 'передай Владу привет', 'узнай у автора про концерт']) assert.equal(f.explicitOwnerRequest(t),true,t);
 for(const t of ['влад куда-то ушёл', 'что ты думаешь про Влада?', 'передай привет Маше']) assert.equal(f.explicitOwnerRequest(t),false,t);
 await f.handleExplicitOwnerRequest({from:{id:2},chat:{id:2},message_id:5},'спроси у Влада когда концерт',false);
 assert.equal(f.calls[0][0],'relay'); assert.match(f.calls[1][1].text,/Когда ответит/);
});
test('failure never claims delivery or invents an answer',async()=>{
 const f=fixture('fail'); await f.handleExplicitOwnerRequest({from:{id:2},chat:{id:-3},message_id:5},'передай Владу привет',true);
 assert.match(f.calls[1][1].text,/Не получилось передать/);
 assert.equal(f.calls[1][1].reply_parameters.message_id,5);
});
