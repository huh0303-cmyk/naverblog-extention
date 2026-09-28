const { getBridge } = require('./extensionBridge');
const MIN_EDITOR_BUILD = '20260928.3';
function naverScheduledAt(hours, now = Date.now()) {
  const delay = Number(hours ?? 3);
  if (!Number.isFinite(delay) || delay <= 0) throw new Error('예약 시간은 0보다 큰 숫자여야 합니다.');
  const interval = 10 * 60 * 1000;
  return new Date(Math.ceil((now + delay * 3600000) / interval) * interval).toISOString();
}
function requireCompatibleEditor(result, blogId, requiredBuild=MIN_EDITOR_BUILD) {
  if(result?.status!=='valid')return;
  const build=String(result.editorBuild || /확장\s+(\d{8}\.\d+)/.exec(result.reason || '')?.[1] || '');
  const parts=build.split('.').map(Number), minimum=requiredBuild.split('.').map(Number);
  if(!build || parts[0]<minimum[0] || (parts[0]===minimum[0] && parts[1]<minimum[1])) {
    throw Object.assign(new Error(`${blogId} 계정 Chrome의 BlogAuto 확장이 구버전입니다 (${build || '버전 확인 불가'} / 필요 ${requiredBuild}). 해당 계정 창의 chrome://extensions에서 BlogAuto 새로고침(↻) 후 다시 시작하세요. 다른 계정 창의 새로고침은 이 창에 적용되지 않습니다. 원고 재생성은 진행하지 않았습니다.`),{code:'EXTENSION_UPDATE_REQUIRED'});
  }
}
function accountId(options) { const bridge=getBridge(); return options.accountId || [...bridge.clients.values()].find(c=>c.platform==='naver' && c.blogId===String(options.blogId || options.naverBlogId || ''))?.accountId; }
async function checkNaverSession(options={}) {
  const bridge=getBridge(), id=accountId(options);
  if (!id || !bridge.snapshot(id).connected) return {status:'disconnected',reason:'이 계정의 Chrome에서 확장을 연결해 주세요.'};
  const result=await bridge.request(id,'session',{interactive:options.interactiveLogin===true,preflightTitle:options.preflightTitle===true},0);
  requireCompatibleEditor(result,options.blogId || bridge.clientFor(id)?.blogId || id);
  return {...result, preparedSession:result.status==='valid' ? {accountId:id,connection:true} : null};
}
async function publishToNaver(options={}) {
  const bridge=getBridge(), id=accountId(options);
  const result=await bridge.request(id,'publish',{
    title:options.title,article:options.article,titleImagePath:options.titleImagePath,
    bodyImages:options.bodyImages || [],tags:options.tags || [], category:options.category || '',
    publishVisibility:options.publishVisibility || (options.publishPrivate===false?'public':'private'),
    publishScheduleMode:options.publishScheduleMode || 'now',reserveAfterHours:options.reserveAfterHours || 3,
    scheduledAt:options.publishScheduleMode==='reserve' ? naverScheduledAt(options.reserveAfterHours) : undefined,
    interactive:true,
    breakSentencesInBody:true
  },0);
  if (!require('./publishRecovery').confirmedPublication(result)) throw Object.assign(new Error('발행 완료를 확인하지 못했습니다. 열린 탭을 확인하세요.'),{code:'PUBLISH_UNCERTAIN'});
  options.log?.(result.scheduled ? `네이버 예약 등록 완료: ${result.scheduledAt}` : `확장 발행 완료: ${result.url}`); return result;
}
module.exports={publishToNaver,checkNaverSession,verifyOpenNaverSession:checkNaverSession,requireCompatibleEditor,naverScheduledAt};
