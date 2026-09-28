const test=require('node:test'),assert=require('node:assert/strict');
const {responsePrompt,isTextStage}=require('../src/lib/textTaskOutput');
const prompts=require('../src/lib/generationPrompts');
test('text output uses final JSON without model file writing and preserves schemas',()=>{
 for(const make of [prompts.researchPrompt,prompts.writerPrompt,prompts.reviewPrompt]){
  const p=responsePrompt(make({jobDir:'example',maxBodyImages:0}));
  assert.doesNotMatch(p,/Output JSON file:|BLOGAUTO_RESULT_READY/);
  assert.match(p,/JSON schema:/);assert.match(p,/do not use tools/);
 }
 assert.equal(isTextStage('image'),false);assert.equal(isTextStage('imageStyle'),false);
});
test('review handoff excludes writer usage telemetry',()=>{
 const p=prompts.reviewPrompt({jobDir:'example',writerResult:{article:'본문 보존',citations:[],tokenUsage:{inputTokens:987654321},notes:['telemetry marker']}});
 assert.match(p,/본문 보존/);assert.doesNotMatch(p,/987654321|telemetry marker|inputTokens/);
});
