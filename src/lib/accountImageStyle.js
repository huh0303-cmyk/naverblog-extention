// Image identity and cache validity only; visual interpretation belongs to the agent.
const sameSample=(a={},b={})=>Boolean(a.sampleImagePath && b.sampleImagePath &&
  a.sampleImagePath===b.sampleImagePath && a.sampleImageHash===b.sampleImageHash &&
  a.sampleImageUpdatedAt===b.sampleImageUpdatedAt);
const cachedStyle=(style={})=>style.sampleImagePath && style.sampleImageHash &&
  style.imageStylePromptStatus==='ready' && style.sampleImageHash===style.imageStylePromptSourceImageHash
  ? String(style.imageStylePrompt || '').trim():'';
function saveStyleResult(target,source,result){
  if(!target || !sameSample(target,source))return false;
  target.imageStylePrompt=result.status==='success'?String(result.imageStylePrompt || '').trim():'';
  target.imageStylePromptStatus=result.status==='success'?'ready':'failed';
  target.imageStylePromptUpdatedAt=new Date().toISOString();
  target.imageStylePromptSourceImageHash=source.sampleImageHash || '';
  target.imageStylePromptError=result.failureReason || '';
  return true;
}
async function resolveImageStyle({read,analyze,save=()=>{},exists=()=>true,log=()=>{}}){
  const source={...await read()};
  if(!source.sampleImagePath)return '';
  let result;
  try{
    if(!exists(source.sampleImagePath))throw Error('등록한 샘플 이미지 파일을 찾을 수 없습니다. 이미지를 다시 등록하거나 삭제해 주세요.');
    const cached=cachedStyle(source);if(cached)return cached;
    log('이미지 스타일 분석 시작');
    result=await analyze(source);
    if(result?.status!=='success' || !String(result.imageStylePrompt || '').trim())throw Error(result?.failureReason || '이미지 스타일 분석 결과가 비어 있습니다.');
  }catch(error){result={status:'failed',failureReason:error.message};}
  const current=await read();
  if(!current?.sampleImagePath){log('샘플 이미지 삭제 확인 · 기본 이미지 스타일로 진행합니다.');return '';}
  if(!sameSample(source,current))throw Error('분석 중 샘플 이미지가 변경되었습니다. 이전 스타일을 적용하지 않았습니다. 다시 시도해 주세요.');
  await save(source,result);
  if(result.status!=='success')throw Error(result.failureReason);
  return result.imageStylePrompt.trim();
}
module.exports={sameSample,cachedStyle,saveStyleResult,resolveImageStyle};
