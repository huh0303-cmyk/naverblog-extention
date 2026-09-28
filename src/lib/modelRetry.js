function recoverable(error) {
  return error?.code === 'CODEX_EXEC_FAILED' || error?.code === 'CODEX_USAGE_LIMIT';
}
function createRetryTask(run, options, log) {
  let model = options.codexModel;
  return async args => {
    for (;;) {
      try { return await run({...args, options:{...args.options, codexModel:model}}); }
      catch(error) {
        if(!recoverable(error) || !options.onModelError)throw error;
        log('모델 응답 오류 · 수집 자료를 유지하고 사용자 선택을 기다립니다.','warn','main');
        const choice=await options.onModelError({model, detail:error.codexExecutionDetail || error.message, code:error.code});
        if(!choice || choice.action==='cancel')throw Object.assign(new Error('사용자가 모델 재시도를 취소했습니다.'),{code:'MODEL_RETRY_CANCELLED'});
        model=choice.model ?? model;
        log('사용자 요청으로 실패한 모델 호출을 다시 시도합니다.','info','main');
      }
    }
  };
}
module.exports={createRetryTask};
