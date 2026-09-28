const test=require('node:test'),assert=require('node:assert/strict');
const {createRetryTask}=require('../src/lib/modelRetry');
test('model recovery preserves prompt and waits for choice; changed model persists',async()=>{
  const calls=[];let choose;
  const run=createRetryTask(async args=>{calls.push(args);if(calls.length===1)throw Object.assign(new Error('at capacity'),{code:'CODEX_EXEC_FAILED'});return 'ok';},
    {codexModel:'first',onModelError:()=>new Promise(r=>choose=r)},()=>{});
  const pending=run({prompt:'existing evidence',options:{jobDir:'existing'}});
  await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);
  choose({action:'retry',model:'second'});assert.equal(await pending,'ok');
  await run({prompt:'next step',options:{}});
  assert.equal(calls[1].prompt,'existing evidence');assert.equal(calls[1].options.jobDir,'existing');
  assert.equal(calls[2].options.codexModel,'second');
});
test('same model retry and cancellation do not start new research',async()=>{
  let calls=0;
  const run=createRetryTask(async args=>{if(++calls===1)throw Object.assign(new Error('capacity'),{code:'CODEX_EXEC_FAILED'});return args.options.codexModel;},
    {codexModel:'same',onModelError:async()=>({action:'retry'})},()=>{});
  assert.equal(await run({options:{}}),'same');assert.equal(calls,2);
  const cancel=createRetryTask(async()=>{throw Object.assign(new Error('capacity'),{code:'CODEX_EXEC_FAILED'});},
    {onModelError:async()=>({action:'cancel'})},()=>{});
  await assert.rejects(cancel({options:{}}),{code:'MODEL_RETRY_CANCELLED'});
});
test('non-model failure is not repeatedly retried',async()=>{
  const run=createRetryTask(async()=>{throw new Error('disk error');},{onModelError:()=>assert.fail('unexpected dialog')},()=>{});
  await assert.rejects(run({options:{}}),/disk error/);
});
