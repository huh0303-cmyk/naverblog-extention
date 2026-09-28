// Explicit, paid model test. Never invoked by npm test; never publishes or generates images.
const fs=require('node:fs'),path=require('node:path');
const {humanize}=require('../packages/blog-humanizer');
const {runCodexTask}=require('../src/lib/codexRunner');
const {resolveCodexCmdPath}=require('../src/lib/settings');
async function main(){
  const settings=JSON.parse(fs.readFileSync('runtime/user-settings.json','utf8'));
  const codexCmdPath=fs.existsSync(settings.codexCmdPath || '')?settings.codexCmdPath:resolveCodexCmdPath('');
  const root=path.resolve('runtime/humanizer-tests',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(root,{recursive:true});
  const saved=(job,category)=>({...JSON.parse(fs.readFileSync(path.join('runtime/jobs',job,'attempt-1/agent-result.json'),'utf8')),category});
  const cases=[
    {name:'natural-control',title:'가방 챙기기',article:'내일 쓸 물건부터 가방에 넣어 보세요. 자주 꺼내는 물건은 앞주머니에 두면 찾기 편합니다.\n\n비가 오면 우산도 챙기세요. 준비가 끝났다면 현관에 가방을 놓아두면 됩니다.'},
    {name:'stiff-policy',title:'신청 전 확인할 조건',category:'정책 안내',article:'신청 준비에 있어서 중요한 것은 신청 대상에 대한 확인이라는 점입니다. 만 40세 이상 재직자는 상담을 신청할 수 있습니다. 다만 모든 프로그램에 자동으로 참여할 수 있다는 뜻은 아닙니다.\n\n[SECTION - 준비 순서]\n1. 신청 대상 확인\n2. 접수 일정 확인\n\n확인되어진 접수 마감일은 2026년 9월 30일입니다. 신청에 필요한 서류를 준비하는 것이 필요합니다.\n\n[SECTION - 참고자료]\n참고 1: 테스트용 가상 자료\nhttps://example.org/notice?id=40'},
    {name:'saved-policy',...saved('job_1790489348575','중장년·시니어 취업지원 정보')},
    {name:'saved-travel',...saved('job_1790491079673','여행의 발견')}
  ];
  const results=[];
  console.log('Output: '+root);
  for(const sample of cases){
    const dir=path.join(root,sample.name);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'before.txt'),sample.article);
    let calls=0,usage;const start=Date.now();
    const input={article:sample.article,title:sample.title,category:sample.category};
    const complete=async prompt=>{
      calls++;
      const result=await runCodexTask({options:{jobDir:dir,codexCmdPath,codexModel:settings.codexModel,agentModels:settings.agentModels},agent:'humanizer',prompt:prompt+'\nWrite the JSON result to '+path.join(dir,'result.json')+'. Then print BLOGAUTO_RESULT_READY. Do not read other project files or use other skills.',promptFileName:'prompt.txt',resultFileName:'result.json'});
      usage=result.tokenUsage;return result;
    };
    try{
      const output=await humanize(input,{complete,cacheDir:path.join(dir,'cache')});
      const cached=await humanize(input,{complete:()=>{throw Error('Cache miss');},cacheDir:path.join(dir,'cache')});
      if(!cached.cached || cached.article!==output.article)throw Error('Cached article mismatch');
      fs.writeFileSync(path.join(dir,'after.txt'),output.article);
      fs.writeFileSync(path.join(dir,'changes.json'),JSON.stringify(output.changes,null,2));
      const record={name:sample.name,status:'success',calls,cached:cached.cached,changes:output.changes.length,ms:Date.now()-start,usage};results.push(record);console.log(JSON.stringify(record));
    }catch(e){const record={name:sample.name,status:'failed',calls,error:e.message,ms:Date.now()-start,usage};results.push(record);console.log(JSON.stringify(record));}
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2));
  }
  if(results.some(r=>r.status!=='success'))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
