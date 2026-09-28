const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(platform,urls,tracked=1){
 const tabs=urls.map((url,i)=>({id:i+1,windowId:7,url}));const state={connection:{platform,blogId:'alpha'},editorTab:tracked};const changes=[];
 const event={addListener(){}};
 const ctx=vm.createContext({URL,importScripts(){},setTimeout,setInterval(){},clearInterval(){},chrome:{
  storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),remove:async key=>{delete state[key];}}},
  tabs:{onUpdated:event,get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t;},query:async()=>tabs,update:async(id,change)=>{changes.push({id,...change});return Object.assign(tabs.find(t=>t.id===id),change);},create:async spec=>{const t={id:tabs.length+1,windowId:7,...spec};tabs.push(t);return t;}},windows:{update:async()=>{}},alarms:{create(){},onAlarm:event},action:{onClicked:event},runtime:{onStartup:event,onInstalled:event,onMessage:event}}});
 vm.runInContext(fs.readFileSync('extension/background.js','utf8').replace('\npump();',''),ctx);
 return {ctx,tabs,changes,state};
}
for(const [platform,url] of [['naver','https://blog.naver.com/alpha/123'],['naver','https://blog.naver.com/PostView.naver?blogId=alpha&logNo=123'],['tistory','https://alpha.tistory.com/manage/posts/']])test(`reuse published tab ${url}`,async()=>{
 const f=setup(platform,[url]);assert.equal(await f.ctx.editorTab(true,{blogId:'alpha'}),1);assert.equal(f.tabs.length,1);assert.equal(f.changes[0].url,platform==='naver'?'https://blog.naver.com/alpha/postwrite':'https://alpha.tistory.com/manage/post');
});
test('unfinished editor is activated without navigation',async()=>{
 const f=setup('naver',['https://blog.naver.com/alpha/postwrite']);await f.ctx.editorTab(true);assert.equal(f.tabs.length,1);assert.ok(f.changes.every(c=>!c.url));
});
test('Tistory editor with query parameters is reused without clearing its draft',async()=>{
 const f=setup('tistory',['https://alpha.tistory.com/manage/post?type=post&returnURL=%2Fmanage%2Fposts']);
 assert.equal(await f.ctx.editorTab(true),1);assert.equal(f.tabs.length,1);assert.ok(f.changes.every(c=>!c.url));
});
test('shared Tistory login reuses tracked management tab across destinations repeatedly',async()=>{
 const f=setup('tistory',['https://previous.tistory.com/manage/posts/']);
 for(const blogId of ['alpha','beta','alpha']){
  assert.equal(await f.ctx.editorTab(true,{blogId}),1);assert.equal(f.tabs.length,1);
  assert.equal(f.tabs[0].url,`https://${blogId}.tistory.com/manage/post`);
  f.tabs[0].url=`https://${blogId}.tistory.com/manage/posts/`;
 }
});
test('shared Tistory login does not navigate another destination unfinished draft',async()=>{
 const url='https://previous.tistory.com/manage/post?type=post';const f=setup('tistory',[url]);
 assert.equal(await f.ctx.editorTab(true,{blogId:'alpha'}),2);assert.equal(f.tabs[0].url,url);
});
test('closed tracked tab reuses matching existing blog and leaves unrelated editors alone',async()=>{
 const f=setup('naver',['https://blog.naver.com/other/postwrite','https://blog.naver.com/alpha/123'],99);assert.equal(await f.ctx.editorTab(true),2);assert.equal(f.tabs.length,2);assert.equal(f.tabs[0].url,'https://blog.naver.com/other/postwrite');
});
test('no suitable tab creates one; following calls reuse it',async()=>{
 const f=setup('tistory',['https://other.tistory.com/manage/post'],99);assert.equal(await f.ctx.editorTab(true),2);assert.equal(await f.ctx.editorTab(true),2);assert.equal(f.tabs.length,2);
});
for(const changed of [false,true])test(`completed editor navigation requires unchanged snapshot: changed=${changed}`,async()=>{
 const f=setup('naver',['https://blog.naver.com/alpha/postwrite']);f.state.completedEditorTab={id:1,url:f.tabs[0].url,snapshot:{title:'completed'}};f.ctx.command=async()=>({title:changed?'user edit':'completed'});
 await f.ctx.editorTab(true);assert.equal(f.changes.some(c=>Boolean(c.url)),!changed);assert.equal(f.tabs.length,1);
});
