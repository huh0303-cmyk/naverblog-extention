const test=require('node:test');
const assert=require('node:assert/strict');
const {requireCompatibleEditor}=require('../src/lib/naverPublisher');
test('old account-specific editor stops before generation with actionable guidance',()=>{
 assert.throws(()=>requireCompatibleEditor({status:'valid',reason:'글쓰기 화면 확인 · 확장 20260922.11 · 제목 P'},'bdsmbk'),e=>e.code==='EXTENSION_UPDATE_REQUIRED' && /bdsmbk/.test(e.message) && /새로고침/.test(e.message));
});
test('current and newer builds work with structured and legacy diagnostics',()=>{
 for(const result of [{status:'valid',reason:'확장 20260928.3 · 제목 P'},{status:'valid',editorBuild:'20260928.4'},{status:'valid',editorBuild:'20260928.3'}])assert.doesNotThrow(()=>requireCompatibleEditor(result,'bok-blog'));
});
test('missing build cannot silently pass; login failures keep their original flow',()=>{
 assert.throws(()=>requireCompatibleEditor({status:'valid'},'bdsmbk'),{code:'EXTENSION_UPDATE_REQUIRED'});
 assert.doesNotThrow(()=>requireCompatibleEditor({status:'expired'},'bdsmbk'));
});
