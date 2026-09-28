const test=require('node:test'),assert=require('node:assert/strict');
const {retrieveResearch}=require('../src/lib/researchRetrieval');
const {collectSearchResults,createRetrievalContext}=require('../src/lib/search');
const {lawBodyUrl}=require('../src/lib/sourceDocument');
test('requested provisions are re-extracted together from cached source without searches',async()=>{
 const context=createRetrievalContext();
 context.documents.set('law',Promise.resolve({title:'행정절차법',url:'https://example.com/law',fullText:'시행 정보 '+ '서론 '.repeat(1600)+'제21조(사전 통지) 의견제출 기간 규정. 제22조(의견청취) 청문 규정. 제27조(의견제출) 제출방법 규정. 제28조(다른 규정) '+ '부칙 '.repeat(1600)}));
 const rows=await retrieveResearch({verificationQueries:['행정절차법 제21조','행정절차법 제27조'],evidenceRequests:[{query:'행정절차법 제21조',sourceUrl:'https://example.com/law',anchors:[{start:'제21조(사전 통지)',end:'제22조(의견청취)'}]},{query:'행정절차법 제27조',sourceUrl:'https://example.com/law',anchors:[{start:'제27조(의견제출)',end:'제28조(다른 규정)'}]}]},()=>{},{context,collect:()=>{throw Error('unnecessary search');}});
 assert.equal(rows.length,1);assert.match(rows[0].excerpt,/의견제출 기간/);assert.match(rows[0].excerpt,/제출방법/);assert.ok(rows[0].excerpt.length<=3000);
});
test('a cross-reference to another statute cannot satisfy the requested provision cache',async()=>{
 const context=createRetrievalContext();context.documents.set('law',{title:'행정절차법',url:'https://example.com/law',fullText:'제20조(다른 내용) 행정기본법 제24조를 따른다.'});
 let calls=0;await retrieveResearch({verificationQueries:['행정절차법 제24조'],evidenceRequests:[{query:'행정절차법 제24조',sourceUrl:'https://example.com/law',anchors:[{start:'제24조(처분의 방식)'}]}]},()=>{},{context,collect:async()=>{calls++;return [];}});assert.equal(calls,1);
});
test('discovery respects web or blog while verification is a separate bounded web stage',async()=>{
 for(const channel of ['blog','web']){
  const calls=[];
  const rows=await retrieveResearch({searchChannel:channel,searchQueries:['주제'],verificationQueries:['공고','법령','초과']},()=>{},{collect:async options=>{calls.push(options);return [{url:options.searchQueries[0]==='주제'?'https://example.com/blog':'https://example.com/notice',excerpt:'본문'}];}});
  assert.deepEqual(calls.map(c=>c.searchChannel),['web',channel]);assert.equal(calls[0].searchQueries.length,2);assert.equal(rows.length,2);
 }
});
test('verification alone does not repeat discovery and runs even if discovery is empty',async()=>{
 const calls=[];await retrieveResearch({searchChannel:'blog',verificationQueries:['주택임대차보호법 제3조']},()=>{},{collect:async options=>{calls.push(options);return [];}});
 assert.equal(calls.length,1);assert.equal(calls[0].searchChannel,'web');
});
test('job cache reuses queries, documents and cited attachments across evidence rounds',async()=>{
 const context=createRetrievalContext(),fetched=[],searched=[];
 const blog='https://blog.naver.com/example/123',notice='https://www.bizinfo.go.kr/notice?id=1',attachment='https://www.bizinfo.go.kr/download?id=1';
 const dependencies={context,searchProvider:async(provider,settings,suffix,query)=>{searched.push(query);return [{provider,url:blog,title:'지원 안내'}];},fetchCandidate:async c=>{fetched.push(c.url);return {...c,fullText:'지원 대상 안내입니다. '.repeat(50),excerpt:'지원 대상 안내입니다. '.repeat(20),outboundLinks:c.url===blog?[{provider:'source-link',url:notice}]:c.url===notice?[{provider:'attachment',url:attachment}]:[]};}};
 const options={searchChannel:'blog',searchNeed:'strict',searchQueries:['지원 안내']};
 await collectSearchResults(options,()=>{},dependencies);const second=await collectSearchResults(options,()=>{},dependencies);
 assert.equal(searched.length,1);assert.equal(fetched.length,3);assert.ok(second.some(s=>s.url===attachment));
});
test('retrieval budgets prevent further network work rather than spending additional agent cycles',async()=>{
 const context=createRetrievalContext();context.maxSearchRequests=1;context.maxDocumentRequests=1;
 let searches=0,docs=0;
 await collectSearchResults({searchChannel:'web',searchQueries:['query one','query two'],primaryProvider:'naver',fallbackProvider:'naver'},()=>{},{context,searchProvider:async provider=>{searches++;return [1,2].map(n=>({provider,url:'https://example.com/'+n,title:'원문 설명'}));},fetchCandidate:async c=>{docs++;return {...c,excerpt:'읽을 수 있는 자료 '.repeat(30)};}});
 assert.equal(searches,1);assert.equal(docs,1);
});
test('law wrapper resolves same-origin statutory body preserving historical effective date',()=>{
 const frame=lawBodyUrl('<iframe src="/LSW/lsInfoP.do?lsiSeq=123&amp;efYd=20200101"></iframe>','https://www.law.go.kr/법령/예시');
 assert.ok(frame.includes('&efYd=20200101'));
 const body=lawBodyUrl('',frame);assert.match(body,/lsInfoR\.do/);assert.ok(body.includes('efYd=20200101'));
 assert.equal(lawBodyUrl('<iframe src="https://evil.example/lsInfoP.do"></iframe>','https://www.law.go.kr/법령/예시'),'');
});
test('legal text retains escaped comparison symbols without leaking quoted HTML attributes',()=>{
 const {stripTags}=require('../src/lib/search')._private;
 const text=stripTags('<a onclick="show(\'a>b\')">제3조 &lt;개정 2026&gt;</a><p>10 &lt; 20</p>');
 assert.equal(text,'제3조 <개정 2026> 10 < 20');
});

test('discovery budgets preserve verification capacity and do not trigger fallback after exhaustion',async()=>{
 const context=createRetrievalContext(),logs=[];let searches=0,docs=0;
 const deps={context,searchProvider:async provider=>{searches++;return [1,2,3].map(n=>({provider,url:'https://example.com/'+n,title:'자료'}));},fetchCandidate:async c=>{docs++;return {...c,excerpt:''};}};
 await collectSearchResults({searchChannel:'web',searchQueries:['탐색'],retrievalStage:'discovery',maxStageDocuments:1},m=>logs.push(m),deps);
 assert.equal(searches,1);assert.equal(docs,1);assert.equal(logs.filter(x=>x.includes('예산 도달')).length,1);
 context.discoveryDocuments=24;
 await collectSearchResults({searchChannel:'web',searchQueries:['공식'],retrievalStage:'verification',maxStageDocuments:2},()=>{},deps);
 assert.equal(docs,3);
});

test('missing restricted official results get only one host-free retry per job',async()=>{
 const context=createRetrievalContext(),calls=[];
 const deps={context,collect:async o=>{calls.push(o.searchQueries);return [];}};
 const opts={searchChannel:'blog',verificationQueries:['site:agency.example 지원 공고']};
 await retrieveResearch(opts,()=>{},deps);await retrieveResearch(opts,()=>{},deps);
 assert.deepEqual(calls,[['site:agency.example 지원 공고'],['지원 공고'],['site:agency.example 지원 공고']]);
});
