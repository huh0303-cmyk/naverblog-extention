// Isolated runtime: verify a second launch exits before accessing shared data.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../.test-runtime',`instance-${Date.now()}`);
process.env.BLOGAUTO_RUNTIME_ROOT=root;
process.env.BLOGAUTO_USER_DATA=path.join(root,'app-data');
process.env.BLOGAUTO_SKIP_CODEX_USAGE_REFRESH='1';
process.env.BLOGAUTO_TEST_BRIDGE_PORT='0';
let signalled=false;
app.on('second-instance',()=>{signalled=true;});
app.on('web-contents-created',(_event,contents)=>{
  contents.once('did-finish-load',()=>{
    const child=spawn(process.execPath,[path.resolve(__dirname,'../src/main.js')],{env:process.env,windowsHide:true});
    let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});
    child.stderr.on('data',chunk=>{output+=chunk;});
    child.on('error',error=>{console.error(error);app.exit(1);});
    child.on('exit',code=>{
      try{
        assert.equal(code,0,output);
        assert.equal(signalled,true);
        assert.equal(BrowserWindow.getAllWindows().length,1);
        assert.ok(output.includes('이미 실행 중인 앱'));
        assert.ok(!/Unable to.*cache|Cache Creation failed/i.test(output),output);
        console.log('Single instance passed: second launch exits cleanly, existing window retained.');
        app.exit(0);
      }catch(error){console.error(error);app.exit(1);}
    });
  });
});
setTimeout(()=>{console.error('Single instance timeout');app.exit(1);},20000).unref();
require('../src/main');
