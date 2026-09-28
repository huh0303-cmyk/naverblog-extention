const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('hidden bottom slot: wrapped display click cannot split the final word from the input buffer',async()=>{
 const original='긴 문장 끝에서도 별도로 신청하면 됩니다.';let focused=0,caret=0,collapsed=0;
 const make=value=>({value,isContentEditable:false,tagName:'P',getClientRects:()=>[{}],getBoundingClientRect:()=>({left:0,top:0,right:500,height:30}),querySelectorAll:()=>[],scrollIntoView(){},matches:()=>false,closest:()=>null,cloneNode(){return {textContent:this.value,querySelectorAll:()=>[]};},dispatchEvent(e){if(e.type==='mousedown'){focused=paragraphs.indexOf(this);caret=Math.max(0,this.value.length-4);document.activeElement=frame;}}});
 const paragraphs=[make('')],title=make('제목');
 const input={tagName:'DIV',isContentEditable:true,matches:()=>false,focus(){},cloneNode:()=>({textContent:paragraphs[focused].value,querySelectorAll:()=>[]}),dispatchEvent(e){if(e.type==='keydown'&&e.key==='Enter'){const p=paragraphs[focused],tail=p.value.slice(caret);p.value=p.value.slice(0,caret);paragraphs.push(make(tail));focused++;caret=0;}}};
 const inner={activeElement:input,defaultView:{Event:class{},KeyboardEvent:class{constructor(type,args){this.type=type;Object.assign(this,args);}}},createRange:()=>({selectNodeContents(){},collapse(end){assert.equal(end,false);collapsed++;caret=paragraphs[focused].value.length;}}),getSelection:()=>({removeAllRanges(){},addRange(){}}),dispatchEvent(){},execCommand(cmd,_ui,value){assert.equal(cmd,'insertText');paragraphs[focused].value+=value;caret=paragraphs[focused].value.length;return true;}};
 const frame={tagName:'IFRAME',contentDocument:inner};
 const component={getClientRects:()=>[{}],closest:()=>null,contains:e=>paragraphs.includes(e),matches:()=>true};
 const document={activeElement:frame,body:{innerText:''},elementFromPoint:()=>paragraphs.at(-1),querySelectorAll(s){if(s.startsWith('.se-title-text'))return [title];if(s.startsWith('.se-section-text'))return paragraphs;if(s==='.se-component')return [component];return [];}};
 const ctx=vm.createContext({document,window:{},innerWidth:1000,innerHeight:800,MouseEvent:class{constructor(type,args){this.type=type;Object.assign(this,args);}},getComputedStyle:()=>({visibility:'visible'}),setTimeout:f=>f()});
 vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),ctx);
 const first=await ctx.editorCommand('paragraph',{text:original,breakSentences:true});assert.equal(first.ok,true,first.error);const result=await ctx.editorCommand('paragraph',{text:'다음 문장입니다.',breakSentences:true});
 assert.equal(result.ok,true,result.error);assert.equal(collapsed,0);assert.deepEqual(paragraphs.map(p=>p.value).filter(Boolean),[original,'다음 문장입니다.']);assert.equal(paragraphs.at(-1).value,'');
});
