// Offline adapter integration test. No Chrome, Naver, generation or publication.
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {articlePlan}=require('../extension/article-plan');
app.setPath('userData',path.resolve(__dirname,'../.test-runtime/editor-data'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:900,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')console.error(details.message);});
 try{
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><meta charset="UTF-8"><style>body{padding:20px}button{min-height:35px}[contenteditable],p{min-height:24px}.se-component{margin:15px}.se-quotation{padding:20px}.se-l-quotation_line{border-left:4px solid #555}</style>
  <div class="se-documentTitle"><p class="se-text-paragraph" contenteditable="true"></p></div>
  <button data-name="quotation" aria-haspopup="true">스타일 선택</button><button data-name="quotation" data-role="option" data-value="default">따옴표</button><button data-name="quotation" data-role="option" data-value="quotation_line">버티컬</button>
  <input type="file" accept="image/png"><div id="components"></div><button class="se-canvas-bottom-button">새 입력 영역</button>
  <script>
  const root=document.querySelector('#components');
  function body(){const e=document.createElement('div');e.className='se-component se-text';e.innerHTML='<div class="se-component-content se-section-text" contenteditable="true"><p class="se-text-paragraph"></p></div>';root.append(e);return e;}
  body();document.querySelector('.se-canvas-bottom-button').onclick=()=>{
    // Selection/scroll transitions must not be mistaken for lost content.
    const previous=[...root.querySelectorAll('.se-text')].find(e=>e.textContent.trim());
    if(previous)previous.style.visibility='hidden';
    body();
  };
  document.querySelectorAll('[data-role="option"]').forEach(b=>b.onclick=()=>{const e=document.createElement('div');e.className='se-component se-quotation se-l-'+b.dataset.value;e.innerHTML='<div class="se-component-content"><p class="se-text-paragraph" contenteditable="true"></p></div>';root.append(e);});
  document.querySelector('input').onchange=()=>{const e=document.createElement('div');e.className='se-component se-image';e.innerHTML='<div class="se-component-content"><img alt="테스트 이미지"><button class="se-set-ai-mark-button-toggle"></button></div>';root.append(e);e.querySelector('button').onclick=()=>e.querySelector('button').classList.add('se-is-selected');};
  </script>`));
  const adapter=fs.readFileSync(path.resolve(__dirname,'../extension/editor.js'),'utf8');
  const call=(command,args={})=>win.webContents.executeJavaScript(`(${adapter.replace(/^[\s\S]*?(?=async function editorCommand)/,'')})(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const article='원문 첫 문장입니다. 두 번째 문장입니다.\n[SECTION - 첫 번째 섹션]\n1. 목록 번호는 유지합니다.\n접수가 가능하다면 공고의 세부 요건을 읽은 뒤 신청서를 작성하고, 철거 외 지원도 필요하다면 희망리턴패키지 홈페이지에서 해당 항목을 별도로 신청하면 됩니다.\n[IMAGE INSERT - 1]\n[SECTION - 참고자료]\n참고 1: 기관 자료\nhttps://example.com/notice?id=1';
  const plan=articlePlan(article),title='테스트 제목';
  assert.equal((await call('title',{text:title})).ok,true);
  const titleQuote=await call('quote',{text:title,style:'default'});assert.equal(titleQuote.ok,true,JSON.stringify(titleQuote));
  // Real Naver replaces the initial empty text component with the quote.
  await win.webContents.executeJavaScript(`document.querySelectorAll('#components .se-text').forEach(e=>e.remove())`);
  const quoteOnly=await call('inspect');
  assert.equal(quoteOnly.status,'valid',JSON.stringify(quoteOnly));
  assert.equal(quoteOnly.titleQuoteOnly,true);
  await win.webContents.executeJavaScript(`document.querySelector('.se-canvas-bottom-button').style.display='none'`);
  assert.equal((await call('inspect')).status,'unknown');
  await win.webContents.executeJavaScript(`document.querySelector('.se-canvas-bottom-button').style.display=''`);
  for(const block of plan){
   assert.equal((await call('inspect')).status,'valid','Each extension command must pass frame inspection');
   const result=block.type==='image'?await call('image',{data:'AA==',name:'image.png',mime:'image/png'}):await call(block.type==='section'?'quote':'paragraph',{text:block.text,style:block.style,breakSentences:true});
   assert.equal(result.ok,true,JSON.stringify({block,result}));
  }
  const check={title,article,plan,titleQuote:true,requireAi:true,sectionStyle:'quotation_line',imageCount:1};
  const verified=await call('verify',check);assert.equal(verified.ok,true,JSON.stringify(verified));
  await win.webContents.executeJavaScript(`document.querySelector('.se-set-ai-mark-button-toggle').classList.remove('se-is-selected')`);
  assert.match((await call('verify',check)).error,/AI 활용 미설정/);
  await win.webContents.executeJavaScript(`document.querySelector('.se-set-ai-mark-button-toggle').classList.add('se-is-selected')`);
  const content=await win.webContents.executeJavaScript(`document.querySelector('#components').textContent`);
  assert.ok(content.includes('신청하면 됩니다.'));
  const failed=await call('verify',{...check,article:article.replace('신청하면 됩니다.','추가 누락 내용입니다.')});
  assert.equal(failed.ok,false);assert.match(failed.error,/본문.*누락/);
  await win.webContents.executeJavaScript(`document.querySelectorAll('.se-l-quotation_line')[0].className='se-component se-quotation se-l-default'`);
  assert.match((await call('verify',check)).error,/버티컬/);
  // Exercise the actual document snapshot and resumable writer together, not mocked snapshots.
  await win.webContents.executeJavaScript(`
    document.querySelector('#components').innerHTML='';document.querySelector('.se-documentTitle p').textContent='';body();
    let componentCounter=0;const identify=()=>document.querySelectorAll('.se-component').forEach(e=>{if(!e.id)e.id='test-component-'+(++componentCounter);});
    identify();new MutationObserver(identify).observe(document.querySelector('#components'),{childList:true});
    document.querySelector('input').onchange=event=>{const e=document.createElement('div');e.className='se-component se-image';e.innerHTML='<div class="se-component-content"><img><button class="se-set-ai-mark-button-toggle"></button></div>';e.querySelector('img').alt=event.target.files[0].name;root.append(e);e.querySelector('button').onclick=()=>e.querySelector('button').classList.add('se-is-selected');};true;
  `);
  const {runWriter}=require('../extension/writer');
  const steps=[{type:'title',text:title},{type:'quote',text:title,style:'default'},...plan.map(b=>b.type==='section'?{...b,type:'quote'}:b.type==='image'?{type:'image',name:'image.png',data:'AA==',mime:'image/png'}:b)];
  let checkpoints=0,applied=0;
  const writer={steps,read:()=>call('snapshot'),apply:async(b,anchor)=>{applied++;const result=await call(b.type,{...b,...anchor,breakSentences:true});if(!result.ok)throw new Error(result.error);},save:async()=>{checkpoints++;},checkCancelled:async()=>{}};
  await runWriter(writer);assert.equal(applied,steps.length);assert.ok(checkpoints>steps.length);
  applied=0;await runWriter(writer);assert.equal(applied,0,'completed document must not be typed again');
  assert.equal((await call('verify',check)).ok,true);
  console.log('Offline editor passed: full text preserved across bottom-slot appends, title quotation, vertical sections, image-before-body order, numbered lists, missing text/style blocked.');app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
