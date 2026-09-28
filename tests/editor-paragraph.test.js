const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function write(text,previous='',enabled=true,keepTail=false,preview=false){
 const operations=[];
 const make=value=>({value,isContentEditable:true,getClientRects:()=>[{}],getBoundingClientRect:()=>({left:0,top:0,right:500,height:30}),querySelectorAll:()=>[],dispatchEvent(){if(this.value)throw Error('must not click populated paragraph');},scrollIntoView(){},closest:()=>null,matches:()=>false,focus(){document.activeElement=this;},cloneNode(){return {textContent:this.value,querySelectorAll:()=>[]};}});
 const bodies=[make(previous)],title=make('');
 const bottom={getClientRects:()=>[{}],getBoundingClientRect:()=>({left:0,top:100,width:500,height:100}),contains:()=>false,scrollIntoView(){},dispatchEvent(e){if(e.type==='click'){bodies.push(make(''));operations.push('NEW_BODY');}}};
 const document={body:{innerText:''},activeElement:bodies[0],elementFromPoint:(_x,y)=>y>=100?bottom:bodies.at(-1),querySelectorAll(s){if(s.startsWith('.se-title-text'))return [title];if(s.startsWith('.se-section-text'))return bodies;if(s==='button.se-canvas-bottom-button')return [bottom];return [];},createRange:()=>({selectNodeContents(){},collapse(){}}),execCommand(cmd,_unused,value){operations.push(cmd==='insertText'?value:'ENTER');if(cmd==='insertText')this.activeElement.value+=value;else {bodies.push(make(''));this.activeElement=bodies.at(-1);}return true;}};
 const ctx=vm.createContext({document,window:{},innerWidth:1000,innerHeight:800,MouseEvent:class{constructor(type){this.type=type;}},getComputedStyle:()=>({visibility:'visible'}),getSelection:()=>({removeAllRanges(){},addRange(){}}),setTimeout:f=>f()});
 if(preview){const exec=document.execCommand;let consumed=false;document.execCommand=function(cmd,...args){if(cmd==='insertParagraph' && !consumed){consumed=true;operations.push('PREVIEW');return true;}return exec.call(this,cmd,...args);};}
 vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),ctx);const r=await ctx.editorCommand('paragraph',{text,breakSentences:enabled});assert.equal(r.ok,true,r.error);assert.equal(bodies.at(-1).value,'');if(!keepTail)while(operations.at(-1)==='ENTER')operations.pop();return operations;
}

for(const preview of [false,true])test(`reference URL leaves a blank separator, preview=${preview}`,async()=>{
 const result=await write('https://example.com/reference','',true,true,preview);
 assert.deepEqual(result,preview?['https://example.com/reference','PREVIEW','ENTER','ENTER']:['https://example.com/reference','ENTER','ENTER']);
});
test('numbered list markers stay with text while sentences get a blank line',async()=>{
 assert.deepEqual(await write('1. 첫 항목입니다. 다음 문장입니다!'),['1. 첫 항목입니다.','ENTER','ENTER','다음 문장입니다!']);
 assert.deepEqual(await write('2. 다음 항목입니다.'),['2. 다음 항목입니다.']);
});
test('decimals URLs and source markers stay intact',async()=>{
 assert.deepEqual(await write('비율은 3.4입니다. [참고 1] 다음 문장입니다.'),['비율은 3.4입니다. [참고 1]','ENTER','ENTER','다음 문장입니다.']);
 assert.deepEqual(await write('https://example.com/a.php'),['https://example.com/a.php']);
});
test('next input starts in a new bottom slot without clicking or splitting existing text',async()=>{
 assert.deepEqual(await write('다음 문장입니다.','이전 문장입니다. [참고 1]'),['NEW_BODY','다음 문장입니다.']);
 assert.deepEqual(await write('2. 두 번째 항목','1. 첫 항목'),['NEW_BODY','2. 두 번째 항목']);
});
test('disabled sentence formatting leaves the text unchanged',async()=>assert.deepEqual(await write('1. 첫째. 둘째.','',false),['1. 첫째. 둘째.']));
