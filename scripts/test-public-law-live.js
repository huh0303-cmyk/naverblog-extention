// Explicit paid, isolated text-only test. Never loads main.js, bridge or publishers.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {runCodexGeneration}=require('../src/lib/codexRunner');
const {readSettings,resolveCodexCmdPath}=require('../src/lib/settings');
const {retrieveResearch}=require('../src/lib/researchRetrieval');
const {createRetrievalContext}=require('../src/lib/search');
async function main(){
 const root=path.resolve('runtime/isolated-tests','public-law-'+new Date().toISOString().replace(/[:.]/g,'-'));
 fs.mkdirSync(root,{recursive:true});console.log('TEST_DIR='+root);
 const settings=readSettings(path.resolve('runtime'));
 const log=(message,level='info',agent='main')=>{const record={at:new Date().toISOString(),agent,level,message};fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify(record)+'\n');console.log(`[${agent}] ${message}`);};
 const context=createRetrievalContext();
 const options={jobDir:root,runtimeRoot:root,codexCmdPath:resolveCodexCmdPath(settings.codexCmdPath),codexModel:settings.codexModel,agentModels:settings.agentModels,
  topicMode:'test',topic:'행정처분 사전통지·의견제출·청문의 차이와 통지서를 받았을 때 확인할 사항',category:'공법 기초',keyword:'행정절차법 사전통지, 의견제출, 청문',
  publishPurpose:'행정처분 통지서를 처음 받은 일반 독자가 사전통지와 처분 통지를 구별하고, 의견제출과 청문이 언제 적용되는지 이해하도록 돕는다.',
  preferredTone:'알기 쉬운 자연스러운 블로그 설명. 조사·검증 과정을 보고하지 않고 구체적인 질문에 답한다.',currentDateLabel:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}),
  searchChannel:'blog',trustBlogAsSource:false,includeTitleImage:false,maxBodyImages:0,searchResults:process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):[],
  generationCheckpoint:process.argv[3]?JSON.parse(fs.readFileSync(process.argv[3],'utf8')):undefined,
  onGenerationCheckpoint:c=>fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify(c,null,2)),
  onArticleReady:d=>fs.writeFileSync(path.join(root,'preview-'+d.previewStage+'.txt'),d.article || ''),
  onSearchNeeded:async(research,step)=>{
   const sources=await retrieveResearch({topic:research.finalTitle || options.topic,keyword:options.keyword,category:options.category,publishPurpose:options.publishPurpose,searchChannel:'blog',trustBlogAsSource:false,searchNeed:research.searchNeed,searchQueries:research.searchQueries,verificationQueries:research.verificationQueries,evidenceRequests:research.evidenceRequests,primaryProvider:'naver',fallbackProvider:'google',currentDate:options.currentDateLabel},log,{context});
   const merged=new Map([...(step.previousSearchResults || []),...sources].map(s=>[s.url,s]));
   const searchResults=[...merged.values()].slice(0,20).map(s=>({...s,sourceId:'src-'+crypto.createHash('sha256').update(s.url || s.fetchedUrl).digest('hex').slice(0,16)}));fs.writeFileSync(path.join(root,`sources-${step.round}.json`),JSON.stringify(searchResults,null,2));
   fs.writeFileSync(path.join(root,'retrieval-audit.json'),JSON.stringify(context.events,null,2));return {searchResults};
  }
 };
 fs.writeFileSync(path.join(root,'test-config.json'),JSON.stringify({topic:options.topic,trustBlogAsSource:false,includeTitleImage:false,maxBodyImages:0,publishing:false,suppliedEvidence:process.argv[2] || ''},null,2));
 const result=await runCodexGeneration(options,log);
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));
 if(result.article)fs.writeFileSync(path.join(root,'article.md'),'# '+result.title+'\n\n'+result.article);
 console.log(JSON.stringify({status:result.status,phase:result.failurePhase,reason:result.failureReason,title:result.title,articleCharacters:result.article?.length,tokenUsage:result.tokenUsage,root}));
 if(result.status!=='success')process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
