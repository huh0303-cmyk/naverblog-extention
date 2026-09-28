const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8');
const workflow=source.slice(source.indexOf('const openingAccounts ='),source.indexOf('async function checkAccountSession('));
function harness(connections){
  const calls=[],logs=[];let polls=0;
  const context=vm.createContext({
    window:{blogAuto:{openAccountChrome:async id=>calls.push(['open',id]),getConnections:async()=>({accounts:[{id:'a',connection:connections(polls++)}]})}},
    renderAccounts(){},checkAccountSession:async a=>calls.push(['check',a.id]),
    addLog:entry=>logs.push(entry),accountDisplayName:a=>a.id,setTimeout:fn=>fn(),
  });
  vm.runInContext(workflow,context);
  return {run:()=>context.openAccountAndCheck({id:'a'}),calls,logs};
}
test('opening Chrome waits for its extension before checking login',async()=>{
  const h=harness(n=>({connected:n>=2,busy:false}));await h.run();
  assert.deepEqual(h.calls,[['open','a'],['check','a']]);assert.equal(h.logs.length,0);
});
test('opening Chrome does not duplicate an active account task',async()=>{
  const h=harness(()=>({connected:true,busy:true}));await h.run();
  assert.deepEqual(h.calls,[['open','a']]);
});
test('missing extension gives actionable guidance without claiming login success',async()=>{
  const h=harness(()=>({connected:false}));await h.run();
  assert.deepEqual(h.calls,[['open','a']]);assert.equal(h.logs.length,1);
  assert.match(h.logs[0].message,/확장프로그램 연결/);
});
test('repeated clicks while opening do not launch another Chrome',async()=>{
  const h=harness(()=>({connected:true,busy:false}));await Promise.all([h.run(),h.run()]);
  assert.deepEqual(h.calls,[['open','a'],['check','a']]);
});
