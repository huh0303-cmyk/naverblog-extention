const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function scenario(initial,target,{disabledDay=false,disabledMove=false}={}){
 const shown={getClientRects:()=>[{}]};let current=new Date(initial),open=false,moves=0,selected=0;
 const format=d=>`${d.getFullYear()}. ${String(d.getMonth()+1).padStart(2,'0')}. ${String(d.getDate()).padStart(2,'0')}`;
 let value=format(current);
 const field={...shown,type:'text',readOnly:true,click(){open=true;},get value(){return value;},set value(_){assert.fail('readOnly date must never be set directly');}};
 const select=values=>({...shown,value:'',options:values.map(v=>({value:String(v),textContent:String(v)})),matches:()=>true,dispatchEvent(){}});
 const hour=select(Array.from({length:24},(_,i)=>i)),minute=select([0,10,20,30,40,50]);
 const calendar={...shown,querySelector(selector){
  if(selector==='.ui-datepicker-year')return {textContent:String(current.getFullYear())};
  if(selector==='.ui-datepicker-month')return {textContent:`${current.getMonth()+1}월`};
  return {disabled:false,classList:{contains:()=>disabledMove},click(){moves++;current=new Date(current.getFullYear(),current.getMonth()+(selector==='.ui-datepicker-next'?1:-1),1);}};
 },querySelectorAll(){return Array.from({length:new Date(current.getFullYear(),current.getMonth()+1,0).getDate()},(_,i)=>({textContent:String(i+1),disabled:false,closest:()=>disabledDay?{}:null,click(){selected++;value=format(new Date(current.getFullYear(),current.getMonth(),i+1));open=false;}}));}};
 const radio={checked:false};const label={...shown,textContent:'전체공개',click(){radio.checked=true;},querySelector:()=>radio};
 const reserve={...shown,textContent:'예약',click(){}};
 const document={body:{innerText:''},querySelectorAll(selector){
  if(selector.startsWith('.se-title-text'))return [{...shown}];
  if(selector==='button,label,[role="button"],a')return [label,reserve];
  if(selector.startsWith('input[class*="input_date"'))return [field];
  if(selector.startsWith('select[class*="hour"'))return [hour];
  if(selector.startsWith('select[class*="minute"'))return [minute];
  if(selector==='.ui-datepicker')return open?[calendar]:[];
  return [];
 }};
 const ctx=vm.createContext({document,Event:class{},getComputedStyle:()=>({visibility:'visible'}),setTimeout:f=>f()});
 vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),ctx);
 const result=await ctx.editorCommand('settings',{publishVisibility:'public',publishScheduleMode:'reserve',scheduledAt:target.toISOString()});
 return {result,value,moves,selected,hour:hour.value,minute:minute.value};
}
for(const [name,initial,target,expectedMoves] of [
 ['next day',new Date(2026,8,27),new Date(2026,8,28,0,6),0],
 ['month rollover',new Date(2026,8,30),new Date(2026,9,1,0,6),1],
 ['year rollover',new Date(2026,11,31),new Date(2027,0,1,0,6),1]
])test(`readOnly calendar selects ${name} through date controls`,async()=>{
 const actual=await scenario(initial,target);assert.equal(actual.result.ok,true,actual.result.error);assert.equal(actual.moves,expectedMoves);assert.equal(actual.selected,1);assert.equal(actual.hour,'0');assert.equal(actual.minute,'10');
});
test('disabled date and disabled month navigation fail before time input',async()=>{
 for(const options of [{disabledDay:true},{disabledMove:true}]){
  const actual=await scenario(new Date(2026,8,30),new Date(2026,9,1,0,6),options);
  assert.equal(actual.result.ok,false);assert.match(actual.result.error,/reserve-date.*예약 달력/);assert.equal(actual.selected,0);assert.equal(actual.hour,'');
 }
});
