const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('extension/editor.js','utf8');
function harness(rows,{blog='bdsmbk',opened=true}={}){
 let clicks=0;const visible={getClientRects:()=>[{}]};
 const document={body:{innerText:''},querySelectorAll(selector){
  if(selector==='button[data-click-area="tpb*t.schedulelist"]')return rows.map(([title,date])=>({...visible,querySelector:sel=>({textContent:sel==='strong'?title:date})}));
  if(selector==='button[data-click-area="tpb*t.schedule"]')return [{...visible,click(){clicks++;}}];
  if(selector==='strong' && opened)return [{...visible,textContent:'예약 발행 글'}];return [];
 }};
 const context=vm.createContext({document,location:{href:`https://blog.naver.com/${blog}/postwrite`},URL,getComputedStyle:()=>({visibility:'visible'})});vm.runInContext(source,context);
 return {run:(args={})=>context.editorCommand('reserved',{blogId:'bdsmbk',title:'정확한 제목',scheduledAt:new Date(2026,8,27,17,24,58).toISOString(),...args}),clicks:()=>clicks};
}
test('reservation success requires exact row title and ten-minute time, not a post URL',async()=>{
 const r=await harness([['정확한 제목','2026. 09. 27 17:30']]).run();assert.equal(r.complete,true);assert.equal(r.scheduled,true);assert.equal(r.verification,'reservation-list');assert.equal(r.url,undefined);
});
for(const [name,rows,options] of [
 ['wrong time',[['정확한 제목','2026.09.27 17:40']],{}],
 ['title substring',[['정확한 제목 추가','2026.09.27 17:30']],{}],
 ['wrong account',[['정확한 제목','2026.09.27 17:30']],{blog:'other'}],
 ['duplicate',[['정확한 제목','2026.09.27 17:30'],['정확한 제목','2026.09.27 17:30']],{}],
 ['missing',[],{}]
])test(`reservation rejects ${name}`,async()=>assert.equal((await harness(rows,options).run()).complete,false));
test('reservation midnight rollover checks the next date',async()=>{
 const h=harness([['정확한 제목','2026.09.28 00:00']]);assert.equal((await h.run({scheduledAt:new Date(2026,8,27,23,59).toISOString()})).complete,true);
});
test('reservation opens only the list and does not toggle an already open empty list',async()=>{
 const h=harness([],{opened:false});await h.run();assert.equal(h.clicks(),1);
 const open=harness([]);await open.run();assert.equal(open.clicks(),0);
});
