const uncertain = message => Object.assign(new Error(message), {code:'PUBLISH_UNCERTAIN'});
function confirmedPublication(result) {
  return result?.published===true && (result.scheduled===true
    ? result.verification==='reservation-list' && Number.isFinite(Date.parse(result.scheduledAt)) && Boolean(result.managementUrl)
    : Boolean(result.url));
}
async function recoverPublication(draft,{bridge,save,log=()=>{}},platform) {
  if(draft.publications?.[platform]?.status==='done')return draft;
  const tistory=platform==='tistory',label=tistory?'티스토리':'네이버';
  const accountId=tistory?require('./tistoryTarget').TISTORY_ACCOUNT_ID:draft.accountId;
  const blogId=tistory?draft.tistoryBlogId:draft.blogId;
  if(!blogId)throw uncertain('이전 발행 대상 블로그를 확인할 수 없습니다.');
  const target=tistory?{tistoryBlogId:blogId}:{};
  const matching=[...bridge.tasks.values()].filter(t=>t.type==='publish' && t.accountId===accountId && t.blogId===blogId && t.payload.title===draft.title && t.payload.article===draft.article);
  const latest=matching.at(-1);
  // The platform is marked running before its bridge request. A stopped app can
  // therefore leave running behind even though no final publish was attempted.
  // Only the durable bridge journal can prove that authoring may safely resume.
  const unresolvedFinal=matching.some(t=>t.code==='PUBLISH_UNCERTAIN' || (t.stage==='final_publish' && t.state!=='done'));
  if(latest?.state==='done' && confirmedPublication(latest.result) && !unresolvedFinal){
    const recovered={...draft,status:'pending_naver_publish',publications:{...draft.publications,[platform]:{status:'done',...latest.result}}};
    await save(recovered);
    log(`${label} 저장된 발행 완료 결과를 복구했습니다. 중복 발행하지 않습니다.`);
    return recovered;
  }
  if(draft.publications?.[platform]?.status==='running' && latest
    && ['interrupted','cancelled','failed','expired'].includes(latest.state)
    && [undefined,'waiting_login','writing'].includes(latest.stage)
    && !unresolvedFinal){
    const recovered={...draft,status:'pending_naver_publish',publications:{...draft.publications,[platform]:{status:'failed',reason:'발행 전 중단 · 저장 원고와 편집기 입력 상태에서 이어서 진행'}}};
    await save(recovered);
    log(`${label} 최종 발행 전 중단 기록을 확인했습니다. 완료된 입력을 재사용해 이어갑니다.`);
    return recovered;
  }
  const tasks=matching.filter(t=>t.stage==='final_publish' && (['interrupted','cancelled'].includes(t.state)||t.code==='PUBLISH_UNCERTAIN'));
  if(!tasks.length)throw uncertain('이 원고의 이전 발행 기록을 찾지 못했습니다. 자동 재발행하지 않습니다.');
  const dates=tasks.map(t=>t.payload.publishScheduleMode==='reserve' && Date.parse(t.payload.scheduledAt));
  if(dates.some(d=>!Number.isFinite(d)||d===false))throw uncertain('이전 예약 시각을 확인할 수 없습니다. 게시글 목록에서 발행 여부를 확인하세요.');
  const interval=tistory?60000:600000;
  const times=[...new Set(dates.map(d=>new Date(Math.ceil(d/interval)*interval).toISOString()))];
  if(times.length!==1)throw uncertain('동일 원고에 서로 다른 예약 시각이 남아 있습니다. 예약 목록 확인이 필요합니다.');
  // Older extensions treat unknown task types as authoring. Never enqueue a
  // verification request until the connected editor explicitly proves support.
  const session=await bridge.request(accountId,'session',{...target,interactive:true});
  if(session?.status!=='valid')throw uncertain(session?.reason || '예약 확인을 위해 해당 계정의 Chrome 로그인이 필요합니다.');
  (tistory?require('./tistoryPublisher').requireCompatibleTistoryEditor:require('./naverPublisher').requireCompatibleEditor)(session,blogId);
  log(`이전 ${label} 예약 등록 결과를 확인합니다. 원고 입력과 발행 버튼은 실행하지 않습니다.`);
  const result=await bridge.request(accountId,'verifyPublish',{...target,title:draft.title,article:draft.article,publishScheduleMode:'reserve',scheduledAt:times[0],interactive:true});
  if(!confirmedPublication(result) || result.scheduled!==true || Date.parse(result.scheduledAt)!==Date.parse(times[0]))throw uncertain(`이전 ${label} 예약 등록을 확정하지 못했습니다. 원고를 보존하고 자동 재발행을 중지했습니다.`);
  const recovered={...draft,status:'pending_naver_publish',publications:{...draft.publications,[platform]:{status:'done',...result}}};
  await save(recovered);
  // The durable draft is saved first. Only the exact reviewed attempts are resolved.
  for(const task of tasks){task.previousOutcome={state:task.state,code:task.code,error:task.error};task.state='done';task.code='';task.result=result;task.resolvedAt=new Date().toISOString();}
  bridge.saveTasks();
  log(`${label} 예약 등록 확인 완료. 중복 등록 없이 다음 발행 단계로 이어갑니다.`);
  return recovered;
}
const recoverNaverPublication=(draft,options)=>recoverPublication(draft,options,'naver');
const recoverTistoryPublication=(draft,options)=>recoverPublication(draft,options,'tistory');
async function recoverPendingPublication(draft,options){
  let recovered=draft;
  if(recovered.publications?.naver?.status!=='done')recovered=await recoverNaverPublication(recovered,options);
  if(['running','uncertain'].includes(recovered.publications?.tistory?.status))recovered=await recoverTistoryPublication(recovered,options);
  if(recovered.publications?.naver?.status==='done' && recovered.publications?.tistory?.status==='done'){
    recovered={...recovered,status:'pending_naver_publish'};await options.save(recovered);
    options.log?.('네이버·티스토리 예약 등록 모두 확인했습니다. 원고 재생성과 재발행 없이 작업을 완료합니다.');
  }
  return recovered;
}
module.exports={confirmedPublication,recoverNaverPublication,recoverTistoryPublication,recoverPendingPublication};
