const test=require('node:test'),assert=require('node:assert/strict');
const {collectSearchResults,_private:s}=require('../src/lib/search');
const blog='https://blog.naver.com/writer/123456';
const notice='https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=123';
const file='https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=ABC&fileSn=1';
test('blog results exclude shopping, web notices and navigation and decode URL entities',()=>{
 const html=`<a href="https://search.shopping.naver.com/search/all?query=x">쇼핑 검색 바로가기</a><a href="${notice}">공식 공고 안내입니다</a><a href="https://blog.naver.com/PostView.naver?blogId=writer&amp;logNo=123456">실제 블로그 글입니다</a><a href="https://help.naver.com/support/alias/search/a">검색옵션 가이드 새 창 열림</a>`;
 const rows=s.parseLinks(html,'naver','blog');assert.equal(rows.length,1);assert.ok(!rows[0].url.includes('&amp;'));
 assert.equal(s.isLowValueResult('쇼핑','https://search.shopping.naver.com/search/all'),true);
});
test('strict blog search does not change Naver tab or invoke Google when primary has content',async()=>{
 const calls=[];
 const rows=await collectSearchResults({searchChannel:'blog',searchNeed:'strict',keyword:'지원금',searchQueries:['지원 안내'],primaryProvider:'naver',fallbackProvider:'google'},()=>{},{
  searchProvider:async(provider,options)=>{calls.push([provider,options.searchChannel]);return [{provider,url:blog,title:'지원 안내'}];},
  fetchCandidate:async c=>({...c,excerpt:'공고 내용을 설명하는 블로그 본문입니다. '.repeat(15),outboundLinks:[]})
 });
 assert.deepEqual(calls,[['naver','blog']]);assert.equal(rows.length,1);
});
test('fallback is attempted once in the same channel and discards off-scope candidates',async()=>{
 const calls=[];
 const rows=await collectSearchResults({searchChannel:'blog',searchNeed:'strict',keyword:'지원금',searchQueries:['지원 안내']},()=>{},{
  searchProvider:async(provider,options)=>{calls.push([provider,options.searchChannel]);return provider==='naver'?[{provider,url:notice,title:'웹 공고'}]:[{provider,url:blog,title:'블로그 설명'}];},
  fetchCandidate:async c=>({...c,excerpt:'확인 가능한 설명입니다. '.repeat(20),outboundLinks:[]})
 });assert.deepEqual(calls,[['naver','blog'],['google','blog']]);assert.equal(rows[0].url,blog);
});
test('Google fallback query and returned results both enforce blog scope',async()=>{
 let request;
 const rows=await s.providerSearch('google',{searchChannel:'blog',keyword:'지원금'},'','지원금 안내',async url=>{request=new URL(url);return `<a href="${notice}">공식 웹페이지 공고</a><a href="${blog}">블로그 지원 안내</a>`;});
 assert.match(request.searchParams.get('q'),/site:blog.naver.com/);assert.deepEqual(rows.map(r=>r.url),[blog]);
});
test('official download links are detected without extensions and navigation is excluded',()=>{
 const html=`<a href="#container">본문 바로가기</a><a href="/web/index.do">홈페이지</a><a href="/sii/siia/selectSIIA200View.do">정책정보</a><a href="/cmm/fms/fileDown.do?atchFileId=ABC&amp;fileSn=1">다운로드</a>`;
 assert.equal(s.extractAttachmentLinks(html,notice)[0].url,file);
 const links=s.extractAuthorityLinks(html,notice);assert.ok(links.every(l=>l.url===file));
});
test('blog citation to official notice to attachment is followed with each source fetched once',async()=>{
 const fetched=[];
 const rows=await collectSearchResults({searchChannel:'blog',searchNeed:'strict',keyword:'지원금',searchQueries:['지원 안내']},()=>{},{
  searchProvider:async provider=>[{provider,url:blog,title:'블로그 지원 안내'}],
  fetchCandidate:async c=>{fetched.push(c.url);return {...c,excerpt:'지원금 신청 조건과 제외 사항 안내입니다. '.repeat(15),outboundLinks:c.url===blog?[{provider:'source-link',url:notice,title:'원문 공고'}]:c.url===notice?[{provider:'attachment',url:file,title:'다운로드'}]:[]};}
 });assert.deepEqual(fetched,[blog,notice,file]);assert.ok(rows.some(r=>r.url===file && r.sourcePage===notice));
});

test('Naver search navigation URLs are excluded while real policy help remains usable',()=>{
 const s=require('../src/lib/search')._private;
 for(const path of ['alias/search/integration/main.naver','alias/search/integration/long.naver','alias/search/word/word_20.naver'])assert.equal(s.isLowValueResult('도움말 보기 새 창 열림','https://help.naver.com/'+path),true);
 assert.equal(s.isLowValueResult('공식 검색 기준','https://help.naver.com/service/5626/contents/22926'),false);
});

test('site-restricted verification rejects unrelated engine results before fallback',async()=>{
 const rows=await s.providerSearch('naver',{searchChannel:'web'},'','site:semas.or.kr OR site:sbiz24.kr 사업 공고',async()=>'<a href="https://welfare.comwel.or.kr/notice">다른 기관 공고 안내</a><a href="https://www.sbiz24.kr/notice">지원 사업 공고 안내</a>');
 assert.deepEqual(rows.map(r=>new URL(r.url).hostname),['www.sbiz24.kr']);
});
