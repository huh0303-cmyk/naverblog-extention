const test=require('node:test'),assert=require('node:assert/strict');
const {matchingWriterPrefix,runWriter}=require('../extension/writer');
const steps=[{type:'title',text:'제목'},{type:'quote',text:'제목',style:'default'},{type:'paragraph',text:'첫 문장.'},{type:'paragraph',text:'둘째 문장.'},{type:'image',name:'img.png'}];
function fixture(count=0){const state={title:count?'제목':'',blocks:steps.slice(1,count).map((s,i)=>({...s,id:'c'+i}))};let calls=0;return {state,get calls(){return calls;},read:async()=>JSON.parse(JSON.stringify(state)),apply:async s=>{calls++;if(s.type==='title')state.title=s.text;else state.blocks.push({...s,id:'c'+state.blocks.length});},save:async()=>{},checkCancelled:async()=>{}};}
test('resume skips completed operations and preserves existing document',async()=>{const f=fixture(3);assert.equal((await runWriter({...f,steps})).complete,true);assert.equal(f.calls,2);assert.equal(matchingWriterPrefix(f.state,steps),5);});
test('lost response after successful mutation does not duplicate text',async()=>{const f=fixture();const apply=f.apply;let interrupted=false;await runWriter({...f,steps,apply:async s=>{await apply(s);if(!interrupted){interrupted=true;throw Error('response lost');}}});assert.equal(f.calls,5);});
test('partial insertion stops without retry or overwriting',async()=>{const f=fixture(2);let calls=0;await assert.rejects(runWriter({...f,steps,apply:async()=>{calls++;f.state.blocks.push({type:'paragraph',text:'첫',id:'bad'});}}));assert.equal(calls,1);assert.equal(f.state.blocks.at(-1).text,'첫');});
test('wrong image or extra user text cannot pass prefix matching',()=>{const f=fixture(5);f.state.blocks.at(-1).name='different.png';assert.equal(matchingWriterPrefix(f.state,steps),-1);f.state.blocks.pop();f.state.blocks.push({type:'paragraph',text:'사용자 추가'});assert.equal(matchingWriterPrefix(f.state,steps),-1);});
test('text nodes merged by editor still match exact operation boundary',()=>{assert.equal(matchingWriterPrefix({title:'제목',blocks:[steps[1],{type:'paragraph',text:'첫 문장.\n둘째 문장.'}]},steps),4);});
test('no-op recovery is bounded and does not loop forever',async()=>{const f=fixture();let count=0;await assert.rejects(runWriter({...f,steps,apply:async()=>{count++;}}));assert.equal(count,2);});

test('automatic URL preview preserves prefix and continues after the card',async()=>{
 const plan=[{type:'title',text:'제목'},{type:'paragraph',text:'참고 1\nhttps://www.moel.go.kr/policy?id=223'},{type:'paragraph',text:'다음 참고자료'}];
 const card={id:'preview',type:'linkPreview',url:'https://www.moel.go.kr/policy?id=223'};
 const state={title:'제목',blocks:[{...plan[1],id:'source'},card]};
 assert.equal(matchingWriterPrefix(state,plan),2);
 await runWriter({steps:plan,read:async()=>structuredClone(state),apply:async(step,args)=>{assert.equal(args.anchorId,'preview');state.blocks.push({...step,id:'next'});},save:async()=>{},checkCancelled:async()=>{}});
 assert.equal(matchingWriterPrefix(state,plan),3);
});
test('unrelated preview or deleted URL cannot be silently accepted',()=>{
 const plan=[{type:'title',text:'제목'},{type:'paragraph',text:'https://example.com/source'}];
 assert.equal(matchingWriterPrefix({title:'제목',blocks:[plan[1],{type:'linkPreview',url:'https://other.com'}]},plan),-1);
 assert.equal(matchingWriterPrefix({title:'제목',blocks:[{type:'linkPreview',url:'https://example.com/source'}]},plan),-1);
});
test('edit-mode domain-only previews match adjacent source without inventing a URL',()=>{
 const plan=[{type:'title',text:'제목'},{type:'paragraph',text:'https://www.moel.go.kr/policy?id=223'}];
 const state={title:'제목',blocks:[plan[1],{type:'linkPreview',url:'',displayUrl:'www.moel.go.kr'}]};
 assert.equal(matchingWriterPrefix(state,plan),2);
 state.blocks[1].displayUrl='www.moel.go.kr.fake.example';assert.equal(matchingWriterPrefix(state,plan),-1);
 state.blocks[1].displayUrl='www.moel.go.kr/wrong-path';assert.equal(matchingWriterPrefix(state,plan),-1);
 state.blocks[1].displayUrl='';assert.equal(matchingWriterPrefix(state,plan),-1);
});
