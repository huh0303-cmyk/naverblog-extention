const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function inspect({text='새 제목',editor=false,listed=false,blogId='bdsmbk'}={}){
 const title={getClientRects:()=>[{}],matches:()=>false,cloneNode:()=>({textContent:text,querySelectorAll:()=>[]})};
 const document={body:{innerText:''},querySelectorAll(s){if(s.startsWith('.se-title-text'))return [title];if(s==='button[data-click-area="tpb.publish"]')return editor?[title]:[];if(s==='a[href]')return listed?[{textContent:'새 제목',href:'https://blog.naver.com/PostView.naver?blogId=bdsmbk&logNo=123'}]:[];return [];}};
 const ctx=vm.createContext({document,URL,location:{href:'https://blog.naver.com/PostView.naver?blogId=bdsmbk&logNo=123'},getComputedStyle:()=>({visibility:'visible'})});vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),ctx);
 return ctx.editorCommand('published',{title:'새 제목',blogId});
}
test('published title is valid even though viewer retains editor title classes',async()=>assert.equal((await inspect()).complete,true));
test('wrong title or account cannot confirm publication',async()=>{assert.equal((await inspect({text:'이전 글'})).complete,false);assert.equal((await inspect({blogId:'other'})).complete,false);assert.equal((await inspect({editor:true})).complete,false);});
test('stale after-write viewer may reopen only the matching published URL',async()=>{assert.equal((await inspect({text:'이전 글',listed:true})).refreshUrl,'https://blog.naver.com/PostView.naver?blogId=bdsmbk&logNo=123');assert.equal((await inspect({text:'이전 글',listed:false})).refreshUrl,undefined);});
