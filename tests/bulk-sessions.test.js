const test=require('node:test');
const assert=require('node:assert/strict');
const {checkBulkSessions}=require('../src/lib/bulkSessions');
function harness(states={}) {
 const calls=[],logs=[],tasks=new Map();
 return {calls,logs,tasks,states,
  bridge:{snapshot:id=>states[id] || {connected:false},tasks},
  open:async a=>{calls.push(['open',a.id]);states[a.id]={connected:true};},
  check:async a=>{calls.push(['check',a.id,a.blogId]);return {status:'valid'};},
  log:m=>logs.push(m),sleep:async()=>{}
 };
}
test('bulk opens offline accounts, rechecks valid accounts, deduplicates shared Tistory destinations',async()=>{
 const h=harness({a:{connected:true,status:'valid'}});
 const result=await checkBulkSessions([
  {id:'a',blogId:'a',tistoryBlogId:'shared'},
  {id:'b',blogId:'b',tistoryBlogId:'shared'},
  {id:'c',blogId:'c',tistoryBlogId:'second'},
  {id:'excluded',checked:false,tistoryBlogId:'excluded'}
 ],h);
 assert.equal(result.length,5);
 assert.deepEqual(h.calls.filter(c=>c[0]==='open').map(c=>c[1]).sort(),['b','c','tistory-shared']);
 assert.deepEqual(h.calls.filter(c=>c[0]==='check' && c[1]==='tistory-shared').map(c=>c[2]),['shared','second']);
 assert.ok(h.calls.some(c=>c[0]==='check' && c[1]==='a'));
});
test('recently closed Chrome with stale heartbeat is opened if the check is not claimed',async()=>{
 const h=harness({a:{connected:true,status:'valid'}});let finish;
 h.check=async()=>{h.tasks.set('task',{accountId:'a',type:'session',state:'queued'});return new Promise(resolve=>{finish=resolve;});};
 h.open=async a=>{h.calls.push(['open',a.id]);finish({status:'valid'});};
 const result=await checkBulkSessions([{id:'a',blogId:'a'}],h);
 assert.deepEqual(h.calls,[['open','a']]);assert.equal(result[0].status,'valid');
});
test('missing extension finishes with connection guidance; active publishing is untouched',async()=>{
 const h=harness({busy:{connected:true,busy:true}});
 h.open=async a=>{h.calls.push(['open',a.id]);};
 const result=await checkBulkSessions([{id:'busy',blogId:'busy'},{id:'offline',blogId:'offline',tistoryBlogId:'one'},{id:'other',blogId:'other',tistoryBlogId:'two'}],h);
 assert.equal(result[0].status,'busy');
 assert.equal(h.calls.filter(c=>c[0]==='check').length,0);
 assert.equal(h.calls.filter(c=>c[1]==='tistory-shared').length,1);
 assert.ok(h.logs.some(m=>m.includes('확장프로그램 연결')));
});
