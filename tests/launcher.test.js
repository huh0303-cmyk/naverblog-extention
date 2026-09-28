const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
const {launchSpec}=require('../src/lib/chromeLauncher');
test('launch uses only account data directory and exact blog URL, no automation options',()=>{
 const a=launchSpec('D:/앱 폴더',{id:'a',blogId:'my-blog'},'win32','C:/Google Chrome/chrome.exe');const b=launchSpec('D:/앱 폴더',{id:'b',blogId:'other'},'win32','C:/Google Chrome/chrome.exe');
 assert.notEqual(a.dataDir,b.dataDir);assert.deepEqual(a.args,[`--user-data-dir=${a.dataDir}`,'https://blog.naver.com/my-blog/postwrite']);
 assert.throws(()=>launchSpec('root',{id:'../evil',blogId:'x?y'},'darwin','/Applications/Google Chrome.app'));
 const c=launchSpec('root',{id:'../../evil',blogId:'safe'},'darwin','/Applications/Google Chrome.app');assert.equal(path.dirname(c.dataDir),path.join('root','account-chrome'));
});
test('extension requests neither cookie access nor debugger permission',()=>{const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../extension/manifest.json')));assert.ok(!manifest.permissions.includes('debugger'));assert.ok(!manifest.permissions.includes('cookies'));});
