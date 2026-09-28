const test=require('node:test'),assert=require('node:assert/strict');
const {canonicalUrl,navigationOnly,evidenceExcerpt}=require('../src/lib/evidenceText');
const search=require('../src/lib/search')._private;
const {writerOutputIssueReason}=require('../src/lib/codexRunner')._private;
test('dedup preserves distinct notice query IDs and unifies mobile blog posts',()=>{
 assert.notEqual(canonicalUrl('https://a.example/detail?id=1'),canonicalUrl('https://a.example/detail?id=2'));
 assert.equal(canonicalUrl('https://m.blog.naver.com/PostView.naver?blogId=writer&logNo=123'),canonicalUrl('https://blog.naver.com/writer/123'));
 assert.ok(navigationOnly('https://dict.naver.com/dict.search?query=abc'));assert.ok(navigationOnly('https://creativecommons.org/licenses/by/4.0'));
 assert.ok(search.isLowValueResult('license','https://creativecommons.org/licenses/by/4.0'));
 assert.equal(search.isLowValueResult('공식 정책 안내','https://agency.example/policy/notice?id=1'),false);
 assert.equal(search.isLowValueResult('공식 검색 기준','https://help.naver.com/service/5626/contents/22926'),false);
});
test('retrieval includes matching later text without silently joining omissions',()=>{
 const text='서론 '.repeat(900)+'지원제외 조건: 대상 사업자는 신청할 수 없습니다. '+'추가 설명 '.repeat(900);
 const excerpt=evidenceExcerpt(text,'지원제외 조건');assert.match(excerpt,/대상 사업자는 신청할 수 없습니다/);assert.match(excerpt,/중간 생략/);assert.ok(excerpt.length<=3000);
});
test('PDF attachments are retained with distinct query IDs',()=>{
 assert.equal(search.isUnsupportedContentUrl('https://agency.example/notice.pdf'),false);
 const links=search.extractAttachmentLinks('<a href="/download?id=1">공고 PDF</a><a href="/notice.pdf">공고문</a>','https://agency.example');assert.equal(links.length,2);
 assert.equal(search.isUnsupportedContentUrl('https://agency.example/notice.hwp'),false);
 assert.equal(search.isUnsupportedContentUrl('https://agency.example/notice.hwpx'),false);
 assert.equal(search.extractAttachmentLinks('<a href="/download?id=2">공고 HWPX</a>','https://agency.example').length,1);
});
test('HWPX retains Korean paragraph and table cells in section order',async()=>{
 const {zipSync,strToU8}=require('fflate'),{extractDocument}=require('../src/lib/documentExtract');
 const data=zipSync({'Contents/section0.xml':strToU8('<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:t>지원 조건</hp:t></hp:run></hp:p><hp:tbl><hp:tr><hp:tc><hp:p><hp:t>사업자</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t>신청 가능</hp:t></hp:p></hp:tc></hp:tr></hp:tbl></hs:sec>')});
 const result=await extractDocument(data,'hwpx');assert.match(result.text,/지원 조건[\s\S]*사업자[\s\S]*신청 가능/);
 const invalid=zipSync({'Contents/section0.xml':strToU8('<!DOCTYPE x [<!ENTITY a "bad">]><x>&a;</x>')});await assert.rejects(extractDocument(invalid,'hwpx'),/엔터티/);
});
test('source-dependent article must visibly cite supplied sources',()=>{
 const options={researchTitleResult:{searchNeed:'strict'},searchResults:[{sourceId:'a',url:'https://agency.example/notice',excerpt:'근거'}]};
 const writer={status:'success',article:'본문',citations:[{sourceId:'a',url:'https://agency.example/notice'}]};
 assert.match(writerOutputIssueReason(writer,options),/본문에 표시/);
 writer.article+='\n[SECTION - 참고자료]\n참고 1: 기관 자료\nhttps://agency.example/notice';assert.equal(writerOutputIssueReason(writer,options),'');
 writer.citations[0].url='https://invented.example';assert.match(writerOutputIssueReason(writer,options),/일치하지/);
 assert.equal(writerOutputIssueReason({status:'success',article:'개념 설명'},{researchTitleResult:{searchNeed:'skip'}}),'');
});
test('PDF source extraction works through a local attachment endpoint',async()=>{
 const http=require('node:http');const {readSourceDocument}=require('../src/lib/sourceDocument');
 const stream='BT /F1 12 Tf 30 100 Td (Eligibility and exclusion conditions) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/pdf'});res.end(pdf);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const result=await readSourceDocument(`http://127.0.0.1:${server.address().port}/download?id=1`);assert.ok(result.pdf);assert.match(result.text,/Eligibility and exclusion conditions/);}finally{await new Promise(r=>server.close(r));}
});

test('no further search never bypasses citation validation for factual articles',()=>{
 const options={researchTitleResult:{searchNeed:'skip',factBased:true},searchResults:[{sourceId:'a',url:'https://agency.example/notice',excerpt:'공식 근거'}]};
 assert.match(writerOutputIssueReason({status:'success',article:'주장'},options),/citations/);
 assert.equal(writerOutputIssueReason({status:'success',article:'근거\n[SECTION - 참고자료]\n참고 1: 기관 자료\nhttps://agency.example/notice',citations:[{sourceId:'a',url:'https://agency.example/notice'}]},options),'');
});
