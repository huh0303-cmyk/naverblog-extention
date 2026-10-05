// Bounded orchestration. Only agents decide meaning, relevance and factual support.
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {sourcesFor}=require('./generationPrompts');
const {cleanPublicationUrls}=require('./publicationFormat');
const {articleCharacterCount}=require('./articleRequirements');
const {canonicalUrl}=require('./evidenceText');
const {humanize,applyReview}=require('../../packages/blog-humanizer');
const {resolveImageStyle}=require('./accountImageStyle');
const normalizeTitle=s=>String(s || '').trim();
function usableImages(result,jobDir){
  if(!result)return null;
  const resolve=file=>file?(path.isAbsolute(file)?file:path.resolve(jobDir || '.',file)):'';
  const titleImagePath=resolve(result.titleImagePath);
  return {...result,titleImagePath,titleImageVerified:result.titleImageVerified===true && Boolean(titleImagePath && fs.existsSync(titleImagePath)),
    bodyImages:(result.bodyImages || []).map(image=>{const file=resolve(image.path);return {...image,path:file,summaryVerified:image.summaryVerified===true && Boolean(file && fs.existsSync(file))};})};
}
function evidenceIssue(research, sources, options={}) {
  // User-selected source-only mode checks readable input, not source authority
  // or independent corroboration. Content fidelity remains the agents' job.
  if(options.trustBlogAsSource===true)return sources.some(s=>String(s.excerpt || '').trim())?'':'요약·리뷰에 사용할 원문 내용이 필요합니다.';
  // No more searching does not mean that no evidence has been collected.
  if(research.searchNeed==='skip' && research.factBased===false && !(research.factChecks || []).some(f=>f.essential===true))return '';
  const facts=Array.isArray(research.factChecks)?research.factChecks:[];
  const byId=new Map(sources.map(s=>[s.sourceId,s]));
  if(!facts.some(f=>f.essential===true))return '핵심 주장과 원문 출처 연결(factChecks)이 필요합니다.';
  for(const fact of facts.filter(f=>f.essential===true)){
    if(fact.supported!==true || !Array.isArray(fact.sourceIds) || !fact.sourceIds.length || !fact.sourceIds.every(id=>String(byId.get(id)?.excerpt || '').trim()))return `핵심 주장 출처 연결을 확인해 주세요: ${fact.claim || ''}`;
  }
  return '';
}
const fingerprint=sources=>crypto.createHash('sha256').update(JSON.stringify(sources.map(s=>[canonicalUrl(s.url),s.excerpt]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest('hex');
async function generateAttempt(options, log, deps) {
  const progress=(message,level='info',agent='main')=>{
    log(message,level,'main');
    if(['research','writer'].includes(agent))log(message,level,agent);
  };
  const reasons=values=>[...new Set(values.filter(Boolean))].join(' / ');
  let effective={...options,searchResults:options.searchResults || [],sourceQuality:options.sourceQuality || {status:'not_requested'}};
  const usage={total:0,grossTotal:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,promptCharacters:0,agents:{},grossAgents:{},promptCharactersByAgent:{}};
  const snapshot=()=>({...usage,estimatedPromptTokens:Math.ceil(usage.promptCharacters/3)});
  const run=async(agent,prompt,file,resultFile)=>{
    const result=await deps.runTask({options:effective,prompt,promptFileName:file,resultFileName:resultFile,log,agent,
      tokenOffset:usage.total,grossTokenOffset:usage.grossTotal,inputTokenOffset:usage.inputTokens,cachedInputTokenOffset:usage.cachedInputTokens,outputTokenOffset:usage.outputTokens,promptCharacterOffset:usage.promptCharacters,agentTokenOffset:usage.agents[agent] || 0});
    const u=result.tokenUsage || {};
    for(const key of ['total','grossTotal','inputTokens','cachedInputTokens','outputTokens','promptCharacters'])usage[key]+=Number(u[key] || 0);
    usage.agents[agent]=(usage.agents[agent] || 0)+Number(u.total || 0);usage.grossAgents[agent]=(usage.grossAgents[agent] || 0)+Number(u.grossTotal || 0);
    usage.promptCharactersByAgent[agent]=(usage.promptCharactersByAgent[agent] || 0)+Number(u.promptCharacters || 0);if(u.rateLimits)usage.rateLimits=u.rateLimits;
    return result;
  };
  let research=null,writer=null,review=null,retrievalStopped=false;
  const resume=options.imageCheckpoint;
  let finalTitle='';
  const failed=(phase,reason,failureKind=phase==='humanizer'?'execution':'quality')=>({status:'failed',failureKind,retrievalStopped,failurePhase:phase,failureReason:reason,title:writer?.title || '',article:writer?.article || '',tags:writer?.tags || [],bodyImages:[],titleImagePath:'',notes:[reason],researchTitleResult:research,mainReviewResult:review,tokenUsage:snapshot()});
  const usesImages=options.includeTitleImage!==false || deps.bodyImageLimit(options.maxBodyImages)>0;
  if(resume){
    if(resume.version!==1 || resume.review?.status!=='PASS' || !resume.writer?.article || !resume.title)throw new Error('저장된 이미지 재개 원고가 유효하지 않습니다. 기존 작업을 확인하세요.');
    research=resume.research;writer=resume.writer;review=resume.review;finalTitle=resume.title;
    const resumedIssue=reasons([deps.writerIssue(writer,{...effective,researchTitleResult:research}),deps.imagePromptIssue(writer,effective)]);
    if(resumedIssue)return failed('writer',resumedIssue);
    options.onResearchTitle?.(research);
    progress('승인된 본문 재사용 · 조사·본문 생성·윤문·검수를 건너뛰고 이미지 단계부터 재개합니다.');
  }else{
  // One initial planning/research call; at most two evidence rounds. Never re-run on identical retrieval.
  progress('주제 조사 1차 시작','info','research');
  research=await run('research',deps.researchPrompt(effective),'research-title-prompt.txt','research-title-result.json');
  options.onResearchTitle?.(research);
  if(research.novelty?.duplicate===true)return {...failed('title_duplicate',research.novelty.reason || '최근 발행 글과 소재가 중복됩니다.'),status:'duplicate_retry',title:research.finalTitle || ''};
  let issue=evidenceIssue(research,effective.searchResults,effective);
  for(let round=1;round<=2 && (research.status==='REVISION' || (research.status==='PASS' && issue));round++){
    if(typeof options.onSearchNeeded!=='function' || research.searchNeed==='skip')break;
    const before=fingerprint(sourcesFor(effective));
    progress(`주제 조사 ${round}차 · 자료 보강 필요: ${reasons([research.failureReason,issue]) || '추가 원문 확인 요청'} · 검색 보강 ${round}/2 시작`,'info','research');
    const payload=await options.onSearchNeeded(research,{round,previousSearchResults:effective.searchResults,sourceQuality:effective.sourceQuality});
    const sources=payload?.searchResults || [];
    if(before===fingerprint(sourcesFor({...effective,searchResults:sources}))){retrievalStopped=true;issue=sources.length?'새로운 원문 근거가 없어 추가 검토·전체 재시도를 중지했습니다.':'선택한 검색 범위에서 읽을 수 있는 원문을 확보하지 못해 추가 검토·전체 재시도를 중지했습니다.';log(issue,'warn','research');break;}
    const deliveredKey=normalizeTitle(research.finalTitle)+'|'+fingerprint(sourcesFor({...effective,searchResults:sources}));
    if(options.reviewedEvidence?.has(deliveredKey)){retrievalStopped=true;issue='이 주제의 동일 근거는 앞선 시도에서 검토하여 추가 호출·전체 재시도를 중지했습니다.';log(issue,'warn','research');break;}
    options.reviewedEvidence?.add(deliveredKey);
    effective={...effective,searchResults:sources,sourceQuality:payload.sourceQuality,researchRevisionContext:issue};
    progress(`주제 조사 ${round+1}차 · 보강 자료 검토 시작`,'info','research');
    research=await run('research',deps.researchRetry(effective,research),`research-title-search-${round}.txt`,'research-title-result.json');
    options.onResearchTitle?.(research);issue=evidenceIssue(research,sources,effective);
    if(research.novelty?.duplicate===true)return {...failed('title_duplicate',research.novelty.reason || '최근 발행 글과 소재가 중복됩니다.'),status:'duplicate_retry',title:research.finalTitle || ''};
  }
  if(research.status!=='PASS' || issue)return failed('research',[research.failureReason,issue].filter(Boolean).filter((s,i,a)=>a.indexOf(s)===i).join('\n') || '핵심 주장의 근거를 확보하지 못했습니다.');
  finalTitle=normalizeTitle(research.finalTitle);if(!finalTitle)return failed('research','최종 제목이 없습니다.');
  if((options.publishedTopics || []).length){
    if(research.novelty?.duplicate===true)return {...failed('title_duplicate',research.novelty.reason || '최근 발행 글과 소재가 중복됩니다.'),status:'duplicate_retry',title:finalTitle};
    if(research.novelty?.duplicate!==false || !String(research.novelty.reason || '').trim())return failed('research','최근 발행 글과의 소재 중복 판단이 누락됐습니다. 본문 생성을 중지했습니다.');
  }
  const duplicate=await options.onFinalTitleCandidate?.(finalTitle,research);
  if(duplicate?.duplicate)return {...failed('title_duplicate',duplicate.reason || '동일한 제목이 있습니다.'),status:'duplicate_retry',title:finalTitle};
  progress('주제 선정 통과 · 본문 작성으로 이동','info','research');
  let feedback='';
  // At most one targeted correction. No outer UI loop may rerun the whole pipeline.
  for(let attempt=1;attempt<=2;attempt++){
    const params={...effective,topic:finalTitle,researchTitleResult:research,writerRevisionFeedback:feedback,writerAttempt:attempt,maxWriterAttempts:2};
    progress(`본문 ${attempt}차 ${attempt===1?'작성':'보완'} 시작`,'info','writer');
    writer=await run('writer',attempt===1?deps.writerPrompt(params):deps.writerRetry(params,writer),attempt===1?'prompt.txt':'prompt-retry-2.txt','agent-result.json');
    writer=cleanPublicationUrls(writer);
    progress(`본문 ${attempt}차 글자수: 공백 제외 ${articleCharacterCount(writer.article)}자 · 기준 1800~3000자`,'info','writer');
    const structural=reasons([deps.writerIssue(writer,params),deps.imagePromptIssue(writer,effective)]);
    if(structural){progress(`본문 ${attempt}차 형식 확인 실패: ${structural}`,'warn','writer');if(attempt===1 && writer.failureCode!=='INSUFFICIENT_EVIDENCE'){feedback=structural;continue;}return failed('writer',structural);}
    progress(`본문 ${attempt}차 작성 완료 · 블로그 문장 다듬기 시작`,'info','writer');
    options.onArticleReady?.({...writer,previewStage:'humanizing',writerAttempt:attempt});
    const originalWriter=writer;
    let humanized;
    try {
      humanized=await humanize({article:writer.article,title:finalTitle,category:effective.category,tone:effective.preferredTone,revisionInstructions:feedback}, {
        cacheDir:effective.jobDir?path.join(effective.jobDir,'humanizer-cache'):undefined,
        signal:options.signal,
        complete:prompt=>run('humanizer',prompt+`\nOutput JSON file: ${path.join(effective.jobDir || '.',`humanizer-result-${attempt}.json`)}\nSave the JSON file, then print BLOGAUTO_RESULT_READY.`, `humanizer-prompt-${attempt}.txt`,`humanizer-result-${attempt}.json`)
      });
      writer={...writer,article:humanized.article};
      const issue=reasons([deps.writerIssue(writer,params),deps.imagePromptIssue(writer,effective)]);
      if(issue){
        progress(`윤문 후 본문 조건 보완 필요: ${issue}`,'warn','writer');
        if(attempt===1){feedback=issue;continue;}
        return failed('writer',issue);
      }
    } catch(error) {
      writer=originalWriter;
      progress(`본문 문장 다듬기 중지 · 원본 보존: ${error.message}`,'warn','writer');
      return failed('humanizer',`본문을 보존했습니다. 문장 다듬기 단계 확인이 필요합니다: ${error.message}`);
    }
    progress(humanized.cached?'저장된 윤문 결과 재사용 · 검수 시작':humanized.changes.length?'블로그 문장 다듬기 완료 · 검수 시작':'불필요한 문장 수정 없이 원문 유지 · 검수 시작','info','writer');
    options.onArticleReady?.({...writer,previewStage:'reviewing',writerAttempt:attempt});
    review=await run('main',deps.reviewPrompt({...effective,researchTitleResult:research,writerResult:writer,finalTitle,humanizerChanges:humanized.changes}),`main-review-${attempt}.txt`,'main-review-result.json');
    try {
      const reviewed=applyReview(writer.article,humanized.changes,review.humanizerDecisions);
      writer={...writer,article:reviewed.article};
      if(reviewed.restoredIds.length)progress('메인 검증 · 불필요하거나 의미가 달라질 수 있는 윤문을 원문으로 복원했습니다.','info','writer');
    }catch(error){return failed('main_review',error.message,'execution');}
    const reviewIssue=reasons([deps.writerIssue(writer,params),deps.imagePromptIssue(writer,effective),deps.reviewIssue(review)]);
    if(review.status==='PASS' && !reviewIssue){progress(`본문 ${attempt}차 검수 통과`,'info','writer');break;}
    progress(`본문 ${attempt}차 검수 ${review.status==='BLOCK'?'중단':'반려'}: ${reasons([reviewIssue,review.failureReason,...(review.revisionInstructions || [])]) || '구체적인 수정 지침 없음'}${attempt===1 && review.status!=='BLOCK'?' · 본문 보완 준비':' · 작성 중지'}`,'warn','writer');
    if(attempt===2 || review.status==='BLOCK')return failed('main_review',reviewIssue || review.failureReason || '최종 검수에서 핵심 수정이 필요합니다.');
    feedback=[reviewIssue,review.failureReason,...(review.revisionInstructions || [])].filter(Boolean).join('\n');
    if(!feedback)return failed('main_review','구체적인 수정 지침 없이 재생성을 요청하여 중지했습니다.');
  }
  }
  options.onArticleReady?.({...writer,previewStage:'approved'});
  let savedImages=usableImages(resume?.images,options.jobDir);
  const checkpoint=()=>options.onImageCheckpoint?.({version:1,title:finalTitle,writer,research,review,images:savedImages,
    imageOptions:{includeTitleImage:options.includeTitleImage,maxBodyImages:options.maxBodyImages,titleImageAspectRatio:options.titleImageAspectRatio,bodyImageAspectRatio:options.bodyImageAspectRatio}});
  const needsImageWork=usesImages && (options.includeTitleImage!==false || writer.bodyImages?.length>0);
  if(needsImageWork)await checkpoint();
  effective.accountImageStylePrompt='';
  if(needsImageWork){
    try{
      effective.accountImageStylePrompt=await resolveImageStyle({
        read:options.getAccountImageStyle || (()=>options.accountImageStyle || {}),exists:fs.existsSync,log:progress,
        analyze:style=>run('imageStyle',deps.stylePrompt({...effective,...style}),'image-style-prompt.txt','image-style-result.json'),
        save:(source,result)=>options.onAccountImageStylePrompt?.({...result,sampleImageHash:source.sampleImageHash},source)
      });
    }catch(error){const reason=`본문은 보존했습니다. 이미지 스타일 확인 실패: ${error.message}`;progress(reason,'warn');return {...writer,status:'success',publishable:false,notes:[reason],tokenUsage:snapshot(),researchTitleResult:research,mainReviewResult:review};}
  }
  let result={...writer,title:finalTitle,publishable:true};
  if(needsImageWork){
    let images=savedImages,issue=images?deps.imageIssue(images,writer,effective):'이미지 생성 필요';
    for(let attempt=1;attempt<=2;attempt++){
      if(images && !issue)break;
      progress(`이미지 ${attempt}차 ${attempt===1?'생성':'보완'} 시작`);
      const request=images?deps.pendingImages(writer,images,effective):writer;
      try{
        const generated=await run('image',deps.imagePrompt({...effective,researchTitleResult:research,articleOpening:String(writer.article || '').slice(0,900),includeTitleImage:images?Boolean(request.titleImagePrompt):effective.includeTitleImage!==false,writerResult:request,finalTitle,imageRevisionFeedback:issue}),`image-worker-${attempt}.txt`,'image-worker-result.json');
        images=deps.mergeImages(images,usableImages(generated,options.jobDir));savedImages=images;await checkpoint();issue=deps.imageIssue(images,writer,effective);if(!issue){progress('이미지 생성 및 확인 완료');break;}
        progress(`이미지 ${attempt}차 확인: ${issue}`,'warn');
      }catch(error){
        // Execution failures already pass through the user-controlled model retry.
        // Do not retry again here: the user may have cancelled, or images may
        // have been generated before the response was lost. Only a returned
        // image verification failure permits the targeted correction above.
        issue=error.message;progress(`이미지 ${attempt}차 생성 실패: ${issue}`,'warn');break;
      }
    }
    result=deps.applyImages(result,images || {},effective);
    if(issue){result.publishable=false;result.notes=[...(result.notes || []),`본문은 보존했습니다. 이미지 확인 후 발행하세요: ${issue}`];log(result.notes.at(-1),'warn','image');}
  }
  return {...result,status:'success',researchTitleResult:research,mainReviewResult:review,tokenUsage:snapshot()};
}
async function generate(options,log,deps) {
  const restored=options.generationCheckpoint;
  if(restored && restored.version!==2)throw new Error('재개 기록 버전을 확인할 수 없습니다. 기존 작업을 취소한 뒤 다시 시작하세요.');
  const optionKeys=['topic','keyword','category','topicMode','currentDateLabel','includeTitleImage','maxBodyImages','titleImageAspectRatio','bodyImageAspectRatio','excludedTopics','publishPurpose','preferredTone','freshnessLevel','searchChannel','trustBlogAsSource','keywordLanes','recommendedKeywordLanes','historyTitles','searchResults','sourceQuality'];
  const recovery=restored?JSON.parse(JSON.stringify(restored)):{version:2,steps:{},retrievals:{},generationOptions:Object.fromEntries(optionKeys.filter(k=>options[k]!==undefined).map(k=>[k,options[k]])),attemptNumber:1};
  options={...options,...recovery.generationOptions};
  const saveRecovery=async()=>{await options.onGenerationCheckpoint?.(JSON.parse(JSON.stringify(recovery)));};
  await saveRecovery();
  if(restored)log('중단된 생성 작업 재개 · 완료된 단계는 저장 결과를 재사용합니다.','info','main');
  const limit=['auto','manual'].includes(options.topicMode)?3:1;
  const reviewedEvidence=new Set(recovery.priorEvidence || []),attemptedQueries=new Set(recovery.priorQueries || []);
  const attempts=[...(recovery.priorAttempts || [])];const totals={total:0,grossTotal:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,promptCharacters:0,agents:{}};
  const persist=()=>{if(options.jobDir)fs.writeFileSync(path.join(options.jobDir,'attempts.json'),JSON.stringify(attempts,null,2));};
  let result;
  for(let number=recovery.attemptNumber || 1;number<=limit;number++) {
    recovery.attemptNumber=number;await saveRecovery();
    const jobDir=options.jobDir?path.join(options.jobDir,`attempt-${number}`):undefined;
    if(jobDir)fs.mkdirSync(jobDir,{recursive:true});
    const entry={attempt:number,status:'running',startedAt:new Date().toISOString(),steps:[]};attempts.push(entry);persist();
    log(`전체 시도 ${number}/${limit} · ${number===1?'주제 조사 시작':options.topicMode==='auto'?'실패 근거를 반영해 다른 주제·범위 탐색':'입력 주제를 유지하고 검색 방법 변경'}`,'info','main');
    const priorAttempts=attempts.slice(0,-1).map(a=>({title:a.title,reason:a.reason,phase:a.phase,queries:a.queries}));
    const runTask=async args=>{
      const key=number+':'+args.promptFileName;
      if(recovery.steps[key]){
        log(`${args.agent} 완료 결과 재사용`,'info','main');
        return {...JSON.parse(JSON.stringify(recovery.steps[key])),tokenUsage:{}};
      }
      const step={step:entry.steps.length+1,agent:args.agent,startedAt:new Date().toISOString()};entry.steps.push(step);persist();
      const adjusted={...args};
      for(const [offset,key] of Object.entries({tokenOffset:'total',grossTokenOffset:'grossTotal',inputTokenOffset:'inputTokens',cachedInputTokenOffset:'cachedInputTokens',outputTokenOffset:'outputTokens',promptCharacterOffset:'promptCharacters'}))adjusted[offset]=(args[offset] || 0)+totals[key];
      adjusted.agentTokenOffset=(args.agentTokenOffset || 0)+(totals.agents[args.agent] || 0);
      try {
        const value=await deps.runTask(adjusted);
        // Image outputs are checkpointed after merging, style is keyed by the
        // live sample identity. Neither may be replayed by task filename alone.
        if(!['image','imageStyle'].includes(args.agent)){
          recovery.steps[key]=JSON.parse(JSON.stringify(value));await saveRecovery();
        }
        Object.assign(step,{status:value.status,reason:value.failureReason || '',title:value.finalTitle || value.title || '',tokenUsage:value.tokenUsage,finishedAt:new Date().toISOString()});
        if(jobDir){const base=String(step.step).padStart(2,'0')+'-'+args.agent;fs.writeFileSync(path.join(jobDir,base+'-result.json'),JSON.stringify(value,null,2));fs.writeFileSync(path.join(jobDir,base+'-prompt.txt'),args.prompt);}
        persist();return value;
      }catch(error){Object.assign(step,{status:'execution_error',reason:error.message,finishedAt:new Date().toISOString()});persist();throw error;}
    };
    try {
      result=await generateAttempt({...options,jobDir,attemptNumber:number,maxAttempts:limit,priorAttempts,reviewedEvidence,
        imageCheckpoint:recovery.imageCheckpoint,
        onImageCheckpoint:async checkpoint=>{recovery.imageCheckpoint=checkpoint;await saveRecovery();},
        onSearchNeeded:options.onSearchNeeded?async(research,context)=>{
          const retrievalKey=number+':'+context.round;
          if(recovery.retrievals[retrievalKey]){
            for(const key of recovery.retrievalQueries?.[retrievalKey] || [])attemptedQueries.add(key);
            return JSON.parse(JSON.stringify(recovery.retrievals[retrievalKey]));
          }
          const freshQueries=(queries,scope)=>(queries || []).filter(q=>{const normalized=String(q).replace(/\s+/g,' ').trim().toLowerCase();const key=scope+':'+normalized;if(!normalized || attemptedQueries.has(key))return false;attemptedQueries.add(key);return true;});
          const supplement=context.round>1;
          const verification=options.trustBlogAsSource===true?[]:freshQueries((research.verificationQueries || []).slice(0,supplement?2:1),'verification');
          const fresh=freshQueries((research.searchQueries || []).slice(0,supplement?Math.max(0,2-verification.length):2),'discovery');
          if(!fresh.length && !verification.length){log('이미 실행한 검색어뿐이어서 동일 검색을 생략합니다.','warn','research');return {searchResults:context.previousSearchResults};}
          entry.queries=[...(entry.queries || []),...fresh,...verification];persist();
          const payload=await options.onSearchNeeded({...research,searchQueries:fresh,verificationQueries:verification},{...context,attempt:number});
          recovery.retrievals[retrievalKey]=payload;
          recovery.retrievalQueries ||= {};recovery.retrievalQueries[retrievalKey]=[...attemptedQueries];await saveRecovery();
          const visible=sourcesFor({searchResults:payload?.searchResults || []});
          const searchRecord={round:context.round,queries:fresh,verificationQueries:verification,deliveredSources:visible};
          if(jobDir)fs.writeFileSync(path.join(jobDir,`search-${context.round}.json`),JSON.stringify(searchRecord,null,2));
          return payload;
        }:undefined},log,{...deps,runTask});
    }catch(error){entry.status='execution_error';entry.reason=error.message;entry.finishedAt=new Date().toISOString();persist();error.attempts=attempts;throw error;}
    const u=result.tokenUsage || {};
    for(const key of ['total','grossTotal','inputTokens','cachedInputTokens','outputTokens','promptCharacters'])totals[key]+=Number(u[key] || 0);
    for(const [agent,n] of Object.entries(u.agents || {}))totals.agents[agent]=(totals.agents[agent] || 0)+n;
    if(u.rateLimits)totals.rateLimits=u.rateLimits;
    Object.assign(entry,{status:result.status,phase:result.failurePhase || '',verdict:result.researchTitleResult?.status || '',reason:result.failureReason || '',title:result.researchTitleResult?.finalTitle || result.title,tokenUsage:u,finishedAt:new Date().toISOString()});persist();
    if(result.status==='success')break;
    if(result.status==='duplicate_retry'){
      log('기존 발행 소재와 중복되어 검색·본문·이미지 생성을 더 진행하지 않습니다.','warn','main');
      break;
    }
    if(result.failureKind==='execution'){
      // A returned but invalid response is not a completed step. Re-run only
      // that agent, retaining its preceding accepted results.
      const agent=result.failurePhase==='humanizer'?'humanizer':result.failurePhase==='main_review'?'main':null;
      if(agent){const prefix=number+':';const keys=Object.keys(recovery.steps).filter(k=>k.startsWith(prefix) && (agent==='humanizer'?k.includes('humanizer-prompt'):k.includes('main-review')));if(keys.length)delete recovery.steps[keys.at(-1)];await saveRecovery();}
      break;
    }
    if(['writer','main_review','humanizer'].includes(result.failurePhase)){
      result.contentRevisionStopped=true;
      log(result.failurePhase==='humanizer'?'윤문 단계 중지: 원본 본문을 보존하고 주제 재탐색·전체 재생성을 중지했습니다.':'본문 보완 종료: 같은 근거로 한 번 수정한 뒤에도 통과하지 못해 주제 재탐색·전체 재생성을 중지했습니다.','warn','main');
      break;
    }
    if(result.retrievalStopped){log(`전체 시도 ${number}/${limit} · 추가 조사 중지: ${entry.reason}`,'warn','main');break;}
    log(`전체 시도 ${number}/${limit} · ${entry.phase || '생성'} 단계 종료: ${entry.reason}`,'warn','main');
    recovery.priorAttempts=JSON.parse(JSON.stringify(attempts));recovery.priorQueries=[...attemptedQueries];recovery.priorEvidence=[...reviewedEvidence];
    // Execution/quota errors throw; a preserved draft with incomplete images returns success.
  }
  totals.estimatedPromptTokens=Math.ceil(totals.promptCharacters/3);
  return {...result,attempts,tokenUsage:totals,failureReason:result.status==='success'?result.failureReason:`${result.status==='duplicate_retry'?'중복 소재 제외':result.contentRevisionStopped?'본문 보완 중단':result.retrievalStopped?'검색 근거 확보 중단':`전체 ${attempts.length}회 시도 소진`} · ${result.failureReason || '생성 실패'}`};
}
module.exports={generate,evidenceIssue};
