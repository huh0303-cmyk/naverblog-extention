async function refreshPendingPublishButton(){
  const button=document.querySelector('#cancelPendingJobButton');
  if(!button || button.dataset.cancelling)return;
  try{
    const pending=await window.blogAuto.getPendingPublishState();
    if(button.dataset.cancelling)return;
    button.disabled=!pending.available || pending.busy;
    button.title=pending.busy?'현재 작업 종료 후 취소할 수 있습니다.':pending.available?'보류 원고와 불확실 상태를 해제합니다. 게시글·기록·파일은 삭제하지 않습니다.':'취소할 기존 작업이 없습니다.';
  }catch{button.disabled=true;}
}
const state = {
  currentJobId: "",
  running: false,
  autoRunning: false,
  bulkChecking: false,
  autoPausedForSession: false,
  autoWaitingSessionAccountId: "",
  autoResumeAccountId: "",
  autoPendingSessionTarget: null,
  saveTimer: null,
  autoDelayWake: null,
  tokenTotal: 0,
  codexRateLimits: null,
  chrome: { available: true, path: "" },
  accountStore: { selectedAccountId: "", accounts: [] },
  tistorySessionStatus: "unknown",
  accountManagerOpen: false,
  categoryManagerOpen: false,
  historyModalOpen: false,
  draggingAccountId: "",
  draggingCategoryId: "",
  editingCategoryId: ""
};

const $ = (selector) => document.querySelector(selector);
const DEFAULT_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const DEFAULT_GOOGLE_SEARCH_URL = "https://www.google.com/search?q={query}&num=20&hl=ko";
const STARTUP_NOTICE_KEY = "blogauto.startupNotice.dismissed.v2";
const DEFAULT_AGENT_MODELS = {
  main: "high",
  research: "high",
  writer: "high",
  image: "medium"
};
const CODEX_MODEL_IDS = new Set([
  "",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex"
]);
const AGENT_MODEL_SELECTORS = {
  main: "#mainAgentModel",
  research: "#researchAgentModel",
  writer: "#writerAgentModel",
  image: "#imageWorkerModel"
};
const VALID_AGENT_MODEL_VALUES = new Set(["low", "medium", "high", "xhigh"]);
const AUTO_TARGET_MAX_ATTEMPTS = 1;
const AUTO_RESEARCH_MAX_ATTEMPTS = 1;
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1", "3:4"]);

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function normalizeCodexModel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CODEX_MODEL_IDS.has(normalized) ? normalized : "";
}

function normalizeSearchProvider(value, fallback = "naver") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["naver", "google"].includes(normalized) ? normalized : fallback;
}

function normalizeSearchChannel(value, fallback = "blog") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["blog", "news", "web"].includes(normalized) ? normalized : fallback;
}

function searchChannelLabel(value) {
  const channel = normalizeSearchChannel(value);
  if (channel === "news") return "검색: 뉴스";
  if (channel === "web") return "검색: 웹";
  return "검색: 블로그";
}

function fallbackSearchProviderFor(primary) {
  return normalizeSearchProvider(primary, "naver") === "google" ? "naver" : "google";
}

function categorySearchProviders(category = {}) {
  const primarySearchProvider = normalizeSearchProvider(category?.primarySearchProvider, "naver");
  let fallbackSearchProvider = normalizeSearchProvider(
    category?.fallbackSearchProvider,
    fallbackSearchProviderFor(primarySearchProvider)
  );
  if (fallbackSearchProvider === primarySearchProvider) {
    fallbackSearchProvider = fallbackSearchProviderFor(primarySearchProvider);
  }
  return { primarySearchProvider, fallbackSearchProvider };
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSelectedAccount() {
  const accounts = state.accountStore.accounts || [];
  if (!accounts.length) {
    state.accountStore.selectedAccountId = "";
    return null;
  }
  const selected = accounts.find((account) => account.id === state.accountStore.selectedAccountId);
  if (selected) return selected;
  state.accountStore.selectedAccountId = accounts[0].id;
  return accounts[0];
}

function selectedAccount() {
  return ensureSelectedAccount();
}

function accountDisplayName(account) {
  return String(account?.label || account?.blogId || account?.naverId || "Naver 계정");
}

function setRunState(status, detail = "") {
  const badge = $("#runState");
  const classMap = {
    success: "success",
    generated: "success",
    failed: "danger",
    codex_usage_limit: "danger",
    codex_exec_failed: "danger",
    session_expired: "danger",
    duplicate_retry: "warning",
    publishing: "info",
    generating: "info"
  };
  const labelMap = {
    success: "성공",
    generated: "생성",
    failed: "실패",
    codex_usage_limit: "한도초과",
    codex_exec_failed: "Codex실패",
    session_expired: "세션만료",
    duplicate_retry: "중복",
    publishing: "발행",
    generating: "생성중"
  };
  badge.className = `badge ${classMap[status] || "info"}`;
  badge.textContent = detail && detail !== status ? detail : (labelMap[status] || status || "대기");
}

function setTistoryTestButtonDisabled(disabled) {
  const button = $("#tistoryTestButton");
  if (button) button.disabled = disabled;
}

function addLog(payload) {
  if (/프롬프트\s*크기\s*:|토큰\s*사용량\s*:|^tokens?\s+used\b/i.test(String(payload.message || ''))) return;
  const streamMap = {
    main: "#mainLogStream",
    research: "#researchLogStream",
    writer: "#writerLogStream",
    humanizer: "#writerLogStream",
    image: "#mainLogStream"
  };
  const stream = $(streamMap[payload.agent] || streamMap.main);
  if (!stream) return;
  const key = String(payload.message || '');
  if (stream.dataset.lastMessage === key && Date.now() - Number(stream.dataset.lastAt || 0) < 5000) return;
  stream.dataset.lastMessage = key; stream.dataset.lastAt = String(Date.now());
  const line = document.createElement("div");
  line.className = `log-line ${payload.level || "info"}`;
  const time = payload.at ? new Date(payload.at).toLocaleTimeString() : new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${payload.message}`;
  stream.appendChild(line);
  while (stream.children.length > 300) stream.firstElementChild.remove();
  stream.scrollTop = stream.scrollHeight;
}

function shouldRetryAutoResult(result) {
  const status = String(result?.status || "").toLowerCase();
  if (["success", "generated", "codex_usage_limit", "codex_exec_failed", "session_expired"].includes(status)) {
    return false;
  }
  if (status === "duplicate_retry") return true;
  return String(result?.failurePhase || "").toLowerCase() === "research";
}

function autoAttemptLimitForResult(result) {
  return String(result?.failurePhase || "").toLowerCase() === "research"
    ? AUTO_RESEARCH_MAX_ATTEMPTS
    : AUTO_TARGET_MAX_ATTEMPTS;
}

function autoResultReason(result) {
  return String(result?.reason || result?.failureReason || result?.status || "unknown").trim();
}

function keywordLanePhrasesFromResult(result) {
  const lane = result?.keywordLane || {};
  return [
    lane.topicLane,
    ...(Array.isArray(lane.selectedKeywordPhrases) ? lane.selectedKeywordPhrases : [])
  ]
    .map((phrase) => String(phrase || "").trim())
    .filter(Boolean);
}

function runAutoStartJob(form) {
  const testStartJob = window.__blogAutoTestHooks?.startJob;
  if (typeof testStartJob === "function") {
    return testStartJob(form);
  }
  return window.blogAuto.startJob(form);
}

function clearAgentLogs() {
  ["#mainLogStream", "#researchLogStream", "#writerLogStream"].forEach((selector) => {
    const stream = $(selector);
    if (stream) stream.innerHTML = "";
  });
}

function formatTokens(total) {
  const value = Number(total || 0);
  return `${value.toLocaleString()} tokens`;
}

function setTokenTotal(total) {
  state.tokenTotal = Number(total || 0);
  $("#tokenBadge").textContent = `누적 ${formatTokens(state.tokenTotal)}`;
}

function formatPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "-";
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function limitBadgeClass(limitWindow) {
  const remaining = Number(limitWindow?.remainingPercent);
  if (!Number.isFinite(remaining)) return "badge limit unknown";
  if (remaining <= 10) return "badge limit danger";
  if (remaining <= 25) return "badge limit warning";
  return "badge limit";
}

function codexLimitWindows(rateLimits) {
  return [rateLimits?.primary, rateLimits?.secondary]
    .filter((limitWindow) => limitWindow && typeof limitWindow === "object");
}

function weeklyCodexLimitWindow(rateLimits) {
  const windows = codexLimitWindows(rateLimits);
  const weekly = windows.find((limitWindow) => Number(limitWindow.windowMinutes) === 10080);
  if (weekly) return weekly;
  return windows
    .slice()
    .sort((left, right) => Number(right.windowMinutes || 0) - Number(left.windowMinutes || 0))[0] || null;
}

function renderCodexRateLimits(status = "") {
  const weeklyBadge = $("#codexWeeklyLimitBadge");
  if (!weeklyBadge) return;

  const rateLimits = state.codexRateLimits || {};
  const weekly = weeklyCodexLimitWindow(rateLimits);

  weeklyBadge.className = limitBadgeClass(weekly);
  weeklyBadge.textContent = `주간 잔량 ${formatPercent(weekly?.remainingPercent)}`;

  if (status === "checking" && !weekly) {
    weeklyBadge.textContent = "주간 확인 중";
  }
  if (status === "failed" && !weekly) {
    weeklyBadge.textContent = "주간 확인 실패";
  }
}

function setCodexRateLimits(rateLimits, status = "") {
  if (rateLimits && typeof rateLimits === "object") {
    state.codexRateLimits = rateLimits;
  }
  renderCodexRateLimits(status);
}

function statusBadge(status) {
  const classMap = {
    success: "success",
    generated: "success",
    failed: "danger",
    codex_usage_limit: "danger",
    codex_exec_failed: "danger",
    session_expired: "danger",
    duplicate_retry: "warning",
    publishing: "info",
    generating: "info"
  };
  const labelMap = {
    success: "성공",
    generated: "생성",
    failed: "실패",
    codex_usage_limit: "한도초과",
    codex_exec_failed: "Codex실패",
    session_expired: "세션만료",
    duplicate_retry: "중복",
    publishing: "발행",
    generating: "생성중"
  };
  return `<span class="badge ${classMap[status] || "info"}">${labelMap[status] || status || "대기"}</span>`;
}

function loginDisplayConfirmed(account){return account.sessionStatus==='valid' || Boolean(account.connection?.connected && account.connection.loginStatus==='valid' && !['expired','security_check','account_mismatch','waiting_login'].includes(account.sessionStatus));}
function sessionBadge(account) {
  if(account.connection?.connected && account.connection.loginStatus==='valid' && ['unknown','checking'].includes(account.sessionStatus))return '<span class="badge success">로그인 확인됨 · 상태 갱신 중</span>';
  const labels={valid:'로그인 확인됨',waiting_login:'로그인 대기',expired:'로그인 필요',disconnected:'확장 연결 없음',security_check:'추가 인증 필요',account_mismatch:'다른 계정 로그인',checking:'로그인 확인 중',unknown:'로그인 미확인'};
  const status=account.sessionStatus || 'unknown';
  return '<span class="badge '+(status==='valid'?'success':'warning')+'">'+(labels[status] || labels.unknown)+'</span>';
}

function updateSessionNotice() {
  const notice = $("#sessionNotice");
  const text = $("#sessionNoticeText");
  if (!notice || !text) return;

  const accounts = state.accountStore.accounts || [];
  const needsLogin = !accounts.length || accounts.some((account) => !loginDisplayConfirmed(account));
  if (!needsLogin) {
    notice.hidden = true;
    return;
  }

  if (!accounts.length) {
    text.textContent = "계정을 추가한 뒤 ‘블로그 열기 / 로그인’을 누르세요. 처음에는 해당 Chrome의 확장프로그램 연결도 필요합니다.";
  } else {
    const names = accounts
      .filter((account) => !loginDisplayConfirmed(account))
      .map((account) => accountDisplayName(account))
      .join(", ");
    text.textContent = `연결·확인이 필요한 계정: ${names}. ‘블로그 열기 / 로그인’을 누르세요. 확장 연결 후에는 로그인 상태를 확인할 수 있습니다.`;
  }
  notice.hidden = false;
}

function wakeAutoDelay() {
  const wake = state.autoDelayWake;
  if (typeof wake === "function") {
    state.autoDelayWake = null;
    wake();
  }
}

function signalAutoSessionResume(accountId) {
  const verifiedAccountId = String(accountId || "");
  if (state.autoWaitingSessionAccountId && state.autoWaitingSessionAccountId === verifiedAccountId) {
    state.autoResumeAccountId = verifiedAccountId;
    wakeAutoDelay();
  }
}

const openingAccounts = new Set();
const checkingAccounts = new Set();
async function openAccountAndCheck(account) {
  if(openingAccounts.has(account.id) || checkingAccounts.has(account.id) || account.connection?.busy || (account.connection?.connected && account.sessionStatus==='valid'))return;
  openingAccounts.add(account.id);renderAccounts();
  try {
    await window.blogAuto.openAccountChrome(account.id);
    // Chrome may need a few seconds to start the extension heartbeat.
    for(let attempt=0;attempt<20;attempt++) {
      const store=await window.blogAuto.getConnections();
      const current=store.accounts.find(a=>a.id===account.id);
      if(!current)return;
      if(current.connection?.connected) {
        if(!current.connection.busy && current.sessionStatus!=='valid')await checkAccountSession(current);
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    addLog({level:'warn',message:accountDisplayName(account)+': Chrome은 열렸지만 확장 연결이 확인되지 않았습니다. 해당 창에서 확장을 켜거나 ‘확장프로그램 연결’을 진행하세요.',at:new Date().toISOString()});
  }catch(error){addLog({level:'error',message:error.message,at:new Date().toISOString()});}
  finally{openingAccounts.delete(account.id);renderAccounts();}
}
async function checkAccountSession(account,options={}) {
  if(!account || checkingAccounts.has(account.id) || account.connection?.busy || (account.connection?.connected && account.sessionStatus==='valid'))return;
  checkingAccounts.add(account.id);renderAccounts();
  try {
    const result=await window.blogAuto.checkAccountSession(account.id,{interactive:options.interactive!==false});
    account.sessionStatus=result.status; renderAccounts();
    if(result.status==='valid')signalAutoSessionResume(account.id);
    if(result.status==='disconnected' && options.interactive!==false) await connectAccount(account);
    else if(result.status!=='valid') addLog({level:'warn',message:accountDisplayName(account)+': '+(result.reason || result.status),at:new Date().toISOString()});
  }catch(error){addLog({level:'error',message:error.message,at:new Date().toISOString()});}
  finally{checkingAccounts.delete(account.id);renderAccounts();}
}
async function checkSelectedAccountSessions() {
  if(state.bulkChecking || state.running || state.autoRunning)return;
  state.bulkChecking=true;renderAccounts();updateRunControls();$('#startButton').disabled=true;
  addLog({agent:'main',message:'세션 일괄 확인 시작 · 선택한 네이버 계정과 연결된 티스토리를 확인합니다.'});
  try {
    await window.blogAuto.checkAllSessions();
    state.accountStore=await window.blogAuto.getConnections();
    addLog({agent:'main',message:'세션 일괄 확인이 끝났습니다. 계정별 결과를 확인하세요.'});
  } catch(error) {addLog({level:'error',message:error.message});}
  finally{state.bulkChecking=false;renderAccounts();updateRunControls();$('#startButton').disabled=state.running || state.autoRunning;}
}
async function connectAccount(account) {
  const guide=$('#extensionGuide'); guide.hidden=false;
  try{const pairing=await window.blogAuto.pairExtension(account.id);$('#pairingCode').textContent=pairing.code;$('#pairingHelp').textContent=accountDisplayName(account)+' 연결 코드가 복사되었습니다. 해당 Chrome의 BlogAuto 확장에 붙여넣으세요. 10분 동안 유효합니다.';}catch(e){$('#pairingHelp').textContent=e.message;}
}

function showStartupNoticeIfNeeded() {
  const notice = $("#startupNotice");
  if (!notice) return;
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(STARTUP_NOTICE_KEY) === "true";
  } catch {
    dismissed = false;
  }
  notice.hidden = dismissed && state.chrome.available !== false;
}

async function dismissStartupNotice() {
  const notice = $("#startupNotice");
  if (notice) notice.hidden = true;
  try {
    window.localStorage.setItem(STARTUP_NOTICE_KEY, "true");
  } catch {
    // Ignore storage failures; the notice can still be dismissed for this session.
  }
  if (state.chrome.available === false) {
    window.alert("Chrome이 설치되어 있지 않아 네이버 세션 확인과 블로그 발행을 진행할 수 없습니다. Chrome 설치 페이지를 연 뒤 프로그램을 종료합니다.");
    await window.blogAuto.openChromeInstallAndQuit();
  }
}

async function refreshCodexUsageOnStartup() {
  renderCodexRateLimits("checking");
  try {
    const usage = await window.blogAuto.refreshCodexUsage();
    if (usage?.rateLimits) {
      setCodexRateLimits(usage.rateLimits);
    } else if (!state.codexRateLimits) {
      renderCodexRateLimits();
    }
  } catch (error) {
    if (!state.codexRateLimits) {
      renderCodexRateLimits();
    }
  }
}

function renderHistory(history) {
  const body = $("#historyBody");
  const summary = $("#historySummary");
  const modal = $("#historyModal");
  const items = Array.isArray(history) ? history : [];

  if (modal) modal.hidden = !state.historyModalOpen;
  if (summary) summary.innerHTML = renderHistorySummary(items);

  body.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty history-empty";
    empty.textContent = "작업 기록이 없습니다.";
    body.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 20)) {
    const card = document.createElement("article");
    card.className = `history-card ${historyStatusClass(item.status)}`;
    const title = item.title || item.research_title || item.topic || "제목 없음";
    const meta = [
      item.category && `카테고리 ${item.category}`,
      item.keyword && `키워드 ${item.keyword}`,
      item.blog_id && `블로그 ${item.blog_id}`
    ].filter(Boolean).join(" · ");
    const agentTokenText = Object.entries(item.token_agents || {})
      .filter(([, value]) => Number(value || 0) > 0)
      .map(([agent, value]) => `${agent} ${formatTokens(value)}`)
      .join(" · ");
    const detailRows = [
      ["주제", item.topic],
      ["선택 lane", item.selected_lane || item.lane || item.keyword_lane],
      ["검색어", item.search_query || item.query],
      ["Research 제목", item.research_title],
      ["검토 결과", item.final_verdict],
      ["실패 단계", item.failure_phase],
      ["근거 요약", item.source_summary],
      ["토큰 상세", Number(item.token_input || 0) > 0
        ? `입력 ${formatTokens(item.token_input)} · 캐시 ${formatTokens(item.token_cached_input)} · 출력 ${formatTokens(item.token_output)} · 유효 ${formatTokens(item.token_total)}`
        : ""],
      ["에이전트별 토큰", agentTokenText],
      ["직접 전달 프롬프트", Number(item.prompt_characters || 0) > 0 ? `${Number(item.prompt_characters).toLocaleString()}자` : ""],
      ["사유", item.reason]
      ,...[...(item.attempts || [])].map(attempt=>[
        `전체 시도 ${attempt.attempt}/${item.attempts.length}`,
        `${attempt.title || '주제 조사'} · ${attempt.status} · ${formatTokens(attempt.tokenUsage?.total || 0)}\n${attempt.reason || '완료'}\n검색어: ${(attempt.queries || []).join(' / ')}`
      ])
    ].filter(([, value]) => String(value || "").trim());

    card.innerHTML = `
      <div class="history-card-top">
        ${statusBadge(item.status)}
        <span class="history-date">${escapeHtml(formatHistoryDate(item.create_at))}</span>
        <span class="history-token">${escapeHtml(formatTokens(item.token_total || 0))}</span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p class="history-meta">${escapeHtml(meta || "작업 대상 정보 없음")}</p>
      <p class="history-reason">${escapeHtml(item.reason || item.source_summary || "기록된 사유가 없습니다.")}</p>
      <details class="history-details">
        <summary>상세 보기</summary>
        <dl>
          ${detailRows.map(([label, value]) => `
            <div>
              <dt>${escapeHtml(label)}</dt>
              <dd>${escapeHtml(value)}</dd>
            </div>
          `).join("")}
        </dl>
      </details>
    `;
    body.appendChild(card);
  }
}

function renderHistorySummary(items) {
  const total = items.length;
  const success = items.filter((item) => item.status === "success" || item.status === "generated").length;
  const failed = items.filter((item) => !["success", "generated"].includes(String(item.status || ""))).length;
  const latest = items[0];
  const latestTitle = latest ? (latest.title || latest.research_title || latest.topic || "제목 없음") : "기록 없음";
  const latestDate = latest ? formatHistoryDate(latest.create_at) : "-";
  return `
    <div class="history-metric">
      <strong>${escapeHtml(total)}</strong>
      <span>전체</span>
    </div>
    <div class="history-metric success">
      <strong>${escapeHtml(success)}</strong>
      <span>성공/생성</span>
    </div>
    <div class="history-metric danger">
      <strong>${escapeHtml(failed)}</strong>
      <span>확인 필요</span>
    </div>
    <div class="history-latest">
      <span>최근 작업</span>
      <strong>${escapeHtml(latestTitle)}</strong>
      <em>${escapeHtml(latestDate)}</em>
    </div>
  `;
}

function historyStatusClass(status) {
  const normalized = String(status || "");
  if (normalized === "success" || normalized === "generated") return "success";
  if (normalized === "duplicate_retry") return "warning";
  if (normalized === "publishing" || normalized === "generating") return "info";
  return "danger";
}

function formatHistoryDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function closeHistoryModal() {
  state.historyModalOpen = false;
  const modal = $("#historyModal");
  if (modal) modal.hidden = true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderImages(images) {
  const grid = $("#imageGrid");
  grid.innerHTML = "";
  if (!images || images.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "생성된 이미지 파일이 없습니다. 아래 상태 메시지를 확인하세요.";
    grid.appendChild(empty);
    return;
  }

  for (const image of images) {
    const card = document.createElement("div");
    card.className = "thumb";
    card.title = image.path;
    card.innerHTML = `
      <img src="${image.url}" alt="${image.role === "title" ? "타이틀 이미지" : `본문 이미지 ${image.sequence}`}" />
      <span>${image.role === "title" ? "title" : `IMAGE ${image.sequence}`}</span>
      <code class="image-path">${escapeHtml(image.path)}</code>
      <div class="thumb-actions">
        <button type="button" data-action="open">열기</button>
        <button type="button" data-action="show">위치</button>
      </div>
    `;
    card.querySelector("[data-action='open']").addEventListener("click", () => window.blogAuto.openFile(image.path));
    card.querySelector("[data-action='show']").addEventListener("click", () => window.blogAuto.showFileInFolder(image.path));
    grid.appendChild(card);
  }
}

function renderImageNotes(imageNotes) {
  const notes = $("#imageNotes");
  notes.innerHTML = "";
  const usefulNotes = (imageNotes || []).filter(Boolean);
  for (const note of usefulNotes) {
    const item = document.createElement("div");
    item.className = note.includes("이미지") ? "note warn" : "note";
    item.textContent = note;
    notes.appendChild(item);
  }
}

function renderTistoryConnection(){
  const targets=state.accountStore.accounts.filter(a=>a.tistoryBlogId);
  const panel=$('#tistoryConnectionPanel');if(!panel)return;panel.hidden=!targets.length;
  const connection=state.accountStore.tistoryConnection || {};
  $('#tistoryConnectionStatus').textContent=connection.connected?(connection.status==='valid'?'공용 로그인 확인 완료':connection.loginStatus==='valid' && ['unknown','checking'].includes(connection.status)?'공용 로그인 확인됨 · 상태 갱신 중':connection.reason || '로그인 상태 확인 중'):'네이버 계정에 지정된 모든 티스토리 블로그가 한 로그인 공간을 사용합니다.';
  $('#pairTistoryButton').disabled=Boolean(connection.connected || connection.busy);
  $('#openTistoryButton').disabled=Boolean(connection.busy);
  $('#cancelTistoryButton').hidden=!connection.busy;
  $('#openTistoryButton').onclick=async()=>{
    try{await window.blogAuto.openTistoryChrome(targets[0].tistoryBlogId);if(connection.connected)await window.blogAuto.checkTistorySession(targets[0].tistoryBlogId);}
    catch(error){$('#tistoryConnectionStatus').textContent=error.message;}
  };
  $('#pairTistoryButton').onclick=async()=>{
    try{const pairing=await window.blogAuto.pairTistoryExtension(targets[0].tistoryBlogId);$('#pairingCode').textContent=pairing.code;$('#pairingHelp').textContent='티스토리 공용 Chrome의 BlogAuto에 복사된 연결 코드를 붙여넣으세요.';$('#extensionGuide').hidden=false;}
    catch(error){$('#tistoryConnectionStatus').textContent=error.message;}
  };
  $('#cancelTistoryButton').onclick=()=>window.blogAuto.cancelConnectionTask('tistory-shared');
}

function renderAccounts() {
  renderTistoryConnection();
  const bulkCheck=$('#bulkSessionCheckButton');
  if(bulkCheck){
    bulkCheck.disabled=state.bulkChecking || state.running || state.autoRunning || !state.accountStore.accounts.some(a=>a.checked!==false);
    bulkCheck.textContent=state.bulkChecking?'세션 확인 중':'세션 일괄 확인';
  }
  const list = $("#accountList");
  const manager = $("#accountManager");
  const toggle = $("#toggleAccountManagerButton");
  ensureSelectedAccount();
  if (manager && toggle) {
    manager.classList.toggle("collapsed", !state.accountManagerOpen);
    toggle.textContent = state.accountManagerOpen ? "접기" : "펼치기";
  }
  list.innerHTML = "";
  if (!state.accountStore.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 계정이 없습니다.";
    list.appendChild(empty);
    renderCategories();
    updateSessionNotice();
    return;
  }

  for (const account of state.accountStore.accounts) {
    const row = document.createElement("div");
    row.className = `account-row${account.id === state.accountStore.selectedAccountId ? " selected" : ""}`;
    row.dataset.accountId = account.id;
    const connected=account.connection?.connected===true;
    const ready=connected && loginDisplayConfirmed(account);
    const busy=Boolean(account.connection?.busy || openingAccounts.has(account.id) || checkingAccounts.has(account.id));
    row.innerHTML = `
      <button type="button" class="drag-handle account-drag-handle" draggable="true" aria-label="계정 순서 드래그" title="드래그해서 계정 순서 변경">⇅</button>
      <input class="list-check" type="checkbox" ${account.checked !== false ? "checked" : ""} aria-label="자동 발행 계정 선택" />
      <div class="account-main" role="button" tabindex="0" aria-label="${escapeHtml(accountDisplayName(account))} 계정 설정 선택" title="계정명을 누르면 이 계정의 설정과 카테고리를 편집합니다">
        <strong title="${escapeHtml(accountDisplayName(account))}">${escapeHtml(accountDisplayName(account))}</strong>
        <span>기존 Chrome 로그인 사용</span>
        <small>블로그 ${escapeHtml(account.blogId || account.naverId || "-")}</small>
        ${account.tistoryBlogId?`<small>티스토리 ${escapeHtml(account.tistoryBlogId)}</small>`:''}
        <small>카테고리 ${(account.categories || []).length}개</small>
      </div>
      <button type="button" class="ghost small danger-button account-delete" data-action="delete" ${state.running || state.autoRunning || state.bulkChecking?'disabled':''} title="${state.running || state.autoRunning || state.bulkChecking?'작업 종료 후 삭제할 수 있습니다.':'계정 삭제'}">삭제</button>
      <div class="account-status">${sessionBadge(account)}</div>
      <div class="account-actions">
        <button type="button" class="ghost small" data-action="open" ${ready || busy?'disabled':''} title="${ready?'로그인 확인이 완료되었습니다.':'계정 Chrome을 열고 로그인 상태를 확인합니다.'}">${openingAccounts.has(account.id)?'연결·로그인 확인 중':'블로그 열기 / 로그인'}</button>
        <button type="button" class="ghost small extension-connect" data-action="connect" ${connected || account.connection?.busy?'disabled':''} title="${connected?'확장프로그램이 이미 연결되어 있습니다.':'처음 설치하거나 확장을 다시 연결할 때 사용합니다.'}">확장프로그램 연결</button>
        <button type="button" class="ghost small" data-action="cancel" ${account.connection?.busy?'':'hidden'}>대기 취소</button>
      </div>
    `;
    const dragHandle = row.querySelector(".account-drag-handle");
    dragHandle.addEventListener("click", (event) => event.stopPropagation());
    dragHandle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      state.draggingAccountId = account.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", account.id);
    });
    dragHandle.addEventListener("dragend", (event) => {
      event.stopPropagation();
      state.draggingAccountId = "";
      row.classList.remove("dragging");
      list.querySelectorAll(".account-row.drag-over").forEach((item) => item.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", (event) => {
      if (!state.draggingAccountId || state.draggingAccountId === account.id) return;
      event.preventDefault();
      row.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove("drag-over");
      const draggedId = state.draggingAccountId || event.dataTransfer.getData("text/plain");
      state.draggingAccountId = "";
      if (moveAccountBefore(draggedId, account.id)) {
        await persistAccountOrder();
      }
    });
    row.addEventListener("click", () => selectAccount(account.id));
    row.querySelector("input").addEventListener("click", (event) => {
      event.stopPropagation();
      account.checked = event.target.checked;
      saveAccountStoreNow();
    });
    row.querySelector('.account-main').addEventListener('keydown',event=>{
      if(event.key==='Enter' || event.key===' '){event.preventDefault();event.stopPropagation();selectAccount(account.id);}
    });
    row.querySelector('[data-action="open"]').addEventListener('click',event=>{event.stopPropagation();openAccountAndCheck(account);});
    row.querySelector('[data-action="connect"]').addEventListener('click',event=>{event.stopPropagation();connectAccount(account);});
    row.querySelector('[data-action="cancel"]').addEventListener('click',async event=>{event.stopPropagation();await window.blogAuto.cancelConnectionTask(account.id);});
    row.querySelector("[data-action='delete']").addEventListener("click", async (event) => {
      event.stopPropagation();
      if (state.running || state.autoRunning || state.bulkChecking) return;
      const label = accountDisplayName(account);
      if (!window.confirm(`${label} 계정을 삭제할까요? 이 계정에 등록된 카테고리도 함께 삭제됩니다.`)) {
        return;
      }
      state.accountStore.accounts = state.accountStore.accounts.filter((item) => item.id !== account.id);
      const nextAccount = ensureSelectedAccount();
      if (nextAccount) {
        fillAccountForm(nextAccount);
        clearCategoryForm();
        state.categoryManagerOpen = true;
      } else {
        clearAccountForm();
        clearCategoryForm();
      }
      await saveAccountStoreNow();
      addLog({
        agent: "main",
        level: "warn",
        message: `${label} 계정과 종속 카테고리를 삭제했습니다.`,
        at: new Date().toISOString()
      });
    });
    list.appendChild(row);
  }
  renderCategories();
  updateSessionNotice();
}

function renderCategories() {
  const account = selectedAccount();
  const list = $("#categoryList");
  const manager = $("#categoryManager");
  manager.classList.toggle("collapsed", !state.categoryManagerOpen);
  list.innerHTML = "";
  if (!account) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "카테고리를 등록할 계정을 먼저 선택하세요.";
    list.appendChild(empty);
    return;
  }
  if (!account.categories || !account.categories.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 카테고리가 없습니다.";
    list.appendChild(empty);
    return;
  }

  for (const [index, category] of account.categories.entries()) {
    const row = document.createElement("div");
    row.className = `category-row${state.editingCategoryId === category.id ? " selected" : ""}`;
    row.dataset.categoryId = category.id;
    row.innerHTML = `
      <button type="button" class="drag-handle" draggable="true" aria-label="카테고리 순서 드래그" title="드래그해서 순서 변경">⇅</button>
      <input class="list-check" type="checkbox" ${category.checked !== false ? "checked" : ""} aria-label="자동 발행 카테고리 선택" />
      <div class="category-main">
        <strong>${escapeHtml(category.name)}</strong>
      </div>
      <div class="category-actions">
        <button type="button" class="ghost small" data-action="move-up" ${index === 0 ? "disabled" : ""}>위</button>
        <button type="button" class="ghost small" data-action="move-down" ${index === account.categories.length - 1 ? "disabled" : ""}>아래</button>
        <button type="button" class="ghost small" data-action="edit">수정</button>
        <button type="button" class="ghost small" data-action="delete">삭제</button>
      </div>
    `;
    const dragHandle = row.querySelector(".drag-handle");
    dragHandle.addEventListener("dragstart", (event) => {
      state.draggingCategoryId = category.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", category.id);
    });
    dragHandle.addEventListener("dragend", () => {
      state.draggingCategoryId = "";
      row.classList.remove("dragging");
      list.querySelectorAll(".category-row.drag-over").forEach((item) => item.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", (event) => {
      if (!state.draggingCategoryId || state.draggingCategoryId === category.id) return;
      event.preventDefault();
      row.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      row.classList.remove("drag-over");
      const draggedId = state.draggingCategoryId || event.dataTransfer.getData("text/plain");
      state.draggingCategoryId = "";
      if (moveCategoryBefore(account, draggedId, category.id)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("input").addEventListener("change", (event) => {
      category.checked = event.target.checked;
      saveAccountStoreNow();
    });
    row.querySelector("[data-action='move-up']").addEventListener("click", async () => {
      if (moveCategoryToIndex(account, category.id, index - 1)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("[data-action='move-down']").addEventListener("click", async () => {
      if (moveCategoryToIndex(account, category.id, index + 1)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("[data-action='edit']").addEventListener("click", () => {
      editCategory(category);
    });
    row.querySelector("[data-action='delete']").addEventListener("click", () => {
      account.categories = account.categories.filter((item) => item.id !== category.id);
      if (state.editingCategoryId === category.id) {
        clearCategoryForm();
      }
      saveAccountStoreNow();
      renderCategories();
    });
    list.appendChild(row);
  }
}

function selectAccount(accountId) {
  const account = state.accountStore.accounts.find((item) => item.id === accountId);
  if (!account) return;
  state.accountStore.selectedAccountId = account.id;
  fillAccountForm(account);
  clearCategoryForm();
  renderAccounts();
  saveAccountStoreNow();
}

function fillAccountForm(account) {
  $("#accountLabel").value = account?.label || "";
  $("#blogId").value = account?.blogId || account?.naverId || "";
  $("#accountTistoryBlogId").value = account?.tistoryBlogId || "";
  renderAccountSampleImage(account);
}

function accountImageStatusLabel(account) {
  if (!account?.sampleImagePath) return "기본 이미지 스타일";
  const status = account.imageStylePromptStatus || (account.imageStylePrompt ? "ready" : "missing");
  if (status === "ready") return "Custom style prompt ready";
  if (status === "stale") return "Image changed - prompt will regenerate";
  if (status === "failed") return `Prompt generation failed${account.imageStylePromptError ? `: ${account.imageStylePromptError}` : ""}`;
  return "Prompt will be generated on next run";
}

function renderAccountSampleImage(account = selectedAccount()) {
  const preview = $("#accountSampleImagePreview");
  const status = $("#accountImagePromptStatus");
  const chooseButton = $("#chooseAccountSampleImageButton");
  const deleteButton = $("#deleteAccountSampleImageButton");
  if (!preview || !status) return;
  preview.innerHTML = "";
  if (account?.sampleImageUrl) {
    const image = document.createElement("img");
    image.src = account.sampleImageUrl;
    image.alt = "Account sample image";
    preview.appendChild(image);
  } else {
    const empty = document.createElement("span");
    empty.textContent = "샘플 없음";
    preview.appendChild(empty);
  }
  status.textContent = accountImageStatusLabel(account);
  if (chooseButton) chooseButton.disabled = !account;
  if (deleteButton) deleteButton.disabled = !account || !account.sampleImagePath;
}

function clearAccountForm() {
  fillAccountForm(null);
}

function setCategoryButtonLabel() {
  const button = $("#addCategoryButton");
  if (button) {
    button.textContent = state.editingCategoryId ? "카테고리 수정" : "카테고리 등록";
  }
}

function fillCategoryForm(category = null) {
  $("#categoryName").value = category?.name || "";
  $("#categoryKeyword").value = category?.keyword || "";
  $("#categoryExcludedTopics").value = category?.excludedTopics || "";
  $("#categoryPublishPurpose").value = category?.publishPurpose || "";
  $("#categoryPreferredTone").value = category?.preferredTone || "";
  $("#categoryFreshnessLevel").value = category?.freshnessLevel || "auto";
  $("#categorySearchChannel").value = normalizeSearchChannel(category?.searchChannel);
  const searchProviders = categorySearchProviders(category);
  $("#categoryPrimarySearchProvider").value = searchProviders.primarySearchProvider;
  $("#categoryFallbackSearchProvider").value = searchProviders.fallbackSearchProvider;
  $("#categoryTrustBlogAsSource").checked = category?.trustBlogAsSource === true;
}

function findCategoryById(account, categoryId) {
  const id = String(categoryId || "");
  if (!id || !Array.isArray(account?.categories)) return null;
  return account.categories.find((category) => String(category.id || "") === id) || null;
}

function clearCategoryForm() {
  state.editingCategoryId = "";
  fillCategoryForm(null);
  setCategoryButtonLabel();
}

function editCategory(category) {
  if (!category) return;
  state.editingCategoryId = category.id || "";
  state.categoryManagerOpen = true;
  const currentCategory = findCategoryById(selectedAccount(), state.editingCategoryId) || category;
  renderCategories();
  fillCategoryForm(currentCategory);
  setCategoryButtonLabel();
  $("#categoryName")?.focus();
}

function hasCategoryName(category) {
  return Boolean(String(category?.name || "").trim());
}

function hasCategoryKeyword(category) {
  return Boolean(String(category?.keyword || "").trim());
}

function autoTargetKey(target) {
  const accountId = String(target?.account?.id || "");
  const categoryId = String(target?.category?.id || target?.category?.name || "");
  return `${accountId}::${categoryId}`;
}

function setPendingAutoTarget(target) {
  state.autoPendingSessionTarget = {
    key: autoTargetKey(target),
    accountId: String(target?.account?.id || ""),
    categoryId: String(target?.category?.id || target?.category?.name || ""),
    accountLabel: accountDisplayName(target?.account),
    categoryName: String(target?.category?.name || "")
  };
}

function clearPendingAutoTarget(key = "") {
  if (!key || state.autoPendingSessionTarget?.key === key) {
    state.autoPendingSessionTarget = null;
  }
}

function findAutoTargetIndex(targets, key) {
  const index = targets.findIndex((target) => autoTargetKey(target) === key);
  return index >= 0 ? index : 0;
}

function firstAutoTargetForAccount(accountId) {
  const id = String(accountId || "");
  return getAutoTargets().find((target) => String(target?.account?.id || "") === id) || null;
}

function readTistoryTargetInput(){
  const input=$('#accountTistoryBlogId');
  const id=input.value.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\.tistory\.com\/?$/,'');
  if(id && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id)){
    input.setCustomValidity('티스토리 Blog ID 또는 https://블로그ID.tistory.com 주소를 입력하세요.');input.reportValidity();return null;
  }
  input.setCustomValidity('');return id;
}

async function saveAccountStoreNow() {
  state.accountStore = await window.blogAuto.saveAccountStore(state.accountStore);
  renderAccounts();
}

function moveAccountToIndex(accountId, targetIndex) {
  const accounts = state.accountStore.accounts || [];
  const fromIndex = accounts.findIndex((account) => account.id === accountId);
  if (fromIndex < 0) return false;
  const boundedTarget = Math.max(0, Math.min(targetIndex, accounts.length - 1));
  if (fromIndex === boundedTarget) return false;
  const [account] = accounts.splice(fromIndex, 1);
  accounts.splice(boundedTarget, 0, account);
  return true;
}

function moveAccountBefore(accountId, beforeAccountId) {
  const accounts = state.accountStore.accounts || [];
  if (accountId === beforeAccountId) return false;
  const fromIndex = accounts.findIndex((account) => account.id === accountId);
  const targetIndex = accounts.findIndex((account) => account.id === beforeAccountId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return moveAccountToIndex(accountId, adjustedTarget);
}

async function persistAccountOrder() {
  await saveAccountStoreNow();
}

function moveCategoryToIndex(account, categoryId, targetIndex) {
  if (!account || !Array.isArray(account.categories)) return false;
  const fromIndex = account.categories.findIndex((category) => category.id === categoryId);
  if (fromIndex < 0) return false;
  const boundedTarget = Math.max(0, Math.min(targetIndex, account.categories.length - 1));
  if (fromIndex === boundedTarget) return false;
  const [category] = account.categories.splice(fromIndex, 1);
  account.categories.splice(boundedTarget, 0, category);
  return true;
}

function moveCategoryBefore(account, categoryId, beforeCategoryId) {
  if (!account || categoryId === beforeCategoryId || !Array.isArray(account.categories)) return false;
  const fromIndex = account.categories.findIndex((category) => category.id === categoryId);
  const targetIndex = account.categories.findIndex((category) => category.id === beforeCategoryId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return moveCategoryToIndex(account, categoryId, adjustedTarget);
}

async function persistCategoryOrder(account) {
  await saveAccountStoreNow();
  renderCategories();
}

function normalizeAgentModels(models = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_MODELS).map(([agent, fallback]) => {
    const value = String(models?.[agent] || fallback);
    return [agent, VALID_AGENT_MODEL_VALUES.has(value) ? value : fallback];
  }));
}

function currentAgentModels() {
  return normalizeAgentModels(Object.fromEntries(Object.entries(AGENT_MODEL_SELECTORS).map(([agent, selector]) => (
    [agent, $(selector)?.value || DEFAULT_AGENT_MODELS[agent]]
  ))));
}

function applyAgentModels(models = {}) {
  const normalized = normalizeAgentModels(models);
  for (const [agent, selector] of Object.entries(AGENT_MODEL_SELECTORS)) {
    const control = $(selector);
    if (control) control.value = normalized[agent];
  }
}

function collectForm(target = {}) {
  const account = target.account || selectedAccount();
  const category = target.category
    || (account?.categories || []).find((item) => item.checked !== false && hasCategoryName(item) && hasCategoryKeyword(item))
    || (account?.categories || []).find((item) => item.checked !== false);
  const useSelectedAccount = Boolean(target.account || account);
  const searchProviders = categorySearchProviders(category);
  return {
    accountId: account?.id || "",
    blogId: useSelectedAccount ? (account?.blogId || account?.naverId || "") : $("#blogId").value.trim(),
    topicMode: "auto",
    repeatTermMinutes: Number($("#repeatTermMinutes").value || 60),
    crossPublish: $("#crossPublish").checked,
    topic: "",
    category: category?.name || "",
    keyword: category?.keyword || "",
    excludedTopics: category?.excludedTopics || "",
    publishPurpose: category?.publishPurpose || "",
    preferredTone: category?.preferredTone || "",
    freshnessLevel: category?.freshnessLevel || "auto",
    searchChannel: normalizeSearchChannel(category?.searchChannel),
    trustBlogAsSource: category?.trustBlogAsSource === true,
    codexCmdPath: "codex.cmd",
    codexModel: normalizeCodexModel($("#codexModel")?.value),
    primarySearchProvider: searchProviders.primarySearchProvider,
    fallbackSearchProvider: searchProviders.fallbackSearchProvider,
    naverSearchUrl: DEFAULT_NAVER_SEARCH_URL,
    googleSearchUrl: DEFAULT_GOOGLE_SEARCH_URL,
    naverEditorDomNotes: "",
    publishAfterGenerate: true,
    publishToTistoryAfterNaver: Boolean(account?.tistoryBlogId),
    tistoryBlogId: account?.tistoryBlogId || "",
    publishVisibility: $("#publishVisibility").value,
    publishPrivate: $("#publishVisibility").value !== "public",
    publishScheduleMode: $("#publishScheduleMode").value,
    reserveAfterHours: Number($("#reserveAfterHours").value || 0),
    includeTitleImage: $("#includeTitleImage").checked,
    titleImageAspectRatio: normalizeImageAspectRatio($("#titleImageAspectRatio").value),
    bodyImageAspectRatio: normalizeImageAspectRatio($("#bodyImageAspectRatio").value),
    maxBodyImages: Number($("#maxBodyImages").value),
    breakSentencesInBody: true,
    agentModels: currentAgentModels(),
    excludedKeywordLanes: Array.isArray(target.excludedKeywordLanes) ? target.excludedKeywordLanes : [],
    failOnLoginRequired: target.failOnLoginRequired === true
  };
}

function applySettings(settings) {
  const map = {
    repeatTermMinutes: "#repeatTermMinutes",
    tistoryBlogId: "#tistoryBlogId",
    publishVisibility: "#publishVisibility",
    publishScheduleMode: "#publishScheduleMode",
    reserveAfterHours: "#reserveAfterHours",
    maxBodyImages: "#maxBodyImages"
  };
  for (const [key, selector] of Object.entries(map)) {
    if (settings[key] !== undefined && $(selector)) {
      $(selector).value = settings[key];
    }
  }
  $("#crossPublish").checked = settings.crossPublish === true;
  if ($("#publishToTistoryAfterNaver")) $("#publishToTistoryAfterNaver").checked = false;
  state.tistorySessionStatus = settings.tistorySessionStatus || "unknown";
  $("#includeTitleImage").checked = settings.includeTitleImage !== false;
  $("#titleImageAspectRatio").value = normalizeImageAspectRatio(settings.titleImageAspectRatio || settings.imageAspectRatio);
  $("#bodyImageAspectRatio").value = normalizeImageAspectRatio(settings.bodyImageAspectRatio || settings.imageAspectRatio);
  if ($("#codexModel")) $("#codexModel").value = normalizeCodexModel(settings.codexModel);
  applyAgentModels(settings.agentModels);
  if (settings.publishPrivate === false) $("#publishVisibility").value = "public";
  updateModeControls();
}

async function saveSettingsNow() {
  $("#settingsState").textContent = "설정 저장 중";
  const form = collectForm();
  await window.blogAuto.saveSettings({
    blogId: form.blogId,
    topic: form.topic,
    keyword: form.keyword,
    category: form.category,
    primarySearchProvider: form.primarySearchProvider,
    fallbackSearchProvider: form.fallbackSearchProvider,
    naverSearchUrl: form.naverSearchUrl,
    googleSearchUrl: form.googleSearchUrl,
    naverEditorDomNotes: form.naverEditorDomNotes,
    publishAfterGenerate: form.publishAfterGenerate,
    publishToTistoryAfterNaver: form.publishToTistoryAfterNaver,
    tistoryBlogId: form.tistoryBlogId,
    publishPrivate: form.publishPrivate,
    topicMode: form.topicMode,
    repeatTermMinutes: form.repeatTermMinutes,
    crossPublish: form.crossPublish,
    publishVisibility: form.publishVisibility,
    publishScheduleMode: form.publishScheduleMode,
    reserveAfterHours: form.reserveAfterHours,
    includeTitleImage: form.includeTitleImage,
    titleImageAspectRatio: form.titleImageAspectRatio,
    bodyImageAspectRatio: form.bodyImageAspectRatio,
    maxBodyImages: form.maxBodyImages,
    breakSentencesInBody: form.breakSentencesInBody,
    codexModel: form.codexModel,
    agentModels: form.agentModels
  });
  await saveAccountStoreNow();
  $("#settingsState").textContent = "설정 저장됨";
}

function scheduleSettingsSave() {
  window.clearTimeout(state.saveTimer);
  $("#settingsState").textContent = "변경 감지";
  state.saveTimer = window.setTimeout(() => {
    saveSettingsNow().catch((error) => {
      $("#settingsState").textContent = "설정 저장 실패";
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
      refreshPendingPublishButton();
    });
  }, 450);
}

function updateModeControls() {
  const isPrivatePublish = $("#publishVisibility").value !== "public";
  if (isPrivatePublish && $("#publishScheduleMode").value === "reserve") {
    $("#publishScheduleMode").value = "now";
  }
  $("#publishScheduleMode").disabled = isPrivatePublish;
  $("#reserveAfterLabel").style.display = !isPrivatePublish && $("#publishScheduleMode").value === "reserve" ? "grid" : "none";
}

function getAutoTargets() {
  const groups = state.accountStore.accounts.filter(account => account.checked !== false)
    .map(account => (account.categories || [])
      .filter(category => category.checked !== false && hasCategoryName(category) && hasCategoryKeyword(category))
      .map(category => ({ account, category })));
  if (!$("#crossPublish").checked) return groups.flat();
  const targets = [];
  const rounds = Math.max(0, ...groups.map(group => group.length));
  for (let index = 0; index < rounds; index++) {
    for (const group of groups) if (group[index]) targets.push(group[index]);
  }
  return targets;
}

function updateRunControls() {
  const busy = state.running || state.autoRunning || state.bulkChecking;
  const bulkCheck=$('#bulkSessionCheckButton');
  if(bulkCheck)bulkCheck.disabled=busy || !state.accountStore.accounts.some(a=>a.checked!==false);
  $("#crossPublish").disabled = busy;
  document.querySelectorAll('.account-row [data-action="delete"]').forEach(button => {
    button.disabled = busy;
    button.title = busy ? '작업 종료 후 삭제할 수 있습니다.' : '계정 삭제';
  });
}

function allNaverSessionsExpired(targets) {
  return Boolean(targets.length) && targets.every((target) => target.account?.sessionStatus === "expired");
}

function nextDifferentAccountIndex(targets, index) {
  if (!targets.length) return 0;
  const currentAccountId = targets[index % targets.length]?.account?.id || "";
  for (let offset = 1; offset <= targets.length; offset += 1) {
    const nextIndex = (index + offset) % targets.length;
    if ((targets[nextIndex]?.account?.id || "") !== currentAccountId) {
      return nextIndex;
    }
  }
  return index;
}

function delayAuto(minutes) {
  const ms = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (state.autoDelayWake === finish) state.autoDelayWake = null;
      resolve();
    };
    const started = Date.now();
    state.autoDelayWake = finish;
    const tick = () => {
      if (!state.autoRunning) {
        finish();
        return;
      }
      const remaining = Math.max(0, ms - (Date.now() - started));
      setRunState("generated", `다음 발행까지 ${Math.ceil(remaining / 1000)}초`);
      if (remaining <= 0) finish();
      else window.setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
  });
}

function waitForAccountSessionOrTerm(accountId, minutes) {
  const waitingAccountId = String(accountId || "");
  const ms = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Promise((resolve) => {
    if (state.autoResumeAccountId === waitingAccountId) {
      state.autoResumeAccountId = "";
      resolve("session");
      return;
    }
    let settled = false;
    const started = Date.now();
    const wake = () => {
      if (state.autoResumeAccountId === waitingAccountId) {
        finish("session");
      }
    };
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (state.autoDelayWake === wake) state.autoDelayWake = null;
      if (reason === "session") state.autoResumeAccountId = "";
      resolve(reason);
    };
    state.autoDelayWake = wake;
    const tick = () => {
      if (!state.autoRunning) {
        finish("stopped");
        return;
      }
      if (state.autoResumeAccountId === waitingAccountId) {
        finish("session");
        return;
      }
      const remaining = Math.max(0, ms - (Date.now() - started));
      setRunState("session_expired", `세션 확인 대기 중 ${Math.ceil(remaining / 1000)}초`);
      if (remaining <= 0) {
        finish("term");
        return;
      }
      window.setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
  });
}

function progressKey(target){return target.account.id+':'+target.category.id;}
function renderTargetProgress(){
  const panel=$('#targetProgress');if(!panel)return;
  const rows=[];
  if(state.activeTarget){
    const current=state.targetProgress?.[progressKey(state.activeTarget)];
    if(current)rows.push({...current,slot:'현재'});
  }
  if(state.autoRunning && state.nextTarget)rows.push({account:accountDisplayName(state.nextTarget.account),category:state.nextTarget.category.name,status:'대기',slot:'다음',detail:''});
  panel.hidden=!rows.length;
  panel.innerHTML='<div class="target-progress-head"><strong>계정 · 카테고리 작업 현황</strong></div>'+rows.map(row=>'<div class="target-progress-row"><span><b>'+row.slot+'</b> · '+escapeHtml(row.account)+'</span><span>'+escapeHtml(row.category)+'</span><span class="badge '+(row.status==='완료'?'success':row.status==='진행 중'?'info':'warning')+'">'+escapeHtml(row.status)+'</span><small title="'+escapeHtml(row.detail || '')+'">'+escapeHtml(row.detail || '')+'</small></div>').join('');
}
function setTargetProgress(target,status,detail=''){
  state.targetProgress ||= {};
  state.targetProgress[progressKey(target)]={account:accountDisplayName(target.account),category:target.category.name,status,detail};
  renderTargetProgress();
}
function resetJobPreview(target){
  state.currentJobId='';
  $('#articlePreview').value='';$('#selectedTitle').textContent='주제 선정 중';
  $('#articleMeta').textContent=accountDisplayName(target.account)+' · '+target.category.name+' · 새 작업 시작';
  renderImages([]);renderImageNotes([]);clearAgentLogs();
}
function autoResultAction(result){
  if(result?.status==='session_expired')return 'login';
  if(['success','generated','duplicate_retry'].includes(result?.status))return 'next';
  if(result?.status==='failed' && result.failureKind==='quality')return 'next';
  return 'stop';
}
async function startAutoPublishing(startTargetKey = '') {
  if(!getAutoTargets().length)throw new Error('계정과 카테고리·키워드를 등록하고 자동 발행할 대상을 체크하세요.');
  const pending=await window.blogAuto.getPendingPublishState();
  if(pending.target){
    const target=getAutoTargets().find(item=>item.account.id===pending.target.accountId && String(item.account.blogId || item.account.naverId || '')===pending.target.blogId && item.category.name===pending.target.category);
    if(!target)throw new Error('중단된 작업의 계정·카테고리를 선택해 주세요. 대상이 변경되었다면 기존 작업 취소 버튼을 눌러 취소하세요.');
    startTargetKey=autoTargetKey(target);
  }
  state.running=true;state.autoRunning=true;
  state.targetProgress={};
  $('#startButton').disabled=true;updateRunControls();$('#stopAutoButton').disabled=false;
  await saveSettingsNow();setTokenTotal(0);
  addLog({agent:"main",message:$("#crossPublish").checked?"교차발행 시작 · 각 계정의 선택 카테고리를 한 개씩 번갈아 진행합니다.":"순차발행 시작 · 한 계정의 선택 카테고리를 마친 뒤 다음 계정으로 이동합니다."});
  let index=startTargetKey?findAutoTargetIndex(getAutoTargets(),startTargetKey):0;
  try{
    while(state.autoRunning){
      const targets=getAutoTargets();if(!targets.length)break;
      index%=targets.length;const target=targets[index];
      state.activeTarget=target;
      state.nextTarget=targets[(index+1)%targets.length];
      resetJobPreview(target);
      setTargetProgress(target,'진행 중');
      addLog({agent:'main',message:accountDisplayName(target.account)+' · '+target.category.name+' 작업 시작'});
      const result=await runAutoStartJob(collectForm({account:target.account,category:target.category,failOnLoginRequired:true}));
      setTargetProgress(target,result?.status==='success'?'완료':result?.status==='session_expired'?'로그인 대기':result?.status==='publish_uncertain'?'발행 확인 필요':'실패',result?.reason || '');
      if(autoResultAction(result)==='stop'){
        state.autoRunning=false;state.nextTarget=null;
        const reason=result?.reason || '실행 오류를 확인해 주세요.';
        setTargetProgress(target,'오류 · 자동 중지',reason);
        setRunState('failed','오류로 자동 중지 · 확인 후 작업 시작');
        addLog({agent:'main',level:'error',message:reason+' · 자동 진행을 중지했습니다. 문제 해결 후 작업 시작을 눌러 주세요.'});break;
      }
      if(result?.status==='session_expired'){
        state.autoPausedForSession=true;state.autoWaitingSessionAccountId=target.account.id;
        setRunState('waiting_login',accountDisplayName(target.account)+' · 연결 및 로그인 대기');
        while(state.autoRunning){
          const store=await window.blogAuto.getConnections();const account=store.accounts.find(a=>a.id===target.account.id);
          if(!account)break;
          if(account.sessionStatus==='valid')break;
          await new Promise(resolve=>window.setTimeout(resolve,2000));
        }
        state.autoPausedForSession=false;state.autoWaitingSessionAccountId='';
        continue;
      }
      index++;
      state.nextTarget=targets[index%targets.length];renderTargetProgress();
      // Rejected content advances immediately within this round. At the end of
      // the round retain the interval so all-rejected queues cannot spin forever.
      const rejected=result?.failureKind==='quality' || result?.status==='duplicate_retry';
      if(state.autoRunning && (!rejected || index%targets.length===0))await delayAuto(Number($('#repeatTermMinutes').value || 60));
    }
  }catch(error){
    state.autoRunning=false;state.nextTarget=null;
    if(state.activeTarget)setTargetProgress(state.activeTarget,'오류 · 자동 중지',error.message);
    setRunState('failed','오류로 자동 중지 · 확인 후 작업 시작');
    addLog({agent:'main',level:'error',message:error.message+' · 자동 진행을 중지했습니다. 문제 해결 후 작업 시작을 눌러 주세요.'});
  }finally{
    state.autoRunning=false;state.running=false;state.autoPausedForSession=false;
    state.autoWaitingSessionAccountId='';state.autoResumeAccountId='';state.autoPendingSessionTarget=null;
    if(state.activeTarget && state.targetProgress?.[progressKey(state.activeTarget)]?.status==='진행 중')setTargetProgress(state.activeTarget,'중지');
    state.nextTarget=null;renderTargetProgress();
    $('#startButton').disabled=false;updateRunControls();$('#stopAutoButton').disabled=true;
  }
}

async function startTistoryTestPublish() {
  const form = collectForm();
  if (!form.tistoryBlogId) throw new Error("티스토리 블로그 ID가 필요합니다.");
  state.running = true;
  $("#startButton").disabled = true;updateRunControls();
  setTistoryTestButtonDisabled(true);
  await saveSettingsNow();
  setTokenTotal(0);
  $("#articlePreview").value = "";
  $("#selectedTitle").textContent = "티스토리 테스트";
  renderImages([]);
  renderImageNotes([]);
  setRunState("publishing", "티스토리 테스트");
  try {
    const result = await window.blogAuto.testTistoryPublish({
      ...form,
      failOnLoginRequired: false
    });
    $("#articlePreview").value = result.article || $("#articlePreview").value;
    $("#articleMeta").textContent = result.title || "티스토리 테스트 완료";
    if (result.title) $("#selectedTitle").textContent = result.title;
    renderImages(result.images || []);
    renderImageNotes(result.imageNotes || []);
  } finally {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;updateRunControls();
      setTistoryTestButtonDisabled(false);
    }
  }
}

async function boot() {
  const initial = await window.blogAuto.getInitialData();
  $("#runtimePath").textContent = initial.runtimeRoot;
  state.chrome = initial.chrome || state.chrome;
  state.accountStore = initial.accountStore || state.accountStore;
  applySettings(initial.settings || {});
  setCodexRateLimits(initial.settings?.codexRateLimits || null);
  refreshCodexUsageOnStartup();
  showStartupNoticeIfNeeded();
  renderAccounts();
  const account = selectedAccount();
  if (account) selectAccount(account.id);
  renderHistory(initial.history || []);
  if(initial.pendingPreview){
    const draft=initial.pendingPreview;
    $('#articlePreview').value=draft.article || '';$('#selectedTitle').textContent=draft.title || '';
    $('#articleMeta').textContent=draft.status==='publish_uncertain'?'이전 발행 결과 확인 필요':'저장된 글 복구됨 · 같은 계정·카테고리에서 작업 시작 시 생성 없이 발행 재시도';
    renderImages(draft.images || []);
  }
  await refreshPendingPublishButton();
  $('#cancelPendingJobButton').addEventListener('click',async()=>{
    const button=$('#cancelPendingJobButton');button.dataset.cancelling='true';button.disabled=true;
    try{
      const result=await window.blogAuto.cancelPendingPublish();
      state.autoRunning=false;state.autoDelayWake?.();
      $('#articleMeta').textContent='기존 작업 취소됨 · 새 작업을 시작할 수 있습니다.';
      setRunState('idle','대기');
      addLog({level:'info',message:result.cancelled?'기존 작업을 취소했습니다. 보류 원고와 불확실 상태를 해제했습니다. 기록과 파일은 보존됩니다.':'취소할 기존 작업이 없습니다.',at:new Date().toISOString()});
    }catch(error){addLog({level:'error',message:error.message,at:new Date().toISOString()});}
    finally{delete button.dataset.cancelling;await refreshPendingPublishButton();}
  });
  if(initial.bridgeError){$('#sessionNotice').hidden=false;$('#sessionNoticeText').textContent=initial.bridgeError;}

  window.blogAuto.onAccountsUpdate((store) => {
    state.accountStore = store;
    for(const account of store.accounts)if(account.sessionStatus==='valid')signalAutoSessionResume(account.id);
    renderAccounts();

  });
  window.blogAuto.onLog(addLog);
  window.blogAuto.onStatus((payload) => {
    if(state.activeTarget)setTargetProgress(state.activeTarget,'진행 중',payload.detail || payload.status);
    state.currentJobId = payload.jobId;
    setRunState(payload.status, payload.detail || payload.status);
    refreshPendingPublishButton();
  });
  window.blogAuto.onTokens((payload) => {
    setTokenTotal(payload.total || 0);
    if (payload.rateLimits) setCodexRateLimits(payload.rateLimits);
  });
  window.blogAuto.onPreview((payload) => {
    $("#articlePreview").value = payload.article || "";
    $("#articleMeta").textContent = payload.previewStage === 'humanizing'
      ? `본문 ${payload.writerAttempt}차 작성 완료 · 문장 다듬는 중`
      : payload.previewStage === 'reviewing'
      ? `본문 ${payload.writerAttempt}차 작성 완료 · 검수 중`
      : payload.previewStage === 'approved' ? '본문 검수 통과 · 후속 작업 준비 중' : payload.title || "본문 생성 완료";
    if (payload.title) $("#selectedTitle").textContent = payload.title;
    if (payload.tokenUsage) setTokenTotal(payload.tokenUsage.total || 0);
    if (payload.tokenUsage?.rateLimits) setCodexRateLimits(payload.tokenUsage.rateLimits);
    renderImages(payload.images || []);
    renderImageNotes(payload.imageNotes || []);
  });
  window.blogAuto.onSelectedTitle((payload) => {
    $("#selectedTitle").textContent = payload.title || "제목 선정 보류";
    $("#articleMeta").textContent = payload.verdict || payload.status || "제목 선정 완료";
  });
  window.blogAuto.onComplete((payload) => {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;updateRunControls();
      setTistoryTestButtonDisabled(false);
    }
    setRunState(payload.status, payload.status);
    $("#articlePreview").value = payload.article || $("#articlePreview").value;
    $("#articleMeta").textContent = payload.title || payload.status || "완료";
    if (payload.title) $("#selectedTitle").textContent = payload.title;
    if (payload.tokenUsage) setTokenTotal(payload.tokenUsage.total || 0);
    if (payload.tokenUsage?.rateLimits) setCodexRateLimits(payload.tokenUsage.rateLimits);
    renderImages(payload.images || []);
    renderImageNotes(payload.imageNotes || []);
    renderHistory(payload.history || []);
    refreshPendingPublishButton();
    if(payload.status==='publish_uncertain')addLog({level:'warn',message:"게시글·예약 목록을 확인한 뒤 본문 오른쪽 상단의 ‘기존 작업 취소’ 버튼을 눌러 해제하세요."});
  });

  $("#jobForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.running) return;
    try {
      await startAutoPublishing();
    } catch (error) {
      state.running = false;
      state.autoRunning = false;
      state.autoPausedForSession = false;
      state.autoWaitingSessionAccountId = "";
      state.autoResumeAccountId = "";
      state.autoPendingSessionTarget = null;
      $("#startButton").disabled = false;updateRunControls();
      $("#stopAutoButton").disabled = true;
      setRunState("failed", "실패");
      refreshPendingPublishButton();
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    }
  });

  $("#tistoryTestButton")?.addEventListener("click", async () => {
    if (state.running || state.autoRunning || state.bulkChecking) return;
    try {
      await startTistoryTestPublish();
    } catch (error) {
      state.running = false;
      state.autoRunning = false;
      $("#startButton").disabled = false;updateRunControls();
      setTistoryTestButtonDisabled(false);
      $("#stopAutoButton").disabled = true;
      setRunState("failed", "티스토리 테스트 실패");
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    }
  });

  $("#addAccountButton").addEventListener("click", async () => {
    const tistoryBlogId=readTistoryTargetInput();if(tistoryBlogId===null)return;
    const blogId = $("#blogId").value.trim();
    if (!blogId) {
      addLog({ level: "error", message: "Blog ID를 입력하세요.", at: new Date().toISOString() });
      return;
    }
    const duplicate = state.accountStore.accounts.find((account) => String(account.blogId || account.naverId || "").trim() === blogId);
    if (duplicate) {
      addLog({ level: "error", message: "이미 등록된 Blog ID입니다. 기존 계정을 선택한 뒤 수정하세요.", at: new Date().toISOString() });
      return;
    }
    const account = {
      id: makeId("acct"),
      label: $("#accountLabel").value.trim() || blogId,
      blogId,
      tistoryBlogId,
      sampleImagePath: "",
      sampleImageHash: "",
      sampleImageUpdatedAt: "",
      imageStylePrompt: "",
      imageStylePromptUpdatedAt: "",
      imageStylePromptStatus: "missing",
      imageStylePromptSourceImageHash: "",
      imageStylePromptError: "",
      checked: true,
      sessionStatus: "unknown",
      sessionCheckedAt: "",
      categories: []
    };
    state.accountStore.accounts.push(account);
    state.accountStore.selectedAccountId = account.id;
    state.categoryManagerOpen = true;
    clearCategoryForm();
    await saveAccountStoreNow();
    $("#categoryName")?.focus();
  });

  $("#updateAccountButton").addEventListener("click", async () => {
    const tistoryBlogId=readTistoryTargetInput();if(tistoryBlogId===null)return;
    const account = selectedAccount();
    if (!account) {
      addLog({ level: "error", message: "수정할 계정을 먼저 선택하세요.", at: new Date().toISOString() });
      return;
    }
    const blogId = $("#blogId").value.trim();
    if (!blogId) {
      addLog({ level: "error", message: "Blog ID를 입력하세요.", at: new Date().toISOString() });
      return;
    }
    const duplicate = state.accountStore.accounts.find((item) => item.id !== account.id && String(item.blogId || item.naverId || "").trim() === blogId);
    if (duplicate) {
      addLog({ level: "error", message: "다른 계정에 이미 등록된 Blog ID입니다.", at: new Date().toISOString() });
      return;
    }
    account.tistoryBlogId = tistoryBlogId;
    account.label = $("#accountLabel").value.trim() || blogId;
    account.blogId = blogId;
    await saveAccountStoreNow();
  });

  $("#clearAccountFormButton").addEventListener("click", () => {
    clearAccountForm();
    addLog({ level: "info", message: "신규 계정 입력을 시작합니다.", at: new Date().toISOString() });
  });

  $("#chooseAccountSampleImageButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account) {
      addLog({ level: "error", message: "Select an account before adding a sample image.", at: new Date().toISOString() });
      return;
    }
    state.accountStore = await window.blogAuto.chooseAccountSampleImage(account.id);
    renderAccounts();
    fillAccountForm(selectedAccount());
    scheduleSettingsSave();
  });

  $("#deleteAccountSampleImageButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account || !account.sampleImagePath) return;
    if (!window.confirm("Delete the sample image and custom image prompt?")) return;
    state.accountStore = await window.blogAuto.deleteAccountSampleImage(account.id);
    renderAccounts();
    fillAccountForm(selectedAccount());
    scheduleSettingsSave();
  });

  $("#toggleAccountManagerButton").addEventListener("click", () => {
    state.accountManagerOpen = !state.accountManagerOpen;
    if (state.accountManagerOpen) {
      fillAccountForm(selectedAccount());
    }
    renderAccounts();
  });

  $("#bulkSessionCheckButton").addEventListener("click", checkSelectedAccountSessions);

  $("#toggleCategoryManagerButton").addEventListener("click", () => {
    clearCategoryForm();
    state.categoryManagerOpen = !state.categoryManagerOpen;
    renderCategories();
  });
  $("#categoryPrimarySearchProvider").addEventListener("change", () => {
    const primary = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    const fallback = normalizeSearchProvider($("#categoryFallbackSearchProvider").value, fallbackSearchProviderFor(primary));
    if (fallback === primary) {
      $("#categoryFallbackSearchProvider").value = fallbackSearchProviderFor(primary);
    }
  });
  $("#categoryFallbackSearchProvider").addEventListener("change", () => {
    const primary = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    const fallback = normalizeSearchProvider($("#categoryFallbackSearchProvider").value, fallbackSearchProviderFor(primary));
    if (fallback === primary) {
      $("#categoryPrimarySearchProvider").value = fallbackSearchProviderFor(fallback);
    }
  });
  $("#addCategoryButton").addEventListener("click", async () => {
    const account = selectedAccount();
    const name = $("#categoryName").value.trim();
    const keyword = $("#categoryKeyword").value.trim();
    const excludedTopics = $("#categoryExcludedTopics").value.trim();
    const publishPurpose = $("#categoryPublishPurpose").value.trim();
    const preferredTone = $("#categoryPreferredTone").value.trim();
    const freshnessLevel = $("#categoryFreshnessLevel").value || "auto";
    const searchChannel = normalizeSearchChannel($("#categorySearchChannel").value);
    const primarySearchProvider = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    let fallbackSearchProvider = normalizeSearchProvider(
      $("#categoryFallbackSearchProvider").value,
      fallbackSearchProviderFor(primarySearchProvider)
    );
    if (fallbackSearchProvider === primarySearchProvider) {
      fallbackSearchProvider = fallbackSearchProviderFor(primarySearchProvider);
      $("#categoryFallbackSearchProvider").value = fallbackSearchProvider;
    }
    const trustBlogAsSource = $("#categoryTrustBlogAsSource").checked === true;
    if (!account) return;
    if (!name || !keyword) {
      addLog({
        level: "warn",
        message: "카테고리를 등록하려면 카테고리명과 검색 키워드를 모두 입력하세요.",
        at: new Date().toISOString()
      });
      setRunState("failed", "카테고리명/키워드 필요");
      return;
    }
    account.categories = account.categories || [];
    const editingId = state.editingCategoryId;
    const existing = editingId
      ? account.categories.find((category) => category.id === editingId)
      : null;
    if (editingId && existing) {
      existing.keyword = keyword;
      existing.name = name;
      existing.excludedTopics = excludedTopics;
      existing.publishPurpose = publishPurpose;
      existing.preferredTone = preferredTone;
      existing.freshnessLevel = freshnessLevel;
      existing.searchChannel = searchChannel;
      existing.primarySearchProvider = primarySearchProvider;
      existing.fallbackSearchProvider = fallbackSearchProvider;
      existing.trustBlogAsSource = trustBlogAsSource;
      existing.checked = true;
    } else if (account.categories.some((category) => category.name === name)) {
      addLog({
        level: "warn",
        message: "같은 이름의 카테고리가 이미 있습니다. 기존 카테고리를 수정하려면 목록의 수정 버튼을 눌러 주세요.",
        at: new Date().toISOString()
      });
      setRunState("failed", "중복 카테고리명");
      return;
    } else {
      account.categories.push({
        id: makeId("cat"),
        name,
        keyword,
        excludedTopics,
        publishPurpose,
        preferredTone,
        freshnessLevel,
        searchChannel,
        primarySearchProvider,
        fallbackSearchProvider,
        trustBlogAsSource,
        checked: true
      });
    }
    clearCategoryForm();
    await saveAccountStoreNow();
  });

  $("#stopAutoButton").addEventListener("click", () => {
    state.autoRunning = false;
    state.autoPausedForSession = false;
    state.autoWaitingSessionAccountId = "";
    state.autoResumeAccountId = "";
    state.autoPendingSessionTarget = null;
    $("#stopAutoButton").disabled = true;
    setRunState("generated", "자동 중지 요청");
  });
  $("#reloadHistoryButton").addEventListener("click", async () => {
    renderHistory(await window.blogAuto.loadHistory());
  });
  $("#openHistoryModalButton").addEventListener("click", async () => {
    state.historyModalOpen = true;
    renderHistory(await window.blogAuto.loadHistory());
  });
  $("#reloadHistoryModalButton").addEventListener("click", async () => {
    renderHistory(await window.blogAuto.loadHistory());
  });
  $("#closeHistoryModalButton").addEventListener("click", closeHistoryModal);
  $("#historyModal").addEventListener("click", (event) => {
    if (event.target?.id === "historyModal") closeHistoryModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.historyModalOpen) closeHistoryModal();
  });
  $("#clearLogButton").addEventListener("click", () => {
    clearAgentLogs();
  });
  $("#openRuntimeButton").addEventListener("click", () => {
    window.blogAuto.openRuntimeFolder();
  });
  $("#dismissSessionNoticeButton").addEventListener("click", () => {
    $("#sessionNotice").hidden = true;
  });
  $("#dismissStartupNoticeButton").addEventListener("click", dismissStartupNotice);
  $("#saveSettingsButton").addEventListener("click", () => {
    saveSettingsNow().catch((error) => {
      $("#settingsState").textContent = "설정 저장 실패";
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    });
  });
  for (const selector of ["#codexModel", ...Object.values(AGENT_MODEL_SELECTORS)]) {
    const control = $(selector);
    if (!control) continue;
    control.addEventListener("change", () => {
      saveSettingsNow().catch((error) => {
        $("#settingsState").textContent = "설정 저장 실패";
        addLog({ level: "error", message: error.message, at: new Date().toISOString() });
      });
    });
  }
  for (const selector of ["#titleImageAspectRatio", "#bodyImageAspectRatio"]) {
    $(selector).addEventListener("change", () => {
      saveSettingsNow().catch((error) => {
        $("#settingsState").textContent = "설정 저장 실패";
        addLog({ level: "error", message: error.message, at: new Date().toISOString() });
      });
    });
  }
  $("#publishVisibility").addEventListener("change", updateModeControls);
  $("#publishScheduleMode").addEventListener("change", updateModeControls);
  $("#jobForm").querySelectorAll("input, select, textarea").forEach((control) => {
    if ([
      "accountLabel",
      "blogId",
      "categoryName",
      "categoryKeyword",
      "categoryExcludedTopics",
      "categoryPublishPurpose",
      "categoryPreferredTone",
      "categoryFreshnessLevel",
      "categorySearchChannel",
      "categoryPrimarySearchProvider",
      "categoryFallbackSearchProvider",
      "categoryTrustBlogAsSource"
    ].includes(control.id)) {
      return;
    }
    control.addEventListener("input", scheduleSettingsSave);
    control.addEventListener("change", scheduleSettingsSave);
  });
}

boot().catch((error) => {
  addLog({ level: "error", message: error.message, at: new Date().toISOString() });
});

// Theme and connection controls stay on the workspace; no navigation menu.
const applyTheme=theme=>{document.documentElement.dataset.theme=theme;$('#themeToggle').textContent=theme==='dark'?'라이트 모드':'다크 모드';$('#themeToggle').setAttribute('aria-pressed',String(theme==='light'));localStorage.setItem('blogauto-theme',theme);window.blogAuto.setWindowTheme(theme).catch(console.error);};
applyTheme(localStorage.getItem('blogauto-theme')==='light'?'light':'dark');
$('#themeToggle').onclick=()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
$('#extensionSetup').onclick=()=>{$('#extensionGuide').hidden=false;};
$('#closeExtensionGuide').onclick=()=>{$('#extensionGuide').hidden=true;};
$('#prepareExtensionFolder').onclick=async()=>{try{const result=await window.blogAuto.prepareExtension();$('#extensionFolder').textContent=result.folder+' · 경로 복사 완료';}catch(e){$('#extensionFolder').textContent=e.message;}};
$('#copyExtensionsUrl').onclick=()=>window.blogAuto.copyExtensionsUrl();
setInterval(async()=>{try{const store=await window.blogAuto.getConnections();
  state.accountStore.tistoryConnection=store.tistoryConnection;
  for(const account of store.accounts){const previous=state.accountStore.accounts.find(a=>a.id===account.id);if(previous){const changed=previous.sessionStatus!==account.sessionStatus;previous.sessionStatus=account.sessionStatus;previous.sessionCheckedAt=account.sessionCheckedAt;previous.connection=account.connection;if(changed&&account.sessionStatus==='valid')signalAutoSessionResume(account.id);}}
  renderAccounts();
}catch{}},10000);
// Keep the settings footer within the visible window, including connection notices.
function fitSettingsPanel() {
  const panel=document.querySelector('.input-panel');
  if(innerWidth<=760){panel.style.maxHeight='';return;}
  panel.style.maxHeight=Math.max(240,innerHeight-Math.max(56,panel.getBoundingClientRect().top)-16)+'px';
}
let settingsFrame;
function queueSettingsFit(){cancelAnimationFrame(settingsFrame);settingsFrame=requestAnimationFrame(fitSettingsPanel);}
window.addEventListener('resize',queueSettingsFit);
window.addEventListener('scroll',queueSettingsFit,{passive:true});
const settingsLayoutObserver=new ResizeObserver(fitSettingsPanel);
settingsLayoutObserver.observe(document.querySelector('.topbar'));
settingsLayoutObserver.observe(document.querySelector('.session-notice'));
fitSettingsPanel();

document.documentElement.dataset.platform=window.blogAuto.platform;

window.blogAuto.onModelError(payload=>{
  const layer=$('#modelErrorLayer'), select=$('#retryCodexModel');
  select.innerHTML=$('#codexModel').innerHTML;
  select.value=payload.model || '';
  $('#modelErrorMessage').textContent=payload.code==='CODEX_USAGE_LIMIT'
    ? 'Codex가 사용 한도 오류를 반환했습니다. 오류 상세를 확인하고 재시도를 선택해 주세요.'
    : '현재 해당 모델의 서버 응답이 늦거나 요청을 처리하지 못했습니다. 모델을 바꿔서 재시도하시기 바랍니다.';
  $('#modelErrorDetail').textContent=payload.detail;
  layer.hidden=false;
  const respond=async(action,model)=>{
    const buttons=layer.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
    try {
      if(await window.blogAuto.respondModelError({id:payload.id,action,model})){
        if(action==='retry')$('#codexModel').value=model || '';
        else {state.autoRunning=false;}
        layer.hidden=true;
      }
    }catch(error){$('#modelErrorMessage').textContent=error.message;}
    finally{buttons.forEach(b=>b.disabled=false);}
  };
  $('#retrySameModel').onclick=()=>respond('retry',payload.model);
  $('#retryChangedModel').onclick=()=>respond('retry',select.value);
  $('#cancelModelRetry').onclick=()=>respond('cancel');
  $('#retrySameModel').focus();
});
