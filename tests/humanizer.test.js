const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {humanize,makeRequest,applyEdits,applyReview}=require('../packages/blog-humanizer');
const article='신청에 있어서 서류가 필요합니다.\n\n[SECTION - 준비]\n[IMAGE INSERT - 1]\n만 40세 이상은 상담을 신청할 수 있습니다.\n\n[SECTION - 참고자료]\n참고 1: 안내\nhttps://example.org/?id=40';
test('editable patches preserve all surrounding markup and references byte-for-byte',async()=>{
 const r=await humanize({article,title:'제목'},{complete:async()=>({status:'success',edits:[{id:'b0',text:'신청하려면 서류가 필요합니다.'}]})});
 assert.equal(r.article,article.replace('신청에 있어서','신청하려면'));assert.equal(r.changes.length,1);
});
test('no edit is a successful identical result including CRLF and whitespace',async()=>{
 const input=article.replaceAll('\n','\r\n');const r=await humanize({article:input},{complete:async()=>({status:'success',edits:[]})});assert.equal(r.article,input);assert.deepEqual(r.changes,[]);
});
test('reject damaged IDs, markers, references, duplicate edits and empty output',()=>{
 const r=makeRequest({article});const editable=r.blocks.find(b=>!b.locked);const locked=r.blocks.find(b=>b.text.startsWith('[SECTION'));
 for(const edits of [[{id:'missing',text:'내용'}],[{id:locked.id,text:'내용'}],[{id:editable.id,text:''}],[{id:editable.id,text:'[IMAGE INSERT - 8]'}],[{id:editable.id,text:'내용'}, {id:editable.id,text:'내용'}]])assert.throws(()=>applyEdits(r,{status:'success',edits}),{code:'HUMANIZER_INVALID_RESULT'});
});
test('numbers, direct quotes, URLs, list prefixes, protected names and inline citations cannot drift',()=>{
 const cases=[['만 40세입니다.','만 50세입니다.'],['“대상 제외”라고 합니다.','“대상 포함”이라고 합니다.'],['https://example.org/a 를 보세요.','https://example.org/b 를 보세요.'],['1. 서류\n2. 접수','2. 서류\n1. 접수'],['중장년내일센터 안내입니다.','다른센터 안내입니다.'],['조건을 보세요.','조건을 보세요.[참고 1]'],['조건을 보세요.','조건을\n\n보세요.']];
 for(const [before,after] of cases){const r=makeRequest({article:before,protectedTerms:['중장년내일센터']});assert.throws(()=>applyEdits(r,{status:'success',edits:[{id:'b0',text:after}]}),{code:'HUMANIZER_INVALID_RESULT'});}
});
test('same input reuses validated cache, changed context misses cache, failure never caches',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blog-humanizer-'));let calls=0;
 const complete=async()=>{calls++;return {status:'success',edits:[]};};
 try{
  await humanize({article},{complete,cacheDir:dir});assert.equal((await humanize({article},{complete,cacheDir:dir})).cached,true);assert.equal(calls,1);
  await humanize({article,category:'여행'},{complete,cacheDir:dir});assert.equal(calls,2);
  await assert.rejects(humanize({article:'실패 원고'},{complete:async()=>({status:'failed'}),cacheDir:dir}));assert.equal(fs.readdirSync(dir).length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('model errors propagate without retries and cancellation avoids model calls',async()=>{
 let calls=0;await assert.rejects(humanize({article},{complete:async()=>{calls++;throw Error('offline');}}),/offline/);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(humanize({article},{signal:controller.signal,complete:()=>{calls++;}}));assert.equal(calls,1);
});
test('already humanized output is not re-edited when Writer returns it unchanged',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'humanizer-output-cache-'));
 try{
  const result=await humanize({article},{cacheDir:dir,complete:async()=>({status:'success',edits:[{id:'b0',text:'신청하려면 서류가 필요합니다.'}]})});
  const again=await humanize({article:result.article},{cacheDir:dir,complete:()=>{throw Error('Repeated editing');}});
  assert.equal(again.cached,true);assert.equal(again.article,result.article);assert.deepEqual(again.changes,result.changes);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('review feedback invalidates rejected edits and is passed to the model',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'humanizer-review-cache-'));
 const input={article:'참여할 수 있습니다.'};
 try{
  await humanize(input,{cacheDir:dir,complete:async()=>({status:'success',edits:[{id:'b0',text:'참여합니다.'}]})});
  let calls=0;
  const fixed=await humanize({...input,revisionInstructions:'가능성을 확정으로 바꾸지 말고 원문을 유지하세요.'},{cacheDir:dir,complete:async prompt=>{calls++;assert.ok(prompt.includes('가능성을 확정으로'));return {status:'success',edits:[]};}});
  assert.equal(calls,1);assert.equal(fixed.article,input.article);assert.equal(fixed.cached,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('module works copied outside app directory without dependencies',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'standalone-humanizer-'));
 try {fs.cpSync(path.resolve('packages/blog-humanizer'),dir,{recursive:true});const copy=require(dir);assert.ok(copy.makeRequest({article}).prompt.includes('만 40세'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reviewer restoration is exact, scoped by ID, and fails on missing or stale decisions',()=>{
 const req=makeRequest({article});const changed=applyEdits(req,{status:'success',edits:[{id:'b0',text:'신청하려면 서류가 필요합니다.'}]});
 assert.equal(applyReview(changed.article,changed.changes,[{id:'b0',action:'restore'}]).article,article);
 assert.equal(applyReview(changed.article,changed.changes,[{id:'b0',action:'keep'}]).article,changed.article);
 for(const decisions of [undefined,[],[{id:'bad',action:'restore'}],[{id:'b0',action:'rewrite'}]])assert.throws(()=>applyReview(changed.article,changed.changes,decisions));
 assert.throws(()=>applyReview(article,changed.changes,[{id:'b0',action:'restore'}]));
});
