const test=require('node:test');const assert=require('node:assert/strict');
const { _private:checks,fetchCodexUsageSnapshot }=require('../src/lib/codexRunner');
test('real writer validation allows useful short text without tags',()=>{
 assert.equal(checks.writerOutputIssueReason({status:'success',article:'간결한 설명',tags:[]}),'');
 assert.notEqual(checks.writerOutputIssueReason({status:'success',article:''}),'');
});
test('image placement is structural, not forced after every heading',()=>{
 const options={includeTitleImage:false,maxBodyImages:10};
 const result={article:'[SECTION - 개요]\n내용\n[IMAGE INSERT - 1]\n[SECTION - 결론]\n끝',bodyImages:[{sequence:1,prompt:'설명'}]};
 assert.equal(checks.writerImageContractIssueReason(result,options),'');
 assert.notEqual(checks.writerImageContractIssueReason({...result,article:result.article+'\n[IMAGE INSERT - 1]'},options),'');
});
test('PASS cannot override missing factual review',()=>{
 assert.notEqual(checks.mainReviewPassIssueReason({status:'PASS',publishable:true}),'');
 assert.equal(checks.mainReviewPassIssueReason({status:'PASS',articleAnswersTitle:true,topicPreserved:true,factualityPass:true,sourceUsePass:true,riskExpressionPass:true,publishable:true}),'');
});
test('usage display never consumes generation tokens',async()=>{
 const snapshot=await fetchCodexUsageSnapshot({codexCmdPath:'nonexistent-executable'});
 assert.notEqual(snapshot.source,'codex-exec');
});
