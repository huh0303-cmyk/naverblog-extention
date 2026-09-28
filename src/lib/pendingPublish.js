const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {readSettings,writeSettings}=require('./settings');

function pendingPublishState(root,busy=false){
  const settings=readSettings(root);
  const draft=settings.pendingNaverPublishDraft || settings.pendingGenerationDraft;
  const target=draft?.accountId ? {accountId:draft.accountId,blogId:draft.blogId,category:draft.category} : null;
  return {available:Boolean(draft),busy:Boolean(busy),status:draft?.status || '',...(target ? {target} : {})};
}
function cancelPendingPublish(root,busy=false){
  if(busy)throw new Error('현재 작업이 진행 중입니다. 작업이 종료된 뒤 기존 작업을 취소하세요.');
  const settings=readSettings(root);
  const draft=settings.pendingNaverPublishDraft || settings.pendingGenerationDraft;
  if(!draft)return {cancelled:false,...pendingPublishState(root)};
  const folder=path.join(root,'cancelled-drafts');
  fs.mkdirSync(folder,{recursive:true});
  const record={...draft,...(settings.pendingGenerationDraft ? {generationDraft:settings.pendingGenerationDraft} : {}),status:'cancelled_by_user',previousStatus:draft.status,cancelledAt:new Date().toISOString()};
  // Archive before clearing so the original article and recovery context survive.
  fs.writeFileSync(path.join(folder,crypto.randomUUID()+'.json'),JSON.stringify(record,null,2)+'\n');
  writeSettings(root,{pendingNaverPublishDraft:null,pendingGenerationDraft:null});
  return {cancelled:true,...pendingPublishState(root)};
}
module.exports={pendingPublishState,cancelPendingPublish};
