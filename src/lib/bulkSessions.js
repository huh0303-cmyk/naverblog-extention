// Opens ordinary Chrome only when its extension is offline or fails to pick up a check.
// Existing login results are never used to skip a fresh check.
async function checkBulkSessions(accounts, {bridge, open, check, log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const selected = accounts.filter(account => account.checked !== false);
  const blogs = [...new Set(selected.map(account => account.tistoryBlogId).filter(Boolean))];
  async function visit(account, opened = {value:false}) {
    const label = account.label || account.blogId;
    const launch = async () => {
      if (opened.value) return;
      opened.value = true;
      log(`${label}: Chrome을 열어 확장 연결과 로그인을 확인합니다.`);
      await open(account);
    };
    try {
      if (bridge.snapshot(account.id).busy) {
        log(`${label}: 진행 중인 작업이 있어 이번 확인을 건너뜁니다.`);
        return {accountId:account.id,blogId:account.blogId,status:'busy'};
      }
      if (!bridge.snapshot(account.id).connected) {
        await launch();
        for (let n=0;n<30 && !bridge.snapshot(account.id).connected;n++) await sleep(1000);
      }
      if (!bridge.snapshot(account.id).connected) {
        log(`${label}: Chrome에서 BlogAuto 확장프로그램 연결을 완료한 뒤 다시 확인하세요.`);
        return {accountId:account.id,blogId:account.blogId,status:'disconnected'};
      }
      log(`${label}: 현재 로그인 상태를 확인합니다. 로그인이 필요하면 열린 Chrome에서 로그인해 주세요.`);
      let settled = false;
      const pending = check(account).finally(() => { settled = true; });
      // A recently closed browser can retain a heartbeat for up to 75 seconds.
      // If the check is still unclaimed, open Chrome instead of waiting forever.
      const wake = (async () => {
        for(let n=0;n<4 && !settled;n++) await sleep(1000);
        if(!settled && [...bridge.tasks.values()].some(task => task.accountId===account.id && task.type==='session' && task.state==='queued')) await launch();
      })();
      const [result] = await Promise.all([pending,wake]);
      log(`${label}: ${result.status==='valid'?'로그인 확인 완료':result.reason || result.status}`);
      return {accountId:account.id,blogId:account.blogId,...result};
    } catch(error) {
      log(`${label}: ${error.message}`);
      return {accountId:account.id,blogId:account.blogId,status:'error',reason:error.message};
    }
  }
  const tistory = async () => {
    const results=[], opened={value:false};
    // One shared login; check distinct destinations serially without opening more browsers.
    for(const blogId of blogs) {
      const result=await visit({id:'tistory-shared',platform:'tistory',blogId,label:`티스토리 ${blogId}`},opened);
      results.push(result);
      if(['disconnected','busy'].includes(result.status))break;
    }
    return results;
  };
  return (await Promise.all([...selected.map(account=>visit(account)),tistory()])).flat();
}
module.exports={checkBulkSessions};
