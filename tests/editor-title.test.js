const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function editor(initial='',swap=true,hitMode='normal'){
 let inserts=0,focused=false,current;
 const root={focus(){focused=true;}};
 const make=text=>({textContent:text,isContentEditable:true,isConnected:true,getBoundingClientRect:()=>({left:10,top:10,height:30}),dispatchEvent(){},getClientRects:()=>[{}],matches:()=>false,closest:()=>root,focus(){},click(){},scrollIntoView(){},cloneNode(){return {textContent:this.textContent,querySelectorAll:()=>[]};}});
 current=make(initial);
 const document={visibilityState:'hidden',elementFromPoint:x=>hitMode==='blocked'||(hitMode==='partial'&&x<30)?{tagName:'DIV',className:'popup'}:current,body:{innerText:''},querySelectorAll:selector=>selector.startsWith('.se-title-text')?[current]:[],createRange:()=>({selectNodeContents(){},collapse(){}}),execCommand(_cmd,_ui,value){inserts++;if(swap==='throw')throw new Error('DOM input denied');if(swap){current.isConnected=false;current=make(value);}return true;}};
 const ctx=vm.createContext({window:{},innerWidth:1000,innerHeight:800,MouseEvent:class{constructor(type,opts){this.type=type;Object.assign(this,opts);}},document,getComputedStyle:()=>({visibility:'visible'}),getSelection:()=>({removeAllRanges(){},addRange(){}}),setTimeout:fn=>{fn();},location:{href:'https://blog.naver.com/x/postwrite'}});
 vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),ctx);
 return {run:()=>ctx.editorCommand('title',{text:'새 제목'}),inserts:()=>inserts,focused:()=>focused};
}
test('title verification follows replacement node and focuses editable ancestor',async()=>{const e=editor();assert.equal((await e.run()).ok,true);assert.equal(e.inserts(),1);assert.equal(e.focused(),true);});
test('background document and an obstructed first coordinate do not reject a reachable title',async()=>{const e=editor('',true,'partial');assert.equal((await e.run()).ok,true);assert.equal(e.inserts(),1);});
test('actual page overlay blocks input and identifies the page element',async()=>{const e=editor('',true,'blocked');assert.match((await e.run()).error,/페이지 내부.*DIV popup/);assert.equal(e.inserts(),0);});
test('same title is idempotent while different existing title is preserved',async()=>{const e=editor('새 제목');assert.equal((await e.run()).alreadyApplied,true);assert.equal(e.inserts(),0);assert.match((await editor('사용자 제목').run()).error,/덮어쓰지/);});
test('uncommitted input returns actionable failure without repeatedly appending text',async()=>{const e=editor('',false);const r=await e.run();assert.equal(r.ok,false);assert.match(r.error,/비어 있습니다/);assert.equal(e.inserts(),1);});

test('page exceptions return exact failing step instead of an empty injection result',async()=>{const e=editor('','throw');const r=await e.run();assert.equal(r.ok,false);assert.match(r.error,/insert-title.*DOM input denied/);assert.match(r.diagnostics.build,/^\d{8}\.\d+$/);});

test('SmartEditor iframe receiver gets the command without moving caret to display paragraph',async()=>{
 let text='',outerCalls=0,innerCalls=0,rangeCalls=0,selected=true;const events=[];
 const input={tagName:'DIV',isContentEditable:true,focus(){},matches:()=>false};
 const inner={activeElement:input,execCommand(cmd,_ui,value){assert.equal(cmd,'insertText');innerCalls++;text=value;return true;}};
 const title={tagName:'P',isContentEditable:false,getBoundingClientRect:()=>({left:10,top:10,height:30}),dispatchEvent(e){events.push(e.type);assert.ok(e.clientX>0 && e.clientY>0);if(e.type==='mousedown')document.activeElement={tagName:'IFRAME',contentDocument:inner};},getClientRects:()=>[{}],matches:()=>false,scrollIntoView(){},click(){throw new Error('click alone does not select the title model');},cloneNode:()=>({textContent:text,querySelectorAll:()=>[]})};
 const document={elementFromPoint:()=>title,activeElement:null,body:{innerText:''},querySelectorAll:s=>s.startsWith('.se-title-text')?[title]:[],createRange(){rangeCalls++;throw Error('display paragraph must not get caret');},execCommand(){outerCalls++;return false;}};
 title.closest=()=>({classList:{contains:()=>selected}});
 const ctx=vm.createContext({window:{},innerWidth:1000,innerHeight:800,MouseEvent:class{constructor(type,opts){this.type=type;Object.assign(this,opts);}},document,getComputedStyle:()=>({visibility:'visible'}),setTimeout:fn=>fn()});vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),ctx);
 const result=await ctx.editorCommand('title',{text:'프레임 제목'});
 assert.equal(result.ok,true);assert.equal(innerCalls,1);assert.equal(outerCalls,0);assert.equal(rangeCalls,0);assert.deepEqual(events,['mousedown','mouseup','click']);
 text='';selected=false;
 const blocked=await ctx.editorCommand('title',{text:'본문에 들어가면 안 됨'});
 assert.equal(blocked.ok,false);assert.match(blocked.error,/제목을 입력 대상으로 선택하지/);assert.equal(innerCalls,1);
 const preflight=await ctx.editorCommand('preflightTitle');assert.equal(preflight.ok,false);assert.equal(innerCalls,1);
 selected=true;assert.equal((await ctx.editorCommand('preflightTitle')).ok,true);assert.equal(innerCalls,1,'preflight must never type');
});
