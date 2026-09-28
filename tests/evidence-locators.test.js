const test=require('node:test'),assert=require('node:assert/strict');
const {locatedExcerpt,cachedEvidence}=require('../src/lib/evidenceText');
const {retrieveResearch}=require('../src/lib/researchRetrieval');
const prompts=require('../src/lib/generationPrompts');
test('the same locator contract supports arbitrary source passages without category dispatch',async()=>{
 for(const [heading,body,next] of [['제21조(사전 통지)','적용 조건을 유지한다.','제22조'],['예약 변경 안내','방문 전날까지 변경할 수 있다.','취소 안내'],['Episode summary','출연자가 선택을 바꿨다.','다음 회 예고']]){
  const source={url:'https://example.com/source?id=1',title:'원문',fullText:'서론 '.repeat(1500)+heading+' '+body+' '+next+' 끝'};
  const req={query:'필요한 자료',sourceUrl:source.url,anchors:[{start:heading,end:next}]};
  const rows=await retrieveResearch({verificationQueries:[req.query],evidenceRequests:[req]},()=>{},{context:{documents:new Map([['x',source]])},collect:()=>{throw Error('must reuse');}});
  assert.equal(rows.length,1);assert.match(rows[0].excerpt,new RegExp(body.replace('.','\\.')));assert.ok(rows[0].excerpt.length<=3000);assert.equal(rows[0].fullText,undefined);
 }
});
test('unknown document, missing/ambiguous anchor or missing end cannot claim a cache hit',async()=>{
 const source={url:'https://example.com/a?id=1',fullText:'첫 항목 A 끝 첫 항목 B 끝'};
 const context={documents:new Map([['a',source]])};
 assert.equal(locatedExcerpt(source.fullText,[{start:'첫 항목'}]),null);
 assert.equal(locatedExcerpt(source.fullText,[{start:'A',end:'없는 끝'}]),null);
 assert.deepEqual(await cachedEvidence({sourceUrl:'https://example.com/a?id=2',anchors:[{start:'A'}]},context),[]);
});
test('source-only mode never performs locator-based external verification',async()=>{
 const rows=await retrieveResearch({trustBlogAsSource:true,verificationQueries:['q'],evidenceRequests:[{query:'q',sourceUrl:'https://example.com',anchors:[{start:'표'}]}]},()=>{},{context:{documents:{values(){throw Error('must not inspect');}}},collect:()=>{throw Error('must not search');}});assert.deepEqual(rows,[]);
});
test('meaning review is shared across topics and no law-specific output contract remains',()=>{
 for(const category of ['공법','여행','TV 리뷰']){
  const p=prompts.reviewPrompt({jobDir:'test',category});assert.match(p,/meaningChecks/);assert.doesNotMatch(p,/legalRelations|legal 주제/);
 }
 assert.match(prompts.researchPrompt({jobDir:'test'}),/evidenceRequests/);
 assert.doesNotMatch(prompts.researchPrompt({jobDir:'test'}),/evidenceDomain|For Korean public law/);
});
