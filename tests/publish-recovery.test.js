const test=require('node:test');
const assert=require('node:assert/strict');
const {recoverNaverPublication,recoverPendingPublication,confirmedPublication}=require('../src/lib/publishRecovery');
const {publishSequence}=require('../src/lib/publishSequence');
function fixture(){
  const draft={accountId:'a',blogId:'blog',category:'cat',title:'title',article:'article',status:'publish_uncertain',tistoryBlogId:'test',publications:{naver:{status:'uncertain'}}};
  const task={id:'one',accountId:'a',blogId:'blog',type:'publish',stage:'final_publish',state:'failed',code:'PUBLISH_UNCERTAIN',payload:{title:'title',article:'article',publishScheduleMode:'reserve',scheduledAt:'2026-09-27T08:24:58.897Z'}};
  const result={published:true,scheduled:true,scheduledAt:'2026-09-27T08:30:00.000Z',verification:'reservation-list',managementUrl:'https://blog.naver.com/blog/postwrite'};
  let saved;
  const bridge={tasks:new Map([['one',task]]),request:async(account,type,payload)=>{assert.equal(account,'a');if(type==='session')return {status:'valid',editorBuild:'20260928.3'};assert.equal(type,'verifyPublish');assert.equal(payload.scheduledAt,result.scheduledAt);return result;},saveTasks:()=>assert.equal(saved.publications.naver.status,'done')};
  return {draft,task,result,bridge,save:v=>{saved=structuredClone(v);}};
}
test('reserved result needs actual list verification and timestamp, not a fake post URL',()=>{
  const {result}=fixture();assert.equal(confirmedPublication(result),true);
  for(const overrides of [{verification:''},{scheduledAt:'bad'},{managementUrl:''}])assert.equal(confirmedPublication({...result,...overrides}),false);
});
test('recovery verifies rounded original time, persists completion, and only publishes Tistory',async()=>{
  const f=fixture();const recovered=await recoverNaverPublication(f.draft,f);
  assert.equal(f.task.state,'done');assert.equal(f.task.previousOutcome.code,'PUBLISH_UNCERTAIN');
  let calls=0;await publishSequence(recovered,{save:f.save,naver:()=>assert.fail('duplicate Naver'),tistory:async()=>{calls++;return {published:true,url:'https://test.tistory.com/1'};}});assert.equal(calls,1);
});
test('ambiguous time or wrong destination cannot recover or invoke verification',async()=>{
  for(const kind of ['time','blog','article']){
    const f=fixture();f.bridge.request=()=>assert.fail('unsafe verification');
    if(kind==='time')f.bridge.tasks.set('two',{...f.task,id:'two',payload:{...f.task.payload,scheduledAt:'2026-09-27T09:00:00Z'}});
    else if(kind==='blog')f.task.blogId='other';else f.task.payload.article='other';
    await assert.rejects(recoverNaverPublication(f.draft,f),{code:'PUBLISH_UNCERTAIN'});assert.equal(f.task.state,'failed');
  }
});
test('missing proof, mismatching time and persistence failure retain uncertainty',async()=>{
  for(const kind of ['missing','time','save']){
    const f=fixture();if(kind==='missing')f.result.verification='';if(kind==='time')f.result.scheduledAt='2026-09-27T09:00:00Z';
    f.bridge.request=async(_account,type)=>type==='session'?{status:'valid',editorBuild:'20260928.3'}:f.result;
    if(kind==='save')f.save=()=>{throw new Error('disk full');};
    await assert.rejects(recoverNaverPublication(f.draft,f));assert.equal(f.task.state,'failed');assert.equal(f.draft.status,'publish_uncertain');
  }
});
test('older extension and invalid session never receive unknown verification task',async()=>{
  for(const session of [{status:'valid',editorBuild:'20260927.3'},{status:'unknown'},{status:'valid'}]){
    const f=fixture();let calls=0;
    f.bridge.request=async(_account,type)=>{calls++;assert.equal(type,'session');return session;};
    await assert.rejects(recoverNaverPublication(f.draft,f));assert.equal(calls,1);assert.equal(f.task.state,'failed');
  }
});
test('Tistory uncertainty recovers exact shared-login destination and completes without republishing',async()=>{
  const f=fixture();f.draft.publications={naver:{status:'done',published:true,url:'naver'},tistory:{status:'uncertain'}};
  f.task.accountId='tistory-shared';f.task.blogId='test';f.task.payload.tistoryBlogId='test';f.task.payload.scheduledAt='2026-09-27T08:41:00.000Z';
  f.result.scheduledAt=f.task.payload.scheduledAt;f.result.managementUrl='https://test.tistory.com/manage/posts';
  const seen=[];f.bridge.request=async(account,type,payload)=>{seen.push(type);assert.equal(account,'tistory-shared');assert.equal(payload.tistoryBlogId,'test');if(type==='session')return {status:'valid',editorBuild:'20260927.5'};assert.equal(payload.scheduledAt,f.task.payload.scheduledAt);return f.result;};
  const recovered=await recoverPendingPublication(f.draft,f);assert.deepEqual(seen,['session','verifyPublish']);assert.equal(recovered.publications.naver.url,'naver');assert.equal(recovered.publications.tistory.status,'done');assert.equal(recovered.status,'pending_naver_publish');
  await publishSequence(recovered,{save:f.save,naver:()=>assert.fail('duplicate Naver'),tistory:()=>assert.fail('duplicate Tistory')});
});
test('Tistory .4 is rejected before verification even when Naver completion is confirmed',async()=>{
  const f=fixture();f.draft.publications={naver:{status:'done'},tistory:{status:'uncertain'}};
  f.task.accountId='tistory-shared';f.task.blogId='test';
  f.bridge.request=async(_account,type)=>{assert.equal(type,'session');return {status:'valid',editorBuild:'20260927.4'};};
  await assert.rejects(recoverPendingPublication(f.draft,f),{code:'EXTENSION_UPDATE_REQUIRED'});assert.equal(f.task.state,'failed');
});

test('app interruption before final publish resumes authoring without remote verification',async()=>{
  for(const platform of ['naver','tistory'])for(const stage of [undefined,'waiting_login','writing']){
    const f=fixture();f.draft.publications={naver:platform==='naver'?{status:'running'}:{status:'done',url:'retained'},...(platform==='tistory'?{tistory:{status:'running'}}:{})};
    f.task.stage=stage;f.task.state='interrupted';delete f.task.code;
    if(platform==='tistory'){f.task.accountId='tistory-shared';f.task.blogId='test';}
    f.bridge.request=()=>assert.fail('no publication was attempted');
    const recovered=await recoverPendingPublication(f.draft,f);
    assert.equal(recovered.publications[platform].status,'failed');
    assert.equal(recovered.status,'pending_naver_publish');
    if(platform==='tistory')assert.equal(recovered.publications.naver.url,'retained');
  }
});

test('pre-publish recovery never clears explicit uncertainty or missing journal evidence',async()=>{
  for(const scenario of ['uncertain','missing','prior-final','running-task','unknown-stage']){
    const f=fixture();f.draft.publications.naver.status='running';f.task.stage='writing';f.task.state='interrupted';delete f.task.code;
    if(scenario==='uncertain')f.draft.publications.naver.status='uncertain';
    if(scenario==='missing')f.bridge.tasks.clear();
    if(scenario==='prior-final')f.bridge.tasks.set('final',{...f.task,stage:'final_publish',code:'PUBLISH_UNCERTAIN',payload:{...f.task.payload,publishScheduleMode:'now'}});
    if(scenario==='running-task')f.task.state='running';
    if(scenario==='unknown-stage')f.task.stage='unexpected';
    f.bridge.request=()=>assert.fail('cannot safely verify');
    await assert.rejects(recoverPendingPublication(f.draft,f),{code:'PUBLISH_UNCERTAIN'});
  }
});
test('durable bridge success closes crash window before draft completion save',async()=>{
  const f=fixture();f.draft.publications.naver.status='running';f.task.state='done';delete f.task.code;f.task.result={published:true,url:'https://blog.naver.com/blog/123'};
  f.bridge.request=()=>assert.fail('already completed');
  const recovered=await recoverPendingPublication(f.draft,f);
  assert.equal(recovered.publications.naver.status,'done');assert.equal(recovered.publications.naver.url,f.task.result.url);
});
