const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {naverScheduledAt}=require('../src/lib/naverPublisher');
test('Naver reservation rounds up to ten minutes including midnight and seconds',()=>{
 assert.equal(naverScheduledAt(3,Date.parse('2026-09-27T14:06:46+09:00')),'2026-09-27T08:10:00.000Z');
 assert.equal(naverScheduledAt(3,Date.parse('2026-09-27T20:56:00+09:00')),'2026-09-27T15:00:00.000Z');
 assert.equal(naverScheduledAt(3,Date.parse('2026-09-27T14:10:00+09:00')),'2026-09-27T08:10:00.000Z');
 assert.equal(naverScheduledAt(3,Date.parse('2026-09-27T14:10:01+09:00')),'2026-09-27T08:20:00.000Z');
});
for(const [missingMinute,wrongDate] of [[false,false],[true,false],[false,true]])test(`reservation verifies formatted dates and time: missingMinute=${missingMinute}, wrongDate=${wrongDate}`,async()=>{
 const shown={getClientRects:()=>[{}]};
 const field={...shown,type:'text',value:'2026. 09. 27',matches:()=>false,dispatchEvent(){this.value=wrongDate?'2026. 09. 28':'2026. 09. 27';}};
 const select=values=>({...shown,value:'',options:values.map(value=>({value,textContent:value})),matches:()=>true,dispatchEvent(){}});
 const hour=select(Array.from({length:24},(_,i)=>String(i)));
 const minute=select(missingMinute?['0']:['0','10','20','30','40','50']);
 const radio={checked:false};
 const label={...shown,textContent:'전체공개',click(){radio.checked=true;},querySelector:()=>radio};
 const reserve={...shown,textContent:'예약',click(){}};
 const document={body:{innerText:''},querySelectorAll(selector){
  if(selector.startsWith('.se-title-text'))return [{...shown}];
  if(selector==='button,label,[role="button"],a')return [label,reserve];
  if(selector.startsWith('input[class*="input_date"'))return [field];
  if(selector.startsWith('select[class*="hour"'))return [hour];
  if(selector.startsWith('select[class*="minute"'))return [minute];
  return [];
 }};
 class Input{};Object.defineProperty(Input.prototype,'value',{set(value){this.value=value;}});
 const context=vm.createContext({document,HTMLInputElement:Input,Event:class{},getComputedStyle:()=>({visibility:'visible'}),setTimeout:f=>f()});
 vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),context);
 const scheduled=new Date(2026,8,27,17,6,46);
 const result=await context.editorCommand('settings',{publishVisibility:'public',publishScheduleMode:'reserve',scheduledAt:scheduled.toISOString()});
 if(missingMinute){assert.equal(result.ok,false);assert.match(result.error,/reserve-minute.*예약 분.*10.*선택 가능: 0/);}
 else if(wrongDate){assert.equal(result.ok,false);assert.match(result.error,/reserve-verify.*실제: 2026\. 09\. 28/);}
 else{assert.equal(result.ok,true,result.error);assert.equal(hour.value,'17');assert.equal(minute.value,'10');assert.equal(field.value,'2026. 09. 27');}
});
for(const scenario of ['parent','child','deep','duplicate','wrong-id','partial'])test(`category selection: ${scenario}`,async()=>{
 const shown={getClientRects:()=>[{}]};let expanded=false,labelClicks=0,selectedItem=null;
 const name='소상공인 지원 정보';
 const item=(id,text,depth)=>({getAttribute:()=>id,cloneNode(){
   let hints=Array.from({length:depth},()=>true);
   return {get textContent(){return hints.filter(Boolean).map(()=>'하위 카테고리').join('')+text;},querySelectorAll(){return hints.map((_,i)=>({remove(){hints[i]=false;}}));}};
 }});
 const depth=scenario==='parent'?0:scenario==='deep'?8:1;
 const target=item('categoryItemText_8',scenario==='partial'?name+' 추가':name,depth);
 const label={...shown,textContent:'하위 카테고리'+name,querySelector:()=>target,scrollIntoView(){},click(){labelClicks++;selectedItem=scenario==='wrong-id'?item('categoryItemText_99',name,depth):target;expanded=false;}};
 const labels=scenario==='duplicate'?[label,{...label}]:[label];
 // Descendant traversal includes labels below any number of list/container levels.
 let tree={labels};for(let n=0;n<depth;n++)tree={children:[tree]};
 const walk=node=>[...(node.labels||[]),...(node.children||[]).flatMap(walk)];
 const menu={querySelectorAll:()=>walk(tree)};
 const button=()=>({...shown,getAttribute:()=>String(expanded),click(){expanded=true;},parentElement:{querySelector:()=>menu},querySelector:()=>selectedItem});
 const privateRadio={checked:false};const privateLabel={...shown,textContent:'비공개',click(){privateRadio.checked=true;},querySelector:()=>privateRadio};
 const wrapper={...shown,textContent:name,click(){throw Error('decorative wrapper must not be clicked');}};
 const title={...shown};
 const document={body:{innerText:''},querySelectorAll(selector){
  if(selector.startsWith('.se-title-text'))return [title];
  if(selector.startsWith('button[data-click-area='))return [button()];
  if(selector==='button,label,[role="button"],a')return [label,privateLabel];
  if(selector==='span')return [wrapper];
  return [];
 }};
 const context=vm.createContext({document,getComputedStyle:()=>({visibility:'visible'}),setTimeout:f=>f()});
 vm.runInContext(fs.readFileSync('extension/editor.js','utf8'),context);
 const result=await context.editorCommand('settings',{category:name,publishVisibility:'private',tags:[]});
 if(scenario==='duplicate'||scenario==='partial'){
   assert.equal(result.ok,false);assert.equal(labelClicks,0);
   assert.match(result.error,scenario==='duplicate'?/같은 이름/:/찾지 못했습니다/);
 }else if(scenario==='wrong-id'){
   assert.equal(result.ok,false);assert.match(result.error,/선택 결과/);
 }else{assert.equal(result.ok,true,result.error);assert.equal(labelClicks,1);assert.equal(privateRadio.checked,true);}
});
