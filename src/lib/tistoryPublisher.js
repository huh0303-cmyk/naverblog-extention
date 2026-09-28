const {getBridge} = require('./extensionBridge');
const {TISTORY_ACCOUNT_ID, normalizeTistoryBlogId} = require('./tistoryTarget');
function requireCompatibleTistoryEditor(result,blogId){
  require('./naverPublisher').requireCompatibleEditor(result,blogId,'20260927.5');
  if(result?.status!=='valid')return;
  const [date,revision]=String(result.editorBuild || '').split('.').map(Number);
  if(!Number.isFinite(date)||!Number.isFinite(revision)||date<20260927||(date===20260927&&revision<5))throw Object.assign(new Error(`${blogId} 티스토리 Chrome의 BlogAuto 확장을 새로고침하세요. 예약 등록 확인에는 확장 20260927.5 이상이 필요합니다. 재발행은 하지 않았습니다.`),{code:'EXTENSION_UPDATE_REQUIRED'});
}
async function checkTistorySession(options={}) {
  const bridge=getBridge(), tistoryBlogId=normalizeTistoryBlogId(options.tistoryBlogId);
  if (!bridge.snapshot(TISTORY_ACCOUNT_ID).connected) return {status:'disconnected',reason:'티스토리 공용 Chrome에서 BlogAuto 확장을 연결하세요.'};
  const result=await bridge.request(TISTORY_ACCOUNT_ID,'session',{tistoryBlogId,category:options.category || '',interactive:options.interactiveLogin!==false});
  requireCompatibleTistoryEditor(result,tistoryBlogId);
  return result;
}
async function publishToTistory(options={}) {
  const tistoryBlogId=normalizeTistoryBlogId(options.tistoryBlogId);
  if (!tistoryBlogId) throw new Error('티스토리 발행 대상이 비어 있습니다.');
  const result=await getBridge().request(TISTORY_ACCOUNT_ID,'publish',{
    tistoryBlogId,title:options.title,article:options.article,titleImagePath:options.titleImagePath,
    bodyImages:options.bodyImages || [],tags:options.tags || [],category:options.category || '',
    publishVisibility:options.publishVisibility || (options.publishPrivate===false?'public':'private'),
    publishScheduleMode:options.publishScheduleMode || 'now',reserveAfterHours:options.reserveAfterHours || 3,
    scheduledAt:options.publishScheduleMode==='reserve' ? new Date(Math.ceil((Date.now()+Number(options.reserveAfterHours || 3)*3600000)/60000)*60000).toISOString() : undefined,
    breakSentencesInBody:true,interactive:true
  });
  if (!require('./publishRecovery').confirmedPublication(result)) throw Object.assign(new Error('티스토리 발행 결과를 확인하지 못했습니다.'),{code:'PUBLISH_UNCERTAIN'});
  options.log?.(result.scheduled ? `티스토리 예약 등록 완료: ${result.scheduledAt}` : `티스토리 발행 완료: ${result.url}`);
  return result;
}
module.exports={checkTistorySession,publishToTistory,requireCompatibleTistoryEditor};
