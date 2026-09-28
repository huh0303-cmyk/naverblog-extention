const test=require('node:test'),assert=require('node:assert/strict');
const prompts=require('../src/lib/generationPrompts');
const {retrieveResearch}=require('../src/lib/researchRetrieval');
const {evidenceIssue}=require('../src/lib/generationPipeline');
const search=require('../src/lib/search')._private;
test('source-only policy applies to every category and all three agents',()=>{
 for(const category of ['일상 기록','콘텐츠 리뷰','정책 해설','임의 카테고리'])for(const fn of ['researchPrompt','writerPrompt','reviewPrompt']){
  const p=prompts[fn]({jobDir:'test',category,trustBlogAsSource:true});
  assert.match(p,/Skip source credibility assessment and independent factual corroboration/);
  assert.match(p,/Do not narrate the writing\/verification process/);
  assert.doesNotMatch(p,/seek direct primary evidence|Seek statute text|verificationQueries is a separate array/);
 }
 assert.match(prompts.researchPrompt({jobDir:'test',trustBlogAsSource:false}),/seek direct primary evidence/);
});
test('source-only retrieval ignores verification requests and retains selected discovery channel',async()=>{
 const calls=[];
 await retrieveResearch({trustBlogAsSource:true,searchChannel:'blog',searchNeed:'strict',searchQueries:['selected material'],verificationQueries:['site:official.example verification']},()=>{},{collect:async opts=>{calls.push(opts);return [];}});
 assert.equal(calls.length,1);assert.equal(calls[0].retrievalStage,'discovery');assert.equal(calls[0].searchChannel,'blog');
});
test('source-only accepts readable blog material without credibility factChecks, not empty input',()=>{
 const r={status:'PASS',factBased:true};
 assert.equal(evidenceIssue(r,[{excerpt:'블로그 원문 내용'}],{trustBlogAsSource:true}),'');
 assert.ok(evidenceIssue(r,[],{trustBlogAsSource:true}));
 assert.ok(evidenceIssue(r,[{excerpt:'블로그 원문 내용'}],{trustBlogAsSource:false}));
});
test('source-only mode disables strict domain scoring and linked-source crawl gate',()=>{
 const p=search.buildSearchProfile({searchNeed:'strict',trustBlogAsSource:true,keyword:'주제'});
 assert.equal(p.strictEvidence,false);
 const score=search.scoreCandidate({title:'주제',excerpt:'주제 설명',url:'https://blog.naver.com/example/1'},[],{keyword:'주제'},p);
 assert.equal(score.blogTrustedSource,false);assert.equal(score.lowTrustSource,false);
});
