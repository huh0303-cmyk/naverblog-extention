const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeTistoryBlogId,tistoryAccount}=require('../src/lib/tistoryTarget');
const {launchSpec}=require('../src/lib/chromeLauncher');
const {publishSequence}=require('../src/lib/publishSequence');
const {tistoryDocument}=require('../extension/tistory-writer');
const {reconcileTistoryCheckpoint}=require('../extension/tistory-writer');

test('Tistory resumes applied content whose acknowledgement was lost',()=>{
  const checkpoint={fingerprint:'f',html:'before',images:{},pending:{type:'content',html:'<p>본문</p><p>다음</p>'}};
  const result=reconcileTistoryCheckpoint(checkpoint,{title:'title',html:'<p>본문</p>\n<p>다음</p>',text:'본문 다음',images:[]},'title');
  assert.equal(result.composed,true);assert.equal(result.pending,null);
});
test('Tistory resumes exactly the intended uploaded image and preserves other edits',()=>{
  const image='[##_Image|abc|{"filename":"image.png"}_##]';
  const checkpoint={fingerprint:'f',html:'<p>before</p>',images:{},pending:{type:'upload',key:1,name:'image.png',images:[]}};
  const snapshot={title:'title',html:'<p>before</p><p>'+image+'</p>',text:'before',images:[image]};
  assert.equal(reconcileTistoryCheckpoint(checkpoint,snapshot,'title').images[1],image);
  for(const update of [{title:'other'},{html:'<p>user changed</p><p>'+image+'</p>'},{images:[image,image]}])assert.throws(()=>reconcileTistoryCheckpoint(checkpoint,{...snapshot,...update},'title'),/보존/);
});
test('Tistory closed editor rebuilds local images only for a proven empty document',()=>{
  const checkpoint={fingerprint:'f',html:'old',images:{1:'remote'},composed:true};
  const restored=reconcileTistoryCheckpoint(checkpoint,{title:'',html:'<p><br></p>',text:'',images:[]},'title');
  assert.deepEqual(restored.images,{});assert.equal(restored.composed,undefined);
  assert.throws(()=>reconcileTistoryCheckpoint(checkpoint,{title:'',html:'<iframe src="other"></iframe>',text:'',images:[]},'title'),/보존/);
});
test('one Tistory login space serves multiple destinations; malformed IDs are rejected',()=>{
  assert.equal(normalizeTistoryBlogId('https://Boksajang.tistory.com/'),'boksajang');
  assert.equal(normalizeTistoryBlogId(''),'');
  for(const value of ['evil.com/path','a.tistory.com.evil.com','a/b','../','a?x=1'])assert.throws(()=>normalizeTistoryBlogId(value));
  const a=launchSpec('runtime',tistoryAccount('boksajang'),'win32','chrome.exe');
  const b=launchSpec('runtime',tistoryAccount('second-blog'),'win32','chrome.exe');
  assert.equal(a.dataDir,b.dataDir);assert.notEqual(a.url,b.url);
  assert.deepEqual(a.args,['https://boksajang.tistory.com/manage/post']);
});
test('Tistory failure preserves Naver success and retry only invokes Tistory',async()=>{
  let saved,naverCalls=0,tistoryCalls=0;
  const handlers={save:v=>{saved=structuredClone(v);},naver:async()=>{naverCalls++;return {published:true,url:'https://blog.naver.com/test/1'};},tistory:async()=>{tistoryCalls++;throw new Error('upload failure');}};
  await assert.rejects(publishSequence({title:'draft',tistoryBlogId:'boksajang'},handlers),/upload failure/);
  assert.equal(saved.publications.naver.status,'done');assert.equal(saved.publications.tistory.status,'failed');
  handlers.tistory=async()=>{tistoryCalls++;return {published:true,url:'https://boksajang.tistory.com/1'};};
  await publishSequence(saved,handlers);assert.equal(naverCalls,1);assert.equal(tistoryCalls,2);
});
test('crashed or uncertain publishing is never replayed',async()=>{
  for(const status of ['running','uncertain'])await assert.rejects(publishSequence({publications:{naver:{status}}},{save:()=>{},naver:()=>assert.fail('replay')}),{code:'PUBLISH_UNCERTAIN'});
});
test('empty mapping publishes only Naver; platform result is saved before next stage',async()=>{
  let saved;
  await publishSequence({tistoryBlogId:''},{save:v=>{saved=structuredClone(v);},naver:async()=>{assert.equal(saved.publications.naver.status,'running');return {published:true,url:'naver'};},tistory:()=>assert.fail('unexpected Tistory')});
  assert.equal(saved.publications.naver.status,'done');
  await publishSequence({tistoryBlogId:'legacy-global-target',publishToTistoryAfterNaver:false},{save:()=>{},naver:async()=>({published:true,url:'naver'}),tistory:()=>assert.fail('legacy disabled target must not publish')});
});
test('Tistory document preserves section-image-body order and escapes source HTML',()=>{
  const result=tistoryDocument('title',[{type:'section',text:'heading'},{type:'image',sequence:1},{type:'paragraph',text:'<script>text</script>'}],{1:'[##_Image|test_##]'});
  assert.ok(result.html.indexOf('heading')<result.html.indexOf('[##_Image'));
  assert.ok(result.html.indexOf('[##_Image')<result.html.indexOf('&lt;script&gt;'));
  assert.throws(()=>tistoryDocument('title',[{type:'image',sequence:1}],{}),/누락/);
});
