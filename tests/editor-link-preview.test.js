const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function snapshot(url,kind='se-oglink',display=''){
 const title={matches:()=>false,cloneNode:()=>({textContent:'제목',querySelectorAll:()=>[]}),getClientRects:()=>[{}]};
 const card={id:'card',className:`se-component ${kind}`,matches:s=>s==='.'+kind,querySelectorAll:()=>url?[{getAttribute:()=>url}]:[],querySelector:()=>display?{matches:()=>false,cloneNode:()=>({textContent:display,querySelectorAll:()=>[]})}:null};
 const ctx=vm.createContext({document:{body:{innerText:''},querySelectorAll:s=>s.startsWith('.se-title-text')?[title]:s==='.se-component'?[card]:[]},getComputedStyle:()=>({visibility:'visible'}),setTimeout,URL});
 vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),ctx);
 return ctx.editorCommand('snapshot');
}
test('snapshot reads auto preview URL independently of its title and thumbnail',async()=>{
 const result=await snapshot('https://www.moel.go.kr/policy?id=223');
 assert.equal(result.ok,true);assert.equal(result.blocks[0].type,'linkPreview');assert.equal(result.blocks[0].url,'https://www.moel.go.kr/policy?id=223');
});
test('unreadable previews and unknown component types give specific diagnostics',async()=>{
 assert.match((await snapshot('')).error,/표시 주소/);
 assert.match((await snapshot('','se-video')).error,/se-video/);
});
test('actual editor card with div domain label and no anchor is recognized',async()=>{
 const result=await snapshot('','se-oglink','www.moel.go.kr');
 assert.equal(result.ok,true);assert.equal(result.blocks[0].url,'');assert.equal(result.blocks[0].displayUrl,'www.moel.go.kr');
});
