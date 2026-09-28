const test=require('node:test'),assert=require('node:assert/strict');
const {resolveImageStyle,saveStyleResult,cachedStyle}=require('../src/lib/accountImageStyle');
const sample=()=>({sampleImagePath:'sample.png',sampleImageHash:'a',sampleImageUpdatedAt:'1',imageStylePrompt:'old',imageStylePromptStatus:'ready',imageStylePromptSourceImageHash:'a'});
test('no sample never uses orphaned style or invokes analysis',async()=>{
 assert.equal(await resolveImageStyle({read:()=>({...sample(),sampleImagePath:''}),analyze(){throw Error('must not run');}}),'');
});
test('matching ready cache is reused without another agent call',async()=>{
 assert.equal(await resolveImageStyle({read:sample,analyze(){throw Error('must not run');}}),'old');
 for(const change of [{sampleImageHash:'b'},{imageStylePromptStatus:'failed'},{imageStylePromptStatus:'stale'},{sampleImageHash:''}])assert.equal(cachedStyle({...sample(),...change}),'');
});
test('deleting sample during analysis discards result and returns default',async()=>{
 let current={...sample(),imageStylePromptStatus:'stale'},saved=false;
 assert.equal(await resolveImageStyle({read:()=>current,analyze:async()=>{current={};return {status:'success',imageStylePrompt:'new'};},save(){saved=true;}}),'');
 assert.equal(saved,false);
});
test('replacement during analysis never overwrites the replacement',async()=>{
 let current={...sample(),imageStylePromptStatus:'stale'},saved=false;
 await assert.rejects(resolveImageStyle({read:()=>current,analyze:async()=>{current={...sample(),sampleImageUpdatedAt:'2'};return {status:'success',imageStylePrompt:'new'};},save(){saved=true;}}),/변경/);
 assert.equal(saved,false);
});
test('late callback cannot resurrect deleted or replaced sample style',()=>{
 for(const target of [{},{...sample(),sampleImageHash:'b'},{...sample(),sampleImageUpdatedAt:'2'}]){
  const before=JSON.stringify(target);assert.equal(saveStyleResult(target,sample(),{status:'success',imageStylePrompt:'new'}),false);assert.equal(JSON.stringify(target),before);
 }
});
for(const failure of ['json','empty','throw','missing'])test(`analysis failure is explicit and stored: ${failure}`,async()=>{
 const current={...sample(),imageStylePromptStatus:'stale'};
 await assert.rejects(resolveImageStyle({read:()=>current,exists:()=>failure!=='missing',analyze:async()=>{
  if(failure==='throw')throw Error('analysis error');
  return failure==='json'?{status:'failed',failureReason:'unreadable'}:{status:'success',imageStylePrompt:' '};
 },save:(source,result)=>saveStyleResult(current,source,result)}));
 assert.equal(current.imageStylePromptStatus,'failed');assert.equal(current.imageStylePrompt,'');assert.ok(current.imageStylePromptError);
});
test('successful analysis is stored against the source image',async()=>{
 const current={...sample(),sampleImageHash:'b'};
 assert.equal(await resolveImageStyle({read:()=>current,analyze:async()=>({status:'success',imageStylePrompt:'new'}),save:(source,result)=>saveStyleResult(current,source,result)}),'new');
 assert.equal(current.imageStylePromptSourceImageHash,'b');assert.equal(cachedStyle(current),'new');
});
