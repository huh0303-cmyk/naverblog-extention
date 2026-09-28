const test=require('node:test');const assert=require('node:assert/strict');
const {generate,evidenceIssue}=require('../src/lib/generationPipeline');const prompts=require('../src/lib/generationPrompts');
const research={status:'PASS',searchNeed:'skip',factBased:false,finalTitle:'테스트 제목',writerContract:{articleMission:'개념 설명'}};
const writer={status:'success',title:'테스트 제목',article:'본문 내용',tags:[],bodyImages:[]};
const review={status:'PASS',publishable:true};
function fixture(results={}){const calls=[];const counts={};return {calls,deps:{runTask:async ({agent,...rest})=>{calls.push({agent,...rest});const i=counts[agent] || 0;counts[agent]=i+1;return {...(results[agent]?.[i] || {research,writer,humanizer:{status:'success',edits:[]},main:review,image:{status:'failed'}}[agent]),tokenUsage:{total:10,grossTotal:12,promptCharacters:30}};},bodyImageLimit:n=>n || 0,stylePrompt:()=>'',researchPrompt:()=>'',researchRetry:()=>'',writerPrompt:()=>'',writerRetry:()=>'',reviewPrompt:()=>'',writerIssue:r=>r.status==='success'?'':'failed',imagePromptIssue:()=>'',reviewIssue:()=>'',pendingImages:r=>r,imagePrompt:()=>'',mergeImages:(_a,b)=>b,imageIssue:()=> 'image missing',applyImages:(a)=>a}};}
const options={includeTitleImage:false,maxBodyImages:0};
test('agent-selected source locations survive the bounded research handoff',async()=>{
 const request={query:'문서의 필요한 항목',sourceUrl:'https://example.com/record',anchors:[{start:'변경 조건',end:'접수 방법'}]};
 const {calls,deps}=fixture({research:[{status:'REVISION',searchNeed:'strict',verificationQueries:[request.query],evidenceRequests:[request]},research]});
 let delivered;
 const result=await generate({...options,onSearchNeeded:async value=>{delivered=value;return {searchResults:[{sourceId:'s',url:request.sourceUrl,excerpt:'변경 조건 원문 내용'}]};}},()=>{},deps);
 assert.equal(result.status,'success');assert.deepEqual(delivered.evidenceRequests,[request]);
 assert.deepEqual(calls.map(c=>c.agent),['research','research','writer','humanizer','main']);
});

function restartDirectories(t){
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blog-stage-resume-'));
 const first=path.join(root,'first'),second=path.join(root,'second');
 fs.mkdirSync(first);fs.mkdirSync(second);
 t.after(()=>{
  const resolved=path.resolve(root);
  assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('blog-stage-resume-'));
  fs.rmSync(resolved,{recursive:true,force:true});
 });
 return {first,second};
}

test('new job directory resumes after supplemented research without repeating search or research',async t=>{
 const dirs=restartDirectories(t);let checkpoint,fail=true,searches=0;
 const sources=[{sourceId:'s1',url:'https://example.com/source',excerpt:'검증에 사용한 원문'}];
 const {deps,calls}=fixture({research:[{status:'REVISION',searchNeed:'normal',searchQueries:['원문 검색']},research]});
 const run=deps.runTask;const resumedWriterOptions=[];
 deps.runTask=async args=>{
  if(args.agent==='writer'){
   if(fail)throw Error('writer interrupted after research');
   resumedWriterOptions.push(args.options);
  }
  return run(args);
 };
 const config={...options,onGenerationCheckpoint:c=>checkpoint=c,onSearchNeeded:async()=>{searches++;return {searchResults:sources,sourceQuality:{status:'ready'}};}};
 await assert.rejects(generate({...config,jobDir:dirs.first},()=>{},deps),/writer interrupted/);
 assert.equal(searches,1);assert.equal(calls.filter(c=>c.agent==='research').length,2);
 fail=false;calls.length=0;
 const result=await generate({...config,jobDir:dirs.second,generationCheckpoint:JSON.parse(JSON.stringify(checkpoint))},()=>{},deps);
 assert.equal(result.status,'success');assert.equal(searches,1);
 assert.deepEqual(calls.map(c=>c.agent),['writer','humanizer','main']);
 assert.deepEqual(resumedWriterOptions[0].searchResults,sources);
 assert.equal(resumedWriterOptions[0].sourceQuality.status,'ready');
 assert.ok(resumedWriterOptions[0].jobDir.startsWith(dirs.second));
});

for(const interruptedAgent of ['writer','main'])test(`new job directory resumes second ${interruptedAgent} attempt without repeating accepted first calls`,async t=>{
 const dirs=restartDirectories(t);let checkpoint,fail=true;
 const revised={...writer,article:'보완된 본문'};
 const {deps,calls}=fixture({writer:[writer,revised],main:[{status:'REVISION',failureReason:'조건 설명 보완',revisionInstructions:['조건 설명을 보완하세요.']},review]});
 const run=deps.runTask;
 deps.runTask=async args=>{
  const second=args.promptFileName===(interruptedAgent==='writer'?'prompt-retry-2.txt':'main-review-2.txt');
  if(fail && args.agent===interruptedAgent && second)throw Error('second attempt interrupted');
  return run(args);
 };
 const config={...options,onGenerationCheckpoint:c=>checkpoint=c};
 await assert.rejects(generate({...config,jobDir:dirs.first},()=>{},deps),/second attempt interrupted/);
 fail=false;calls.length=0;
 const result=await generate({...config,jobDir:dirs.second,generationCheckpoint:JSON.parse(JSON.stringify(checkpoint))},()=>{},deps);
 assert.equal(result.status,'success');assert.equal(result.article,revised.article);
 assert.deepEqual(calls.map(c=>c.agent),interruptedAgent==='writer'?['writer','humanizer','main']:['main']);
 assert.ok(calls.every(c=>!['prompt.txt','main-review-1.txt','humanizer-prompt-1.txt','research-title-prompt.txt'].includes(c.promptFileName)));
});
test('image restart keeps completed file, retries missing image only, and keeps approved text byte-for-byte',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'blog-resume-'));const title=path.join(folder,'title.png'),body=path.join(folder,'body.png');
 fs.writeFileSync(title,'fixture');fs.writeFileSync(body,'fixture');
 try{
  let checkpoint,imageCalls=0,restart=false;const requests=[];
  const {deps,calls}=fixture();const task=deps.runTask;
  deps.runTask=async args=>{
   if(args.agent==='image'){
    imageCalls++;if(!restart && imageCalls===2)throw Error('image interrupted');
    return restart?{status:'success',bodyImages:[{sequence:1,path:body,summaryVerified:true}]}:{status:'partial',titleImagePath:title,titleImageVerified:true,bodyImages:[]};
   }return task(args);
  };
  deps.imageIssue=images=>images?.titleImageVerified && images?.bodyImages?.some(i=>i.summaryVerified)?'':'missing';
  deps.mergeImages=require('../src/lib/codexRunner')._private.mergeImageWorkerAttempts;
  deps.pendingImages=(_writer,images)=>({titleImagePrompt:images.titleImageVerified?'':'title',bodyImages:[{sequence:1}]});
  deps.imagePrompt=params=>{requests.push(params);return '';};
  const config={...options,includeTitleImage:true,onGenerationCheckpoint:c=>checkpoint=c};
  const first=await generate(config,()=>{},deps);assert.equal(first.publishable,false);
  restart=true;calls.length=0;requests.length=0;
  const second=await generate({...config,generationCheckpoint:checkpoint},()=>{},deps);
  assert.equal(second.publishable,true);assert.equal(second.article,writer.article);assert.equal(calls.length,0);
  assert.equal(requests.length,1);assert.equal(requests[0].includeTitleImage,false);
 }finally{fs.unlinkSync(title);fs.unlinkSync(body);fs.rmdirSync(folder);}
});
for(const stage of ['research','writer','humanizer','main','imageStyle','image'])test(`restart resumes failed ${stage} without repeating completed agent calls`,async()=>{
 let checkpoint,fail=true;const called=[];
 const {deps}=fixture();const task=deps.runTask;
 deps.runTask=async args=>{called.push(args.agent);if(args.agent===stage && fail)throw new Error('interrupted');
   if(args.agent==='imageStyle')return {status:'success',imageStylePrompt:'style'};
   return task(args);};
 deps.imageIssue=()=>'';
 const config={...options,includeTitleImage:true,accountImageStyle:stage==='imageStyle'?{sampleImagePath:__filename,sampleImageHash:'a'}:{},onGenerationCheckpoint:c=>{checkpoint=c;}};
 try{await generate(config,()=>{},deps);}catch{}
 assert.ok(checkpoint);fail=false;called.length=0;
 const result=await generate({...config,generationCheckpoint:JSON.parse(JSON.stringify(checkpoint))},()=>{},deps);
 assert.equal(result.status,'success');assert.equal(called[0],stage);
 const order=['research','writer','humanizer','main','imageStyle','image'];
 assert.ok(called.every(agent=>order.indexOf(agent)>=order.indexOf(stage)),JSON.stringify(called));
 assert.equal(result.article,writer.article);
});
test('image prompt uses live deleted sample state, not job-start style',async()=>{
 const {deps,calls}=fixture();let actual;
 deps.imagePrompt=p=>{actual=p.accountImageStylePrompt;return '';};deps.imageIssue=()=>'';
 await generate({...options,includeTitleImage:true,accountImageStyle:{sampleImagePath:__filename,sampleImageHash:'a',imageStylePrompt:'stale style',imageStylePromptStatus:'ready',imageStylePromptSourceImageHash:'a'},getAccountImageStyle:()=>({})},()=>{},deps);
 assert.equal(actual,'');assert.equal(calls.filter(c=>c.agent==='imageStyle').length,0);
});
test('failed style JSON preserves approved article and stops before image generation',async()=>{
 const {deps,calls}=fixture({imageStyle:[{status:'failed',failureReason:'샘플 판독 실패'}]});const logs=[];
 const result=await generate({...options,includeTitleImage:true,accountImageStyle:{sampleImagePath:__filename,sampleImageHash:'a'}},m=>logs.push(m),deps);
 assert.equal(result.article,writer.article);assert.equal(result.publishable,false);
 assert.equal(calls.filter(c=>c.agent==='image').length,0);assert.equal(calls.filter(c=>c.agent==='research').length,1);
 assert.ok(logs.some(m=>m.includes('샘플 판독 실패')));
});
test('workflow logs explain revision and preview arrives before review and images',async()=>{
 const revised={...writer,article:'보완된 본문'};
 const {deps,calls}=fixture({writer:[writer,revised],main:[{status:'REVISION',failureReason:'부정어 누락',revisionInstructions:['확정할 수 없으므로로 수정']},review]});
 const timeline=[],logs=[],previews=[];const run=deps.runTask;
 deps.runTask=async args=>{timeline.push(args.agent);return run(args);};
 deps.imageIssue=()=>'';
 const result=await generate({...options,includeTitleImage:true,onArticleReady:d=>{previews.push(d);timeline.push(d.previewStage);}},(message,level,agent)=>logs.push({message,level,agent}),deps);
 assert.equal(result.status,'success');
 assert.deepEqual(timeline,['research','writer','humanizing','humanizer','reviewing','main','writer','humanizing','humanizer','reviewing','main','approved','image']);
 assert.deepEqual(previews.map(p=>p.article),[writer.article,writer.article,revised.article,revised.article,revised.article]);
 const main=logs.filter(l=>l.agent==='main').map(l=>l.message).join('\n');
 assert.match(main,/본문 1차 검수 반려: 부정어 누락/);
 assert.match(main,/본문 2차 보완 시작/);assert.match(main,/본문 2차 검수 통과/);
 assert.ok(logs.some(l=>l.agent==='writer' && l.message.includes('부정어 누락')));
 assert.doesNotMatch(logs.map(l=>l.message).join('\n'),/프롬프트 크기|토큰 사용량/);
 assert.equal(calls.length,8);assert.equal(result.tokenUsage.total,80);
});
test('blocked review never marks preview approved or starts images',async()=>{
 const {deps,calls}=fixture({main:[{status:'BLOCK',failureReason:'사실 오류'}]});const previews=[];
 const result=await generate({...options,includeTitleImage:true,onArticleReady:d=>previews.push(d)},()=>{},deps);
 assert.equal(result.status,'failed');assert.deepEqual(previews.map(p=>p.previewStage),['humanizing','reviewing']);
 assert.ok(!calls.some(c=>c.agent==='image'));
});
test('successful article uses research, writer, humanizer and one review',async()=>{const {calls,deps}=fixture();const result=await generate(options,()=>{},deps);assert.equal(result.status,'success');assert.deepEqual(calls.map(x=>x.agent),['research','writer','humanizer','main']);assert.equal(result.tokenUsage.total,40);});
test('one targeted correction, no third writing attempt',async()=>{const {calls,deps}=fixture({main:[{status:'REVISION',revisionInstructions:['fix claim']},{status:'REVISION',failureReason:'still wrong'}]});const result=await generate(options,()=>{},deps);assert.equal(result.status,'failed');assert.equal(result.article,writer.article);assert.equal(calls.filter(c=>c.agent==='writer').length,2);});
test('same search evidence is not reviewed again',async()=>{const {calls,deps}=fixture({research:[{status:'REVISION',searchNeed:'normal',searchQueries:['missing']} ]});const result=await generate({...options,onSearchNeeded:async()=>({searchResults:[]})},()=>{},deps);assert.equal(result.status,'failed');assert.equal(calls.length,1);});
test('unknown primary source is accepted structurally; fabricated citation is rejected',()=>{const sources=[{sourceId:'one',url:'https://example.com',excerpt:'원문 근거'}];const r={searchNeed:'strict',factChecks:[{claim:'핵심',essential:true,supported:true,sourceIds:['one']}]};assert.equal(evidenceIssue(r,sources),'');assert.notEqual(evidenceIssue({...r,factChecks:[{...r.factChecks[0],sourceIds:['invented']}]},sources),'');});
test('image failure preserves article and blocks automatic publication',async()=>{const {deps,calls}=fixture();const result=await generate({...options,includeTitleImage:true},()=>{},deps);assert.equal(result.status,'success');assert.equal(result.article,writer.article);assert.equal(result.publishable,false);assert.equal(calls.filter(c=>c.agent==='image').length,2);});
test('review sees original excerpts, not retrieval-score verdicts',()=>{const prompt=prompts.reviewPrompt({jobDir:'.',writerResult:writer,searchResults:[{sourceId:'s',url:'https://source.example',excerpt:'원문 원문'}]});assert.match(prompt,/원문 원문/);assert.match(prompt,/primary source/);});
test('three overall attempts preserve detailed reasons and aggregate usage',async()=>{
 const {calls,deps}=fixture({research:Array.from({length:3},(_,i)=>({status:'BLOCK',searchNeed:'strict',finalTitle:'주제 '+i,failureReason:'공고의 지원대상 본문 없음 '+i}))});
 const result=await generate({...options,topicMode:'auto'},()=>{},deps);
 assert.equal(result.attempts.length,3);assert.equal(calls.length,3);assert.equal(result.tokenUsage.total,30);
 assert.match(result.failureReason,/공고의 지원대상 본문 없음 2/);assert.match(result.failureReason,/3회 시도 소진/);
 assert.equal(calls[2].tokenOffset,20);assert.equal(calls[2].options.priorAttempts.length,2);
});
test('new hidden candidates do not trigger a second review of identical delivered evidence',async()=>{
 const sources=Array.from({length:8},(_,i)=>({sourceId:'s'+i,url:'https://a.example/'+i,excerpt:'text '+i}));
 const {calls,deps}=fixture({research:[{status:'REVISION',searchNeed:'strict',searchQueries:['조건 원문'],failureReason:'조건 없음'}]});
 await generate({...options,searchResults:sources,onSearchNeeded:async()=>({searchResults:[...sources,{sourceId:'hidden',url:'https://new.example',excerpt:'new'}]})},()=>{},deps);
 assert.equal(calls.length,1);
});
test('manual retries keep original topic and stop immediately on success',async()=>{
 const {calls,deps}=fixture({research:[{status:'BLOCK',failureReason:'첫 검색 실패'},research]});
 const result=await generate({...options,topicMode:'manual',topic:'사용자 주제'},()=>{},deps);
 assert.equal(result.status,'success');assert.equal(result.attempts.length,2);
 assert.ok(calls.every(c=>c.options.topic==='사용자 주제'));
});
test('each completed response is preserved before later results overwrite the canonical file',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blogauto-attempt-test-'));
 const {deps}=fixture({research:[{status:'BLOCK',failureReason:'첫 검색 실패'},research]});
 try{await generate({...options,topicMode:'auto',jobDir:dir},()=>{},deps);
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'attempts.json'))).length,2);
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'attempt-1','01-research-result.json'))).status,'BLOCK');
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'attempt-2','01-research-result.json'))).status,'PASS');
 }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'blogauto-attempt-test-'));fs.rmSync(dir,{recursive:true,force:true});}
});
test('execution errors do not consume three automatic retries',async()=>{
 const {deps}=fixture();let n=0;deps.runTask=async()=>{n++;throw Object.assign(new Error('usage limit'),{code:'CODEX_USAGE_LIMIT'});};
 await assert.rejects(generate({...options,topicMode:'auto'},()=>{},deps),e=>e.code==='CODEX_USAGE_LIMIT' && e.attempts[0].status==='execution_error');assert.equal(n,1);
});
test('blocked research does not spend tokens on image style analysis',async()=>{const {calls,deps}=fixture({research:[{status:'BLOCK',failureReason:'missing evidence'}]});await generate({...options,includeTitleImage:true,accountImageStyle:{sampleImagePath:'sample.png'}},()=>{},deps);assert.deepEqual(calls.map(c=>c.agent),['research']);});
test('image quota error preserves checked text without another image attempt',async()=>{
 const {deps}=fixture();const run=deps.runTask;let images=0;
 deps.runTask=async args=>{if(args.agent==='image'){images++;throw Object.assign(new Error('quota'),{code:'CODEX_USAGE_LIMIT'});}return run(args);};
 const result=await generate({...options,includeTitleImage:true},()=>{},deps);
 assert.equal(result.article,writer.article);assert.equal(result.publishable,false);assert.equal(images,1);
});
test('no image task is spent when the writer has no requested images',async()=>{
 const {deps,calls}=fixture();await generate({...options,maxBodyImages:10},()=>{},deps);
 assert.deepEqual(calls.map(c=>c.agent),['research','writer','humanizer','main']);
});

test('empty retrieval stops the whole retry cycle before spending more agent tokens',async()=>{
 const {calls,deps}=fixture({research:[{status:'REVISION',searchNeed:'strict',searchQueries:['지원 안내'],failureReason:'현재 조건 확인 필요'}]});
 const result=await generate({...options,topicMode:'auto',onSearchNeeded:async()=>({searchResults:[]})},()=>{},deps);
 assert.equal(calls.length,1);assert.equal(result.attempts.length,1);assert.equal(result.retrievalStopped,true);
 assert.match(result.failureReason,/검색 근거 확보 중단/);assert.doesNotMatch(result.failureReason,/3회 시도 소진/);
});
test('verification-only requests reach retrieval even when discovery queries are empty',async()=>{
 const {deps}=fixture({research:[{status:'REVISION',searchNeed:'strict',searchQueries:[],verificationQueries:['법령 제3조 원문'],failureReason:'조문 확인 필요'}]});
 let received;
 await generate({...options,topicMode:'auto',onSearchNeeded:async research=>{received=research;return {searchResults:[]};}},()=>{},deps);
 assert.deepEqual(received.verificationQueries,['법령 제3조 원문']);assert.deepEqual(received.searchQueries,[]);
});

test('content strategy travels through actual writer, review and image prompts without additional calls',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blogauto-strategy-'));
 try {
  const contentStrategy={audience:'처음 신청하는 사업자',primaryQuestion:'임차 점포도 지원되나요?',thumbnailMessage:'신청 전 임차 조건 확인'};
  const planned={...research,writerContract:{readerPromise:'임차 조건을 판단한다',contentStrategy}};
  const written={...writer,article:'임차 조건을 먼저 확인하세요. 지원 대상은 공고 조건에 따라 달라집니다.',titleImagePrompt:'임차 조건 안내 카드',titleImageText:['임차 조건 확인']};
  const {deps,calls}=fixture({research:[planned],writer:[written]});
  Object.assign(deps,{researchPrompt:prompts.researchPrompt,writerPrompt:prompts.writerPrompt,reviewPrompt:prompts.reviewPrompt,imagePrompt:require('../src/lib/codexRunner')._private.buildImageWorkerPrompt,imageIssue:()=>'',applyImages:a=>a});
  await generate({...options,jobDir:dir,runtimeRoot:dir,includeTitleImage:true},()=>{},deps);
  assert.deepEqual(calls.map(c=>c.agent),['research','writer','humanizer','main','image']);
  for(const agent of ['writer','main','image'])assert.ok(calls.find(c=>c.agent===agent).prompt.includes(contentStrategy.thumbnailMessage),agent+' lost strategy');
  const image=calls.find(c=>c.agent==='image').prompt;
  assert.ok(image.includes('임차 조건을 먼저 확인하세요.'));assert.ok(!image.includes('2-4 concrete article-wide'));
  assert.match(calls.find(c=>c.agent==='main').prompt,/FAQ 유무.*반려 사유가 아니다/);
 }finally{assert.ok(dir.startsWith(path.join(os.tmpdir(),'blogauto-strategy-')));fs.rmSync(dir,{recursive:true,force:true});}
});

test('fact-based PASS after retrieval reaches writer even when no further search is requested',async()=>{
 const sources=[{sourceId:'official',url:'https://example.com/notice',excerpt:'공식 원문 조건'}];
 const passed={...research,factBased:true,factChecks:[{claim:'조건',essential:true,supported:true,sourceIds:['official']}]};
 assert.equal(evidenceIssue(passed,sources),'');
 assert.notEqual(evidenceIssue(passed,[]),'');
 const {calls,deps}=fixture({research:[{status:'REVISION',searchNeed:'strict',searchQueries:['조건 공고']},passed]});
 const result=await generate({...options,topicMode:'auto',onSearchNeeded:async()=>({searchResults:sources})},()=>{},deps);
 assert.equal(result.status,'success');assert.equal(result.attempts.length,1);
 assert.deepEqual(calls.map(c=>c.agent),['research','research','writer','humanizer','main']);
});

test('bounded evidence packet retains all cited evidence and omits repeated research telemetry',()=>{
 const sources=Array.from({length:16},(_,i)=>({sourceId:'s'+i,url:'https://example.com/'+i,excerpt:'근거 '+i}));
 assert.equal(prompts.sourcesFor({searchResults:sources}).length,8);
 const r={...research,factChecks:[{essential:true,sourceIds:['s15']}],tokenUsage:{secretTelemetry:'DO_NOT_REPEAT'},confirmedFacts:['DUPLICATE_FACT']};
 const packet=prompts.sourcesFor({searchResults:sources,researchTitleResult:r});assert.equal(packet[0].sourceId,'s15');
 const prompt=prompts.writerPrompt({jobDir:'.',researchTitleResult:r,searchResults:sources});
 assert.ok(prompt.includes('근거 15'));assert.ok(!prompt.includes('DO_NOT_REPEAT'));assert.ok(!prompt.includes('DUPLICATE_FACT'));
});
test('supplement searches are limited to missing evidence without dropping final supported claims',async()=>{
 const pending={status:'REVISION',searchNeed:'strict',searchQueries:['a','b','c','d'],verificationQueries:['v1','v2']};
 const sources=[{sourceId:'s',url:'https://example.com/s',excerpt:'근거'}];
 const {deps}=fixture({research:[pending,{...pending,searchQueries:['e','f','g'],verificationQueries:['v3','v4']},{...research,factBased:true,factChecks:[{essential:true,supported:true,sourceIds:['s']}]}]});
 const received=[];
 const result=await generate({...options,onSearchNeeded:async(r,c)=>{received.push(r);return {searchResults:sources.map(s=>({...s,excerpt:s.excerpt+c.round}))};}},()=>{},deps);
 assert.equal(result.status,'success');assert.deepEqual(received[0].searchQueries,['a','b']);assert.deepEqual(received[0].verificationQueries,['v1']);
 assert.equal(received[1].searchQueries.length+received[1].verificationQueries.length,2);
});

test('auto mode does not restart research after the single editorial correction fails',async()=>{
 const {calls,deps}=fixture({main:[{status:'REVISION',publishable:false,revisionInstructions:['도입을 독자 질문에 답하도록 수정']},{status:'REVISION',publishable:false,failureReason:'여전히 공고 항목 나열'}]});
 const result=await generate({...options,topicMode:'auto'},()=>{},deps);
 assert.equal(result.status,'failed');assert.equal(result.contentRevisionStopped,true);assert.equal(result.attempts.length,1);
 assert.deepEqual(calls.map(c=>c.agent),['research','writer','humanizer','main','writer','humanizer','main']);assert.match(result.failureReason,/본문 보완 중단/);
});
test('tracking cleanup happens before source validation and review without another model call',async()=>{
 const {calls,deps}=fixture({writer:[{...writer,article:'본문\n[SECTION - 참고자료]\nhttps://agency.example/?id=1&utm_source=chatgpt.com',citations:[{sourceId:'s',url:'https://agency.example/?id=1&utm_source=chatgpt.com'}]}]});
 deps.writerIssue=r=>{assert.doesNotMatch(r.article,/utm_source/);return '';};
 deps.reviewPrompt=o=>{assert.equal(o.writerResult.citations[0].url,'https://agency.example/?id=1');return '';};
 const result=await generate(options,()=>{},deps);assert.equal(result.status,'success');assert.equal(calls.length,4);
});

test('main sees edited text and before/after evidence before image work',async()=>{
 const input={...writer,article:'신청에 있어서 서류가 필요합니다.'};
 const {deps,calls}=fixture({writer:[input],humanizer:[{status:'success',edits:[{id:'b0',text:'신청하려면 서류가 필요합니다.'}]}],main:[{...review,humanizerDecisions:[{id:'b0',action:'keep'}]}]});
 let reviewed;
 deps.reviewPrompt=o=>{reviewed=o;return '';};deps.imageIssue=()=>'';
 const result=await generate({...options,includeTitleImage:true},()=>{},deps);
 assert.equal(result.article,'신청하려면 서류가 필요합니다.');assert.equal(reviewed.writerResult.article,result.article);
 assert.deepEqual(reviewed.humanizerChanges,[{id:'b0',before:input.article,after:result.article}]);
 assert.deepEqual(calls.map(c=>c.agent),['research','writer','humanizer','main','image']);
});

test('bad humanizer output preserves raw draft and stops before review, images or research retry',async()=>{
 const {deps,calls}=fixture({humanizer:[{status:'success',edits:[{id:'missing',text:'손상'}]}]});
 const result=await generate({...options,topicMode:'auto',includeTitleImage:true},()=>{},deps);
 assert.equal(result.failurePhase,'humanizer');assert.equal(result.article,writer.article);assert.equal(result.attempts.length,1);
 assert.deepEqual(calls.map(c=>c.agent),['research','writer','humanizer']);
});

test('review feedback starts a fresh humanizer context rather than reusing rejected edits',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'humanizer-pipeline-'));
 try{
  const {deps,calls}=fixture({main:[{status:'REVISION',revisionInstructions:['조건 확인']},review]});
  const result=await generate({...options,jobDir:dir},()=>{},deps);
  assert.equal(result.status,'success');assert.equal(calls.filter(c=>c.agent==='writer').length,2);assert.equal(calls.filter(c=>c.agent==='humanizer').length,2);
  assert.ok(calls.filter(c=>c.agent==='humanizer')[1].prompt.includes('조건 확인'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Writer restoration after rejected humanizer edit reaches Main without the rejected cache',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'humanizer-restoration-'));
 try{
  const draft={...writer,article:'참여할 수 있습니다.'};
  const {deps,calls}=fixture({writer:[draft,draft],humanizer:[{status:'success',edits:[{id:'b0',text:'참여합니다.'}]},{status:'success',edits:[]}],main:[{status:'REVISION',humanizerDecisions:[{id:'b0',action:'keep'}],revisionInstructions:['가능성을 단정하지 말고 원문으로 복원']},review]});
  const seen=[];deps.reviewPrompt=o=>{seen.push(o.writerResult.article);return '';};
  const result=await generate({...options,jobDir:dir},()=>{},deps);
  assert.equal(result.status,'success');assert.deepEqual(seen,['참여합니다.',draft.article]);assert.equal(result.article,draft.article);
  assert.equal(calls.filter(c=>c.agent==='humanizer').length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Main restores its rejected edit before approved preview and images without a Writer rerun',async()=>{
 const input={...writer,article:'참여할 수 있습니다.'};
 const {deps,calls}=fixture({writer:[input],humanizer:[{status:'success',edits:[{id:'b0',text:'참여합니다.'}]}],main:[{...review,humanizerDecisions:[{id:'b0',action:'restore'}]}]});
 const previews=[];deps.imageIssue=()=>'';deps.imagePrompt=o=>{assert.equal(o.writerResult.article,input.article);return '';};
 const result=await generate({...options,includeTitleImage:true,onArticleReady:p=>previews.push(p)},()=>{},deps);
 assert.equal(result.status,'success');assert.equal(result.article,input.article);assert.equal(previews.at(-1).article,input.article);
 assert.deepEqual(calls.map(c=>c.agent),['research','writer','humanizer','main','image']);
});
