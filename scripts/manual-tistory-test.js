// Explicit developer E2E: reuse a saved draft, never call AI, publish one private test post.
// Run: electron scripts/manual-tistory-test.js <blogId> <jobId>
const fs=require('node:fs');const path=require('node:path');
const {app}=require('electron');
const {normalizeTistoryBlogId,TISTORY_ACCOUNT_ID}=require('../src/lib/tistoryTarget');
const blogId=normalizeTistoryBlogId(process.argv[2]);const jobId=process.argv[3];
if(!blogId || !/^job_\d+$/.test(jobId || ''))throw new Error('Blog ID와 저장된 job ID를 지정하세요.');
const draft=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../runtime/jobs',jobId,'publish-draft.json'),'utf8'));
const report=path.resolve(__dirname,'../artifacts/tistory-extension-e2e.json');
if(fs.existsSync(report) && JSON.parse(fs.readFileSync(report,'utf8')).published)throw new Error('성공한 E2E 기록이 있습니다. 자동으로 다시 발행하지 않습니다.');
process.env.BLOGAUTO_AUTOSTART='0';process.env.BLOGAUTO_SKIP_CODEX_USAGE_REFRESH='1';
let started=false;
app.on('web-contents-created',(_event,contents)=>contents.once('did-finish-load',async()=>{
 if(started)return;started=true;
 try{
  await new Promise(r=>setTimeout(r,600));
  await contents.executeJavaScript(`(async()=>{
    document.querySelector('#startupNotice').hidden=true;
    const pairing=await window.blogAuto.pairTistoryExtension(${JSON.stringify(blogId)});
    document.querySelector('#extensionGuide').hidden=false;
    document.querySelector('#pairingCode').textContent=pairing.code;
    document.querySelector('#pairingHelp').textContent='티스토리가 열린 Chrome의 BlogAuto 확장에 연결 코드를 입력하세요. 연결 후 저장 원고로 비공개 발행을 한 번 검증합니다. 추가 AI 생성은 하지 않습니다.';
  })()`);
  const {getBridge}=require('../src/lib/extensionBridge');
  while(!getBridge().snapshot(TISTORY_ACCOUNT_ID).connected)await new Promise(r=>setTimeout(r,1000));
  const {checkTistorySession,publishToTistory}=require('../src/lib/tistoryPublisher');
  const session=await checkTistorySession({tistoryBlogId:blogId,category:draft.category,interactiveLogin:true});
  if(session.status!=='valid')throw new Error(session.reason);
  const result=await publishToTistory({...draft,title:'[확장 연결 검증] '+draft.title,tistoryBlogId:blogId,publishVisibility:'private',publishScheduleMode:'now',log:console.log});
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,JSON.stringify({...result,blogId,jobId,at:new Date().toISOString()},null,2));
  console.log('TISTORY_EXTENSION_E2E_COMPLETE',JSON.stringify(result));
 }catch(error){console.error('TISTORY_EXTENSION_E2E_FAILED',error.message);}
}));
require('./dev-app');
