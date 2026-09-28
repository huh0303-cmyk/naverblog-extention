const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {ExtensionBridge}=require('../src/lib/extensionBridge');
test('transient inspection and stale poll never erase confirmed login, expiry still revokes it',async t=>{
 const {bridge,call,pair}=await fixture(t);const client=await pair('stable');
 const now=Date.now();
 await call('/status',{session:{status:'valid',checkedAt:new Date(now-1000).toISOString()}},client.token);
 await call('/status',{session:{status:'unknown',checkedAt:new Date(now).toISOString()}},client.token);
 assert.equal(bridge.snapshot('stable').loginStatus,'valid');assert.equal(bridge.snapshot('stable').rechecking,true);
 await call('/status',{session:{status:'expired',checkedAt:new Date(now-500).toISOString()}},client.token);
 assert.equal(bridge.snapshot('stable').loginStatus,'valid');
 await call('/status',{session:{status:'expired',checkedAt:new Date(now+1).toISOString()}},client.token);
 assert.equal(bridge.snapshot('stable').loginStatus,'expired');
 bridge.lastSeen.set(client.token,now-80000);assert.equal(bridge.snapshot('stable').loginStatus,'disconnected');
});
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'blogauto-bridge-'));const bridge=new ExtensionBridge(root,0);await bridge.start();t.after(()=>{bridge.stop();fs.rmSync(root,{recursive:true,force:true});});
 const call=async(route,body={},token,origin)=>{const response=await fetch(`http://127.0.0.1:${bridge.port}${route}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{}) ,...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 const pair=async(id,device=`device-000000000000000000-${id}`)=>{const code=bridge.pairCode(id,id,id).code;return call('/pair',{code,deviceId:device});};return {bridge,call,pair,root};}
test('shared Tistory login dispatches each requested blog, including concurrent checks',async t=>{
 const {bridge,call}=await fixture(t);
 const code=bridge.pairCode('tistory-shared','first-blog','공용','tistory').code;
 const client=await call('/pair',{code,deviceId:'device-000000000000000000-shared'});
 const first=bridge.request('tistory-shared','session',{tistoryBlogId:'first-blog'});
 const second=bridge.request('tistory-shared','session',{tistoryBlogId:'second-blog'});
 let {task}=await call('/poll',{},client.token);assert.equal(task.blogId,'first-blog');
 await call('/result',{id:task.id,result:{status:'valid'}},client.token);await first;
 ({task}=await call('/poll',{},client.token));assert.equal(task.blogId,'second-blog');assert.equal(task.platform,'tistory');
 await call('/result',{id:task.id,result:{status:'valid'}},client.token);await second;
});
test('account connections and results are isolated; login wait has no timeout',async t=>{const {bridge,call,pair}=await fixture(t);const a=await pair('alpha'),b=await pair('beta');assert.equal(a.status,200);
 const pending=bridge.request('alpha','session',{interactive:true});const {task}=await call('/poll',{},a.token);assert.equal(task.blogId,'alpha');assert.equal((await call('/poll',{},b.token)).task,null);
 assert.equal((await call('/result',{id:task.id,result:{status:'valid'}},b.token)).status,404);
 await call('/waiting',{id:task.id,reason:'로그인 대기'},a.token);assert.equal(bridge.snapshot('alpha').status,'waiting_login');assert.equal(bridge.waiters.get(task.id).timer,null);
 await call('/result',{id:task.id,result:{status:'valid'}},a.token);assert.equal((await pending).status,'valid');assert.equal(bridge.snapshot('alpha').status,'valid');assert.notEqual(bridge.snapshot('beta').status,'valid');
});
test('pairing code expires, is single use and does not bind two accounts to one cookie store',async t=>{const {bridge,call,pair}=await fixture(t);const device='device-000000000000000000-same';const a=await pair('alpha',device);assert.equal(a.status,200);assert.equal((await pair('beta',device)).status,409);
 const code=bridge.pairCode('gamma','gamma','gamma').code;bridge.codes.get(code).expires=0;assert.equal((await call('/pair',{code,deviceId:'device-000000000000000000-cc'})).status,403);
 assert.equal((await call('/heartbeat',{},a.token,'https://evil.example')).status,403);assert.equal((await call('/poll',{},'wrong')).status,401);
});
test('cancel prevents dispatch and rejects the waiting caller',async t=>{const {bridge,pair,call}=await fixture(t);const a=await pair('alpha');const pending=bridge.request('alpha','session');const assertion=assert.rejects(pending,{code:'JOB_CANCELLED'});bridge.cancelAccount('alpha');await assertion;assert.equal((await call('/poll',{},a.token)).task,null);});
test('restart never replays a publication; disconnected state is not expired',async t=>{const {bridge,pair,call,root}=await fixture(t);const a=await pair('alpha');const pending=bridge.request('alpha','publish',{title:'a'});const assertion=assert.rejects(pending);const {task}=await call('/poll',{},a.token);await call('/stage',{id:task.id,stage:'final_publish'},a.token);
 const restarted=new ExtensionBridge(root,0);assert.equal(restarted.tasks.get(task.id).state,'interrupted');assert.equal(restarted.snapshot('alpha').status,'disconnected');bridge.stop();await assertion;});
test('asset access is scoped to a running task and token',async t=>{const {bridge,pair,call,root}=await fixture(t);const a=await pair('alpha'),b=await pair('beta');const image=path.join(root,'test.png');fs.writeFileSync(image,Buffer.from([1,2,3]));
 const pending=bridge.request('alpha','publish',{titleImagePath:image});const assertion=assert.rejects(pending);const {task}=await call('/poll',{},a.token);assert.equal(task.payload.titleImagePath,undefined);assert.equal(task.payload.titleImageIndex,0);
 const fetchAsset=token=>fetch(`http://127.0.0.1:${bridge.port}/asset?task=${task.id}&index=0`,{headers:{Authorization:`Bearer ${token}`}});
 assert.equal((await fetchAsset(b.token)).status,403);assert.equal((await fetchAsset(a.token)).status,200);bridge.cancelAccount('alpha');await assertion;assert.equal((await fetchAsset(a.token)).status,403);
});
test('uncertain publication cannot be silently submitted again',async t=>{
 const {bridge,pair,call}=await fixture(t);const a=await pair('alpha');const payload={title:'동일 원고',article:'본문'};
 const pending=bridge.request('alpha','publish',payload);const rejected=assert.rejects(pending,{code:'PUBLISH_UNCERTAIN'});
 const {task}=await call('/poll',{},a.token);await call('/result',{id:task.id,error:'확인 필요',code:'PUBLISH_UNCERTAIN'},a.token);await rejected;
 await assert.rejects(bridge.request('alpha','publish',payload),{code:'PUBLISH_UNCERTAIN'});
});

test('job start joins an existing login wait without a second task',async t=>{
 const {bridge,pair,call}=await fixture(t);const a=await pair('alpha');
 const first=bridge.request('alpha','session',{interactive:true});
 const {task}=await call('/poll',{},a.token);
 await call('/waiting',{id:task.id,reason:'로그인 대기'},a.token);
 const joined=bridge.request('alpha','session',{interactive:false});
 assert.equal(bridge.tasks.size,1);
 await assert.rejects(bridge.request('alpha','publish',{title:'test'}),{code:'ACCOUNT_BUSY'});
 await call('/result',{id:task.id,result:{status:'valid'}},a.token);
 assert.equal((await first).status,'valid');assert.equal((await joined).status,'valid');
 assert.equal(bridge.snapshot('alpha').busy,false);
});

test('cancelling a shared login wait releases all callers and permits another check',async t=>{
 const {bridge,pair,call}=await fixture(t);const a=await pair('alpha');
 const first=bridge.request('alpha','session');const joined=bridge.request('alpha','session');
 const checks=[assert.rejects(first,{code:'JOB_CANCELLED'}),assert.rejects(joined,{code:'JOB_CANCELLED'})];
 bridge.cancelAccount('alpha');await Promise.all(checks);
 const next=bridge.request('alpha','session');const {task}=await call('/poll',{},a.token);
 await call('/result',{id:task.id,result:{status:'valid'}},a.token);
 assert.equal((await next).status,'valid');
});
