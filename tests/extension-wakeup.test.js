const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness(){
  const listeners={},intervals=[];
  const event=name=>({addListener:fn=>{listeners[name]=fn;}});
  const context=vm.createContext({
    importScripts(){},setTimeout,clearInterval(){},setInterval(fn,ms){intervals.push({fn,ms});},
    chrome:{storage:{local:{get:async()=>({editorTab:7})}},alarms:{create(){},onAlarm:event('alarm')},
      action:{onClicked:event('action')},tabs:{onUpdated:event('updated'),get:async()=>({url:'https://blog.naver.com/example'})},
      runtime:{onStartup:event('startup'),onInstalled:event('installed'),onMessage:event('message')}}
  });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension/background.js'),'utf8'),context);
  let wakes=0;context.pump=()=>{wakes++;};
  return {listeners,intervals,wakes:()=>wakes,context};
}
test('extension wakes on startup and blog load instead of waiting for 30-second alarm',async()=>{
  const h=harness();h.listeners.startup();
  await h.listeners.updated(9,{status:'complete'});
  assert.equal(h.wakes(),2);
  assert.ok(h.intervals.some(timer=>timer.ms===2000));
});
test('editor navigation forces fresh inspection even when prior login result is cached',async()=>{
  const h=harness();await h.listeners.updated(7,{status:'complete'});
  assert.equal(vm.runInContext('refreshSession',h.context),true);
  assert.equal(h.wakes(),1);
});
