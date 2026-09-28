const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
for(const restarted of [false,true])test(`reservation verification survives worker restart=${restarted} without writing`,async()=>{
 const task={id:'verify',type:'verifyPublish',platform:'naver',blogId:'a',payload:{publishScheduleMode:'reserve',scheduledAt:'2026-09-27T08:30:00Z'}};
 const storage={connection:{},...(restarted?{activeTask:{...task,stage:'verify_publish'}}:{})};let verified=0,finished=0;
 const event={addListener(){}};
 const context=vm.createContext({importScripts(){},setTimeout,setInterval(){},clearInterval(){},
  chrome:{storage:{local:{get:async()=>storage,set:async value=>Object.assign(storage,value),remove:async()=>{}}},
   alarms:{create(){},onAlarm:event},action:{onClicked:event},tabs:{onUpdated:event},runtime:{onStartup:event,onInstalled:event,onMessage:event}}});
 vm.runInContext(fs.readFileSync('extension/background.js','utf8').replace('\npump();',''),context);
 context.api=async route=>route==='/poll'?{task}:{};
 context.verifyReservation=async()=>{assert.equal(storage.activeTask.id,'verify');verified++;return {published:true,scheduled:true};};
 context.finish=async result=>{assert.equal(result.result.scheduled,true);finished++;};
 context.publish=async()=>{throw Error('publication must never run');};context.resume=async()=>{throw Error('writer must never run');};
 await context.pump();assert.equal(verified,1);assert.equal(finished,1);
});
test('Tistory reservation verifier wraps real row evidence and closes only its temporary tab',async()=>{
 const event={addListener(){}},removed=[];
 const context=vm.createContext({importScripts(){},setTimeout:fn=>fn(),setInterval(){},clearInterval(){},
  chrome:{storage:{local:{}},alarms:{create(){},onAlarm:event},action:{onClicked:event},runtime:{onStartup:event,onInstalled:event,onMessage:event},
   tabs:{onUpdated:event,create:async spec=>{assert.equal(spec.url,'https://example.tistory.com/manage/posts/');return {id:42};},remove:async id=>removed.push(id)}}});
 vm.runInContext(fs.readFileSync('extension/background.js','utf8').replace('\npump();',''),context);
 context.tistoryRun=async(id,command,args)=>{assert.equal(command,'published');assert.equal(args.title,'원고');return {ok:true,complete:true,scheduled:true,scheduledAt:args.scheduledAt,verification:'reservation-list',managementUrl:'https://example.tistory.com/manage/posts/'};};
 const result=await context.verifyReservation({platform:'tistory',blogId:'example',payload:{title:'원고',publishScheduleMode:'reserve',scheduledAt:'2026-09-27T08:40:00.000Z'}});
 assert.equal(result.published,true);assert.equal(result.scheduled,true);assert.deepEqual(removed,[42]);
});
