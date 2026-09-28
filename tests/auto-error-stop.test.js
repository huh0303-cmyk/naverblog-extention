const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/renderer/app.js','utf8');
const functions=source.slice(source.indexOf('function autoResultAction('),source.indexOf('async function startTistoryTestPublish('));
function setup(results){
 const targets=['a','b'].map(id=>({account:{id},category:{id,name:id}}));
 const state={};const controls={};const calls=[],statuses=[],logs=[];
 const context=vm.createContext({state,$:id=>controls[id] ||= {value:1,checked:false},getAutoTargets:()=>targets,updateRunControls(){},saveSettingsNow:async()=>{},setTokenTotal(){},addLog:x=>logs.push(x),findAutoTargetIndex:()=>0,resetJobPreview(){},setTargetProgress(t,status,detail){statuses.push({id:t.account.id,status,detail});state.targetProgress[t.account.id+':'+t.category.id]={status};},accountDisplayName:a=>a.id,collectForm:x=>x,runAutoStartJob:async form=>{calls.push(form.account.id);const r=results.shift();if(r instanceof Error)throw r;return r;},setRunState(){},renderTargetProgress(){},progressKey:t=>t.account.id+':'+t.category.id,delayAuto:async()=>{},window:{blogAuto:{getPendingPublishState:async()=>({available:false})}}});
 vm.runInContext(functions,context);return {context,state,controls,calls,statuses,logs};
}
for(const result of [{status:'failed',failureKind:'execution',reason:'editor error'},{status:'failed',reason:'unknown error'},{status:'publish_uncertain'},new Error('IPC error')])test(`execution stops queue: ${result.status || 'throw'} ${result.reason || ''}`,async()=>{
 const f=setup([result]);await f.context.startAutoPublishing();
 assert.deepEqual(f.calls,['a']);assert.equal(f.state.autoRunning,false);assert.equal(f.state.running,false);
 assert.equal(f.controls['#startButton'].disabled,false);assert.equal(f.controls['#stopAutoButton'].disabled,true);
 assert.equal(f.state.nextTarget,null);assert.equal(f.state.activeTarget.account.id,'a');assert.equal(f.statuses.at(-1).status,'오류 · 자동 중지');
});
for(const result of [{status:'failed',failureKind:'quality',reason:'topic rejected'},{status:'duplicate_retry'},{status:'success'}])test(`nontechnical result advances: ${result.status}`,async()=>{
 const f=setup([result,{status:'failed',failureKind:'execution'}]);await f.context.startAutoPublishing();assert.deepEqual(f.calls,['a','b']);
});
test('restart resumes the persisted second target rather than the first',async()=>{
 const f=setup([{status:'failed',failureKind:'execution'}]);
 f.context.window.blogAuto.getPendingPublishState=async()=>({target:{accountId:'b',blogId:'',category:'b'}});
 f.context.autoTargetKey=t=>t.account.id;
 f.context.findAutoTargetIndex=(targets,key)=>targets.findIndex(t=>t.account.id===key);
 await f.context.startAutoPublishing();assert.deepEqual(f.calls,['b']);
});
test('removed or unchecked recovery target cannot silently start another target',async()=>{
 const f=setup([]);
 f.context.window.blogAuto.getPendingPublishState=async()=>({target:{accountId:'removed',blogId:'',category:'b'}});
 await assert.rejects(f.context.startAutoPublishing(),/중단된 작업/);assert.deepEqual(f.calls,[]);
});
