const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {resolveCodexCmdPath}=require('../src/lib/settings');
test('desktop update recovers stale managed CLI path without replacing custom commands',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-path-'));const previous=process.env.LOCALAPPDATA;
 try{
  process.env.LOCALAPPDATA=dir;
  const root=path.join(dir,'OpenAI','Codex','bin');const current=path.join(root,'new','codex.exe');
  fs.mkdirSync(path.dirname(current),{recursive:true});fs.writeFileSync(current,'test placeholder, never executed');
  assert.equal(resolveCodexCmdPath(path.join(root,'old','codex.exe')),current);
  const custom=path.join(dir,'custom','codex.exe');assert.equal(resolveCodexCmdPath(custom),custom);
  assert.equal(resolveCodexCmdPath(current),current);
 }finally{if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;fs.rmSync(dir,{recursive:true,force:true});}
});
