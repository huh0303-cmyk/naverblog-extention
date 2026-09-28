// Explicit live regression of the existing draft only; no generation pipeline or publisher.
const fs=require('node:fs'),path=require('node:path');
const {runCodexTask}=require('../src/lib/codexRunner');
const {reviewPrompt}=require('../src/lib/generationPrompts');
const {readSettings,resolveCodexCmdPath}=require('../src/lib/settings');
(async()=>{
 const from=path.resolve(process.argv[2]);
 const saved=JSON.parse(fs.readFileSync(path.join(from,'result.json')));
 const checkpoint=JSON.parse(fs.readFileSync(path.join(from,'checkpoint.json')));
 const settings=readSettings(path.resolve('runtime'));
 const jobDir=path.join(from,'review-regression');fs.mkdirSync(jobDir,{recursive:true});
 const options={...checkpoint.generationOptions,jobDir,codexCmdPath:resolveCodexCmdPath(settings.codexCmdPath),codexModel:settings.codexModel,agentModels:settings.agentModels,researchTitleResult:saved.researchTitleResult,writerResult:saved,finalTitle:saved.title};
 const result=await runCodexTask({options,agent:'main',prompt:reviewPrompt(options),promptFileName:'review-prompt.txt',resultFileName:'review-result.json',log:()=>{}});
 fs.writeFileSync(path.join(jobDir,'result-with-usage.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({status:result.status,issues:result.issues,legalRelations:result.legalRelations,tokenUsage:result.tokenUsage}));
})().catch(e=>{console.error(e);process.exitCode=1;});
