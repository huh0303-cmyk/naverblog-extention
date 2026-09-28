const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {writeSettings,readSettings}=require('../src/lib/settings');
const {pendingPublishState,cancelPendingPublish}=require('../src/lib/pendingPublish');
test('cancel archives the pending draft, clears the block, and preserves other data',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blogauto-cancel-'));
 try{
  assert.equal(pendingPublishState(root).available,false);
  const draft={jobId:'old',status:'publish_uncertain',article:'본문',title:'제목'};
  writeSettings(root,{pendingNaverPublishDraft:draft});
  fs.writeFileSync(path.join(root,'keep.txt'),'기존 기록');
  assert.deepEqual(pendingPublishState(root,true),{available:true,busy:true,status:'publish_uncertain'});
  assert.throws(()=>cancelPendingPublish(root,true),/진행 중/);
  assert.equal(readSettings(root).pendingNaverPublishDraft.article,'본문');
  assert.equal(cancelPendingPublish(root).cancelled,true);
  assert.equal(readSettings(root).pendingNaverPublishDraft,null);
  const files=fs.readdirSync(path.join(root,'cancelled-drafts'));
  const archived=JSON.parse(fs.readFileSync(path.join(root,'cancelled-drafts',files[0])));
  assert.equal(archived.article,'본문');assert.equal(archived.previousStatus,'publish_uncertain');
  assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'기존 기록');
  assert.equal(cancelPendingPublish(root).cancelled,false);
 }finally{assert.ok(root.startsWith(path.join(os.tmpdir(),'blogauto-cancel-')));fs.rmSync(root,{recursive:true,force:true});}
});
test('generation checkpoint survives restart, exposes target and is archived on explicit cancellation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blogauto-cancel-'));
 try{
  const draft={accountId:'b',blogId:'blog-b',category:'여행',status:'generation_pending',checkpoint:{version:2,steps:{writer:{article:'완성 본문'}}}};
  writeSettings(root,{pendingGenerationDraft:draft});
  assert.deepEqual(pendingPublishState(root).target,{accountId:'b',blogId:'blog-b',category:'여행'});
  assert.equal(pendingPublishState(root).available,true);
  assert.throws(()=>cancelPendingPublish(root,true),/진행 중/);
  cancelPendingPublish(root);
  assert.equal(readSettings(root).pendingGenerationDraft,null);
  const archived=JSON.parse(fs.readFileSync(path.join(root,'cancelled-drafts',fs.readdirSync(path.join(root,'cancelled-drafts'))[0])));
  assert.equal(archived.generationDraft.checkpoint.steps.writer.article,'완성 본문');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('publish recovery target has priority over a generation checkpoint',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blogauto-cancel-'));
 try{
  writeSettings(root,{pendingNaverPublishDraft:{accountId:'published',blogId:'one',category:'c'},pendingGenerationDraft:{accountId:'generated',blogId:'two',category:'d'}});
  assert.equal(pendingPublishState(root).target.accountId,'published');
  cancelPendingPublish(root);
  assert.equal(readSettings(root).pendingGenerationDraft,null);
  assert.equal(readSettings(root).pendingNaverPublishDraft,null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
