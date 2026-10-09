const account=document.querySelector('#account');
const status=document.querySelector('#status');
async function send(type){const r=await chrome.runtime.sendMessage({type});if(r?.error)throw new Error(r.error);return r;}
async function refresh(){try{const r=await send('quickStatus');account.textContent=r.connection?(r.connection.label+' · '+r.connection.blogId):'연결된 계정 없음';status.textContent=r.session?.reason || (r.connection?'상태 확인 대기':'앱에서 계정을 연결하세요.');}catch(e){account.textContent='연결 확인 실패';status.textContent=e.message;}}
document.querySelector('#check').onclick=async()=>{status.textContent='확인 중…';try{await send('quickSession');status.textContent='세션 확인을 요청했습니다.';setTimeout(refresh,1200);}catch(e){status.textContent=e.message;}};
document.querySelector('#open').onclick=async()=>{try{await send('quickOpen');status.textContent='글쓰기 화면을 열었습니다.';window.close();}catch(e){status.textContent=e.message;}};
document.querySelector('#connect').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('connect.html')});
refresh();