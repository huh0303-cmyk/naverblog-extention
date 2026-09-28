const test=require('node:test'),assert=require('node:assert/strict');
const {cleanSourceUrl,cleanPublicationUrls}=require('../src/lib/publicationFormat');
const {writerOutputIssueReason}=require('../src/lib/codexRunner')._private;
const prompts=require('../src/lib/generationPrompts');
const raw='https://agency.example/notice?id=42&version=2026&utm_source=chatgpt.com#article3';
const clean='https://agency.example/notice?id=42&version=2026#article3';
const options={researchTitleResult:{factBased:true},searchResults:[{sourceId:'s',url:raw,excerpt:'근거'}]};
const article='독자에게 필요한 설명입니다.\n[SECTION - 참고자료]\n참고 1: 기관 · 자료\n'+clean;
test('publication URLs drop tracking but preserve document identity and anchors',()=>{
 assert.equal(cleanSourceUrl(raw),clean);
 assert.equal(cleanSourceUrl('https://a.example/?id=7&from=law&ref=article&gclid=x'),'https://a.example/?id=7&from=law&ref=article');
 const writer=cleanPublicationUrls({article:'자료 ('+raw+').',citations:[{sourceId:'s',url:raw}]});
 assert.equal(writer.article,'자료 ('+clean+').');assert.equal(writer.citations[0].url,clean);
});
test('footer-only references remain valid with internally traceable cleaned citations',()=>{
 const writer={status:'success',article,citations:[{sourceId:'s',url:clean}]};
 assert.equal(writerOutputIssueReason(writer,options),'');
 for(const marker of ['[참고1]','[참고 2]','[출처 1]','[1]'])assert.match(writerOutputIssueReason({...writer,article:marker+'\n'+article},options),/본문에는 참고 번호/);
 assert.match(writerOutputIssueReason({...writer,article:article+'\n[SECTION - 뒤늦은 결론]\n내용'},options),/맨 아래/);
 assert.match(writerOutputIssueReason({...writer,citations:[{sourceId:'s',url:clean.replace('42','99')}]},options),/일치하지/);
});
test('writer and reviewer agree on footer-only attribution and substantive usefulness',()=>{
 const writer=prompts.writerPrompt({...options,jobDir:'.'}),review=prompts.reviewPrompt({...options,jobDir:'.'});
 assert.match(writer,/본문에는 참고 번호를 절대 넣지 않는다/);
 assert.match(review,/본문 인용 번호나 매 단락의 출처 표기를 요구하지 않는다/);
 assert.doesNotMatch(writer,/put the supporting citation nearby|exact supplied raw URLs/);
 assert.match(review,/publishable:false 및 REVISION/);
 assert.match(review,/일정표·목록 글은 자동 반려하지 않는다/);
 assert.equal(prompts.sourcesFor(options)[0].url,clean);
});
