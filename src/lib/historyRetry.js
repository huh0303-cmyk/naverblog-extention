const fs = require('node:fs');
const path = require('node:path');
const terminal = new Set(['success', 'generated']);
const key = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
function jobFile(root, id, name) {
  if (!/^job_\d+$/.test(String(id))) return null;
  return path.join(root, 'jobs', id, name);
}
function readJob(root, id, name) {
  try { return JSON.parse(fs.readFileSync(jobFile(root, id, name), 'utf8')); } catch { return null; }
}
function sameAccount(a, b) { return a.account_id && b.account_id ? a.account_id === b.account_id : a.blog_id === b.blog_id; }
function lineage(item) { return item.retry_root_id || item.id; }
function related(a, b) {
  return sameAccount(a, b) && (lineage(a) === lineage(b)
    || Boolean(key(a.title || a.research_title) && key(a.title || a.research_title) === key(b.title || b.research_title)));
}
function retryPlan(root, item, history, settings, accounts) {
  const deny = reason => ({ allowed: false, reason });
  if (terminal.has(item.status)) return deny('완료된 작업');
  if (!jobFile(root, item.id, '')) return deny('복구할 작업 기록이 없습니다.');
  if (history.some(other => terminal.has(other.status) && related(item, other))) return deny('이후 재시도에서 완료된 작업');
  // Always use the latest attempt in the same lineage, never an older checkpoint.
  const latest = history.filter(other => related(item, other)).sort((a,b) => String(b.create_at).localeCompare(String(a.create_at)))[0] || item;
  const account = accounts.find(a => a.id === latest.account_id || (!latest.account_id && a.blogId === latest.blog_id));
  if (!account) return deny('계정이 삭제되어 재시도할 수 없습니다.');
  if (account.blogId !== latest.blog_id) return deny('블로그 ID가 변경되었습니다. 기존 발행 대상을 확인하세요.');
  const category = account.categories?.find(c => key(c.name) === key(latest.category));
  if (!category) return deny('카테고리가 삭제되거나 이름이 변경되었습니다.');
  const pending = settings.pendingNaverPublishDraft || settings.pendingGenerationDraft;
  const ids = new Set(history.filter(h => related(item,h)).map(h => h.id));
  const matchesPending = pending && (ids.has(pending.jobId) || ids.has(pending.retryRootId));
  if (pending && !matchesPending) return deny('다른 보류 작업이 있습니다. 먼저 완료하거나 기존 작업 취소를 눌러 주세요.');
  const attempts = readJob(root, latest.id, 'attempts.json') || [];
  const last = Array.isArray(attempts) ? attempts.at(-1) || {} : {};
  const phase = latest.failure_phase || last.phase || '';
  const quality = latest.status === 'duplicate_retry' || last.status === 'duplicate_retry' || latest.failure_kind === 'quality' || (!latest.failure_kind && last.status === 'failed' && phase && !['image','humanizer'].includes(phase));
  let draft = matchesPending && settings.pendingNaverPublishDraft || readJob(root, latest.id, 'publish-draft.json');
  let checkpoint = matchesPending && settings.pendingGenerationDraft?.checkpoint || readJob(root, latest.id, 'generation-checkpoint.json');
  let mode, reason;
  if (draft?.article && draft.title) {
    draft = JSON.parse(JSON.stringify(draft));
    if (draft.accountId !== account.id || draft.blogId !== account.blogId || key(draft.category) !== key(category.name)) return deny('원고와 작업 대상 정보가 일치하지 않습니다.');
    // Legacy files were saved before publication and may not contain its outcome.
    if (!matchesPending && !draft.publications) {
      draft.status = 'publish_uncertain';
      draft.publications = {naver:{status:'running'},...(draft.tistoryBlogId && draft.publishToTistoryAfterNaver!==false ? {tistory:{status:'running'}} : {})};
    }
    const needsTistory = draft.tistoryBlogId && draft.publishToTistoryAfterNaver !== false;
    if (draft.publications?.naver?.status === 'done' && (!needsTistory || draft.publications?.tistory?.status === 'done')) return deny('발행 완료 기록이 확인된 작업');
    const files = [draft.titleImagePath, ...(draft.bodyImages || []).map(i=>i.path)].filter(Boolean);
    if (files.some(file=>!fs.existsSync(file))) return deny('완성 원고의 이미지 파일이 없습니다. 파일을 복원한 뒤 재시도하세요.');
    mode = 'publish'; reason = '완성 원고 재사용 · 발행 결과 확인 후 미완료 플랫폼만 진행';
  } else if (checkpoint?.version === 2 && checkpoint.steps && checkpoint.retrievals && checkpoint.attemptNumber >= 1 && checkpoint.attemptNumber <= 3) {
    checkpoint = JSON.parse(JSON.stringify(checkpoint));
    if (quality && ['research','title_duplicate'].includes(phase)) {
      checkpoint = null; mode = 'research'; reason = '주제·근거 반려 · 주제 선정부터 다시 진행';
    } else {
      if (quality && ['writer','main_review'].includes(phase)) {
        for (const k of Object.keys(checkpoint.steps || {})) if (!k.includes('research-title')) delete checkpoint.steps[k];
        delete checkpoint.imageCheckpoint;
        mode = 'writer'; reason = '본문 품질 반려 · 완료된 조사를 재사용해 본문부터 다시 진행';
      } else { mode = 'checkpoint'; reason = checkpoint.imageCheckpoint ? '승인된 본문과 완료된 이미지 재사용 · 미완료 이미지부터 진행' : '완료된 단계 재사용 · 중단된 단계부터 진행'; }
    }
  } else if (['research','title_duplicate','connection'].includes(phase) || ['codex_exec_failed','codex_usage_limit','session_expired'].includes(latest.status)) {
    mode = 'research'; reason = '저장된 완료 단계 없음 · 연결 확인 후 주제 선정부터 진행';
  } else return deny('안전하게 재개할 원고·단계 기록이 없습니다. 새 작업으로 진행하세요.');
  return { allowed: true, mode, reason, sourceId: latest.id, rootId: lineage(latest), accountId: account.id, categoryId: category.id, category: category.name, blogId: account.blogId, draft, checkpoint };
}
function publicPlan(plan) { const { draft, checkpoint, ...summary } = plan; return summary; }
module.exports = { retryPlan, publicPlan, readJob, jobFile };
