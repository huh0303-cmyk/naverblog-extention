// Explicit recovery E2E for the already generated pending draft. Never start a new generation.
const fs=require('node:fs'),path=require('node:path');
const {app}=require('electron');
const root=process.env.BLOGAUTO_RUNTIME_ROOT;
const {readSettings}=require('../src/lib/settings');
const expected=readSettings(root).pendingNaverPublishDraft;
if(!expected?.article || !expected.title || !expected.jobId)throw new Error('복구할 기존 원고가 없습니다.');
process.env.BLOGAUTO_AUTOSTART='0';process.env.BLOGAUTO_SKIP_CODEX_USAGE_REFRESH='1';
let started=false;
app.on('web-contents-created',(_event,contents)=>contents.once('did-finish-load',async()=>{
 if(started)return;started=true;
 try{
  await new Promise(resolve=>setTimeout(resolve,1500));
  const {checkNaverSession}=require('../src/lib/naverPublisher');
  const {checkTistorySession}=require('../src/lib/tistoryPublisher');
  let ready=false,reported=false;
  while(!ready){
   try{
    const n=await checkNaverSession({accountId:expected.accountId,blogId:expected.blogId});
    if(n.status!=='valid')throw new Error(n.reason);
    if(expected.tistoryBlogId){const t=await checkTistorySession({tistoryBlogId:expected.tistoryBlogId,category:expected.category,interactiveLogin:true});if(t.status!=='valid')throw new Error(t.reason);}
    ready=true;
   }catch(error){if(!reported){console.log('RECOVERY_WAITING_EXTENSION',error.message);reported=true;}await new Promise(resolve=>setTimeout(resolve,5000));}
  }
  const current=readSettings(root).pendingNaverPublishDraft;
  if(current?.jobId!==expected.jobId || current.article!==expected.article)throw new Error('보류 원고가 변경되어 테스트를 중지했습니다.');
  const result=await contents.executeJavaScript(`window.blogAuto.startJob(${JSON.stringify({...current,publishAfterGenerate:true,topicMode:'manual'})})`);
  const report={originalJobId:expected.jobId,status:result.status,reason:result.reason || '',at:new Date().toISOString(),pending:readSettings(root).pendingNaverPublishDraft?.publications || null};
  fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});
  fs.writeFileSync(path.resolve(__dirname,'../artifacts/reservation-recovery-e2e.json'),JSON.stringify(report,null,2));
  console.log('RECOVERY_E2E_COMPLETE',JSON.stringify(report));
 }catch(error){console.error('RECOVERY_E2E_FAILED',error.message);}
}));
