const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { detectCodexInstallation, buildCodexEnvironment } = require('./codexPlatform');

// Catalog discovery never starts a thread or an inference turn.
function listCodexModels(command, { spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawnProcess(batch ? `"${command}"` : command, ['app-server'], {
      windowsHide: true, shell: batch, stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCodexEnvironment({ command })
    });
    let done = false, requestId = 0, pages = 0;
    const models = new Map(), cursors = new Set();
    const lines = readline.createInterface({ input: child.stdout });
    const finish = (error) => {
      if (done) return;
      done = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      error ? reject(error) : resolve([...models.values()]);
    };
    const timer = setTimeout(() => finish(new Error('모델 목록 응답 지연')), timeoutMs);
    const send = (message) => { if (!done) child.stdin.write(JSON.stringify(message) + '\n'); };
    const list = (cursor) => send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    child.on('error', () => finish(new Error('Codex 실행 실패')));
    child.stdin.on('error', () => finish(new Error('Codex 연결 종료')));
    child.on('exit', () => finish(new Error('모델 목록 확인 전 Codex 종료')));
    child.stderr.resume();
    lines.on('line', (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== requestId || done) return;
      if (message.error) return finish(new Error('Codex 모델 목록 조회 실패'));
      if (!message.result) return;
      if (requestId === 0) {
        send({ method: 'initialized', params: {} }); list(); return;
      }
      if (!Array.isArray(message.result.data)) return finish(new Error('모델 목록 형식 확인 필요'));
      for (const item of message.result.data) {
        const id = String(item.model || item.id || '').trim();
        if (!id || item.hidden === true) continue;
        models.set(id, { id, displayName: String(item.displayName || id), isDefault: item.isDefault === true });
      }
      const cursor = message.result.nextCursor;
      if (cursor) {
        if (cursors.has(cursor) || ++pages > 30) return finish(new Error('모델 목록 페이지 반복'));
        cursors.add(cursor); list(cursor);
      } else if (!models.size) finish(new Error('사용 가능한 모델 목록이 비어 있습니다'));
      else finish();
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'naverblog_extention', version: require('../../package.json').version } } });
  });
}

// Deduplicate simultaneous window-focus requests and limit catalog checks to once per five minutes.
const catalogs = new Map();
async function getCodexCatalog(command) {
  const installation = detectCodexInstallation(command);
  if (!installation.installed) return { installation, models: [], status: 'not_installed' };
  const key = installation.path;
  let entry = catalogs.get(key);
  if (entry?.pending) return entry.pending;
  if (entry && Date.now() - entry.checkedAt < 300000) return entry.result;
  const previous = entry?.result?.models || [];
  entry = { checkedAt: Date.now(), result: null, pending: null }; catalogs.set(key, entry);
  entry.pending = listCodexModels(key).then(models => ({ installation, models, status: 'ready' }))
    .catch(() => ({ installation, models: previous, status: 'unavailable' }))
    .then(result => { entry.result = result; entry.pending = null; return result; });
  return entry.pending;
}
module.exports = { listCodexModels, getCodexCatalog };
