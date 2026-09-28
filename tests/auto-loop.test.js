const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
test('automatic generation waits after a failed single-account cycle instead of spinning',async()=>{
 const script=fs.readFileSync(require.resolve('../src/renderer/app.js'),'utf8');
 const code=script.slice(script.indexOf('async function startAutoPublishing('),script.indexOf('async function startTistoryTestPublish('));
 let calls=0,delays=0;const state={};const controls={};
 const context=vm.createContext({window:{blogAuto:{getPendingPublishState:async()=>({available:false})}},autoResultAction:r=>r.failureKind==='quality' || r.status==='success'?'next':'stop',setRunState(){},state,$:key=>controls[key] ||= {value:'60'},getAutoTargets:()=>[{account:{id:'a'},category:{id:'c'}}],
  accountDisplayName:a=>a.id,setTargetProgress:()=>{},resetJobPreview:()=>{},renderTargetProgress:()=>{},progressKey:t=>t.account.id+":"+t.category.id,updateRunControls:()=>{},saveSettingsNow:async()=>{},setTokenTotal:()=>{},collectForm:x=>x,runAutoStartJob:async()=>{calls++;return {status:'failed',failurePhase:'research',failureKind:'quality'};},
  delayAuto:async()=>{delays++;state.autoRunning=false;},addLog:()=>{}});
 await vm.runInContext(code+'\nstartAutoPublishing()',context);
 assert.equal(calls,1);assert.equal(delays,1);assert.equal(state.running,false);assert.equal(controls['#startButton'].disabled,false);
});

for (const crossPublish of [false,true]) test(`automatic loop preserves all targets across two cycles, cross=${crossPublish}`,async()=>{
 const script=fs.readFileSync(require.resolve('../src/renderer/app.js'),'utf8');
 const select=script.slice(script.indexOf('function getAutoTargets()'),script.indexOf('function updateRunControls()'));
 const loop=script.slice(script.indexOf('async function startAutoPublishing('),script.indexOf('async function startTistoryTestPublish('));
 const category=id=>({id,name:id,keyword:'여행'});
 const state={accountStore:{accounts:[
  {id:'a',categories:[category('1'),{...category('skip'),checked:false},category('2'),category('3')]},
  {id:'b',categories:[category('1'),category('2'),{id:'invalid',name:'키워드 없음'}]},
  {id:'excluded',checked:false,categories:[category('1')]},
  {id:'empty',categories:[]}
 ]}};
 const calls=[];const controls={'#crossPublish':{checked:crossPublish}};
 const context=vm.createContext({window:{blogAuto:{getPendingPublishState:async()=>({available:false})}},autoResultAction:r=>r.failureKind==='quality' || r.status==='success'?'next':'stop',setRunState(){},state,$:key=>controls[key] ||= {value:'60'},
  hasCategoryName:c=>Boolean(c.name),hasCategoryKeyword:c=>Boolean(c.keyword),
  accountDisplayName:a=>a.id,setTargetProgress:()=>{},resetJobPreview:()=>{},renderTargetProgress:()=>{},progressKey:t=>t.account.id+":"+t.category.id,updateRunControls:()=>{},saveSettingsNow:async()=>{},setTokenTotal:()=>{},collectForm:x=>x,addLog:()=>{},
  runAutoStartJob:async x=>{calls.push(x.account.id+x.category.id);return {status:'success'};},
  delayAuto:async()=>{if(calls.length===10)state.autoRunning=false;}});
 await vm.runInContext(select+loop+'\nstartAutoPublishing()',context);
 const expected=crossPublish?['a1','b1','a2','b2','a3']:['a1','a2','a3','b1','b2'];
 assert.deepEqual(calls,[...expected,...expected]);
 assert.equal(state.running,false);
});
