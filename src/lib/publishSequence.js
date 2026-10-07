// Persist each platform result before moving on. A retry never republishes a completed platform.
async function publishSequence(draft, {save, naver, tistory, log=()=>{}}) {
  const state={...draft,publications:{...draft.publications}};
  for (const platform of ['naver', ...(draft.tistoryBlogId && (draft.publishVisibility==='draft' ? draft.publishToTistoryAfterNaver===true : draft.publishToTistoryAfterNaver!==false) ? ['tistory'] : [])]) {
    const prior=state.publications[platform];
    if (prior?.status==='done') { log(`${platform==='naver'?'네이버':'티스토리'} 발행 완료 기록을 확인했습니다. 다음 단계로 이어갑니다.`); continue; }
    if (['running','uncertain'].includes(prior?.status)) throw Object.assign(new Error(`${platform==='naver'?'네이버':'티스토리'} 이전 발행 결과를 먼저 확인하세요. 본문 상단의 ‘기존 작업 취소’로 원고를 해제할 수 있습니다.`),{code:'PUBLISH_UNCERTAIN'});
    state.publications[platform]={status:'running'};
    await save(state);
    try {
      const result=await (platform==='naver'?naver:tistory)(state);
      const expectsDraft=platform==='naver' && draft.publishVisibility==='draft';
      if ((expectsDraft && result?.saved!==true) || (!expectsDraft && result?.saved===true) || !require('./publishRecovery').confirmedPublication(result)) throw Object.assign(new Error('발행 완료 증거를 확인하지 못했습니다.'),{code:'PUBLISH_UNCERTAIN'});
      state.publications[platform]={status:'done',...result};
      await save(state);
    } catch(error) {
      state.publications[platform]={status:error.code==='PUBLISH_UNCERTAIN'?'uncertain':'failed',reason:error.message};
      await save(state);
      throw error;
    }
  }
  return state;
}
module.exports={publishSequence};
