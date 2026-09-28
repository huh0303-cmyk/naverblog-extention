const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('extension/tistory.js','utf8');
async function inspect(rows,args={},host='test.tistory.com'){
  const links=rows.map(({title='정확한 제목',status='예약',date='2026-09-27 17:30',url='https://test.tistory.com/123',badge=status==='예약'?'[예약]':''})=>({textContent:badge+title,href:url,getAttribute:name=>name==='title'?title:null,querySelector:()=>badge?{textContent:badge}:null,closest:()=>({querySelector:()=>({textContent:status==='예약'?'':status,disabled:status==='예약'}),querySelectorAll:()=>[{textContent:'작성자'},{textContent:date}]})}));
  const context=vm.createContext({URL,Date,window:{},location:{hostname:host,pathname:'/manage/posts/',origin:'https://'+host},document:{querySelectorAll:()=>links}});
  vm.runInContext(source,context);
  return context.tistoryCommand('published',{blogId:'test',title:'정확한 제목',publishScheduleMode:'reserve',publishVisibility:'public',scheduledAt:new Date(2026,8,27,17,30).toISOString(),...args});
}
test('Tistory reservation requires exact row title, scheduled status and date',async()=>{
  const result=await inspect([{}]);assert.equal(result.complete,true);assert.equal(result.scheduled,true);assert.equal(result.verification,'reservation-list');assert.equal(result.managementUrl,'https://test.tistory.com/manage/posts/');
});
test('Tistory rejects title-only evidence, duplicate title, and foreign destination',async()=>{
  for(const rows of [[{status:'공개'}],[{status:'비공개'}],[{date:'2026-09-27 17:40'}],[{date:'2026-09-27'}],[{date:'2026-09-28 17:30'}],[{title:'정확한제목'}],[{},{}],[{url:'https://other.tistory.com/123'}]])assert.equal((await inspect(rows)).complete,false);
  assert.notEqual((await inspect([{}],{},'other.tistory.com')).complete,true);
});
test('Tistory immediate publishing also verifies requested visibility',async()=>{
  for(const [status,visibility,complete] of [['공개','public',true],['비공개','private',true],['예약','public',false],['비공개','public',false]])assert.equal((await inspect([{status}],{publishScheduleMode:'now',publishVisibility:visibility})).complete,complete);
});
test('Tistory date comparison accepts single-digit and spaced formatted dates',async()=>{
  assert.equal((await inspect([{date:'2026. 9. 27 17:30'}])).complete,true);
  assert.equal((await inspect([{}],{scheduledAt:'invalid'})).complete,false);
});
test('observed Tistory reservation badge uses title attribute with disabled empty visibility button',async()=>{
  assert.equal((await inspect([{badge:'[예약]',status:'예약'}])).complete,true);
  assert.equal((await inspect([{badge:'[다른 상태]',status:'예약'}])).complete,false);
  assert.equal((await inspect([{badge:'',status:'예약'}])).complete,false);
});
