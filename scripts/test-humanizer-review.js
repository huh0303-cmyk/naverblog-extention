// Explicit live final-review test using a saved humanizer test directory. No publishing.
const fs=require('node:fs'),path=require('node:path');
const {runCodexTask}=require('../src/lib/codexRunner');
const {resolveCodexCmdPath}=require('../src/lib/settings');
const {reviewPrompt}=require('../src/lib/generationPrompts');
async function main(){
 const root=path.resolve(process.argv[2] || '');
 if(!process.argv[2] || !fs.existsSync(path.join(root,'results.json')))throw Error('Provide a completed humanizer test directory');
 const settings=JSON.parse(fs.readFileSync('runtime/user-settings.json','utf8'));
 for(const [name,job] of [['saved-policy','job_1790489348575'],['saved-travel','job_1790491079673']]){
  const original=fs.readFileSync(path.join('runtime/jobs',job,'attempt-1/main-review-1.txt'),'utf8').split('\n').find(line=>line.startsWith('{"brief":'));
  const packet=JSON.parse(original),dir=path.join(root,name,'main-review-decisions');fs.mkdirSync(dir,{recursive:true});
  const writer={...packet.article,article:fs.readFileSync(path.join(root,name,'after.txt'),'utf8')};
  const prompt=reviewPrompt({...packet.brief,jobDir:dir,finalTitle:packet.selectedTitle,researchTitleResult:packet.research,searchResults:packet.sources,writerResult:writer,humanizerChanges:JSON.parse(fs.readFileSync(path.join(root,name,'changes.json'),'utf8'))});
  const result=await runCodexTask({options:{jobDir:dir,codexCmdPath:resolveCodexCmdPath(settings.codexCmdPath),codexModel:settings.codexModel,agentModels:settings.agentModels},agent:'main',prompt,promptFileName:'prompt.txt',resultFileName:'main-review-result.json'});
  const changes=JSON.parse(fs.readFileSync(path.join(root,name,'changes.json'),'utf8'));
  const applied=require('../packages/blog-humanizer').applyReview(writer.article,changes,result.humanizerDecisions);
  fs.writeFileSync(path.join(dir,'reviewed.txt'),applied.article);
  fs.writeFileSync(path.join(dir,'restored-ids.json'),JSON.stringify(applied.restoredIds));
  console.log(JSON.stringify({name,status:result.status,reason:result.failureReason,issues:result.issues,revisionInstructions:result.revisionInstructions}));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
