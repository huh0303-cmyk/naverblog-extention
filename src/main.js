const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
if (process.env.BLOGAUTO_USER_DATA) app.setPath('userData', path.resolve(process.env.BLOGAUTO_USER_DATA));
// Acquire the lock before Chromium opens the shared cache or the bridge starts.
if (!app.requestSingleInstanceLock()) {
  console.log('이미 실행 중인 앱 창으로 전환합니다.');
  app.exit(0);
}
app.on('second-instance', () => {
  const focusWindow = () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  if (app.isReady()) focusWindow();
  else app.whenReady().then(focusWindow);
});
const zlib = require("node:zlib");
const { pathToFileURL } = require("node:url");
const { readHistory, appendHistory, ensureRuntimeFiles } = require("./lib/history");
const { createEmbedding } = require("./lib/embedding");
const { createRetrievalContext, summarizeSourceQuality } = require("./lib/search");
const { runCodexGeneration, fetchCodexUsageSnapshot } = require("./lib/codexRunner");
const {saveStyleResult}=require('./lib/accountImageStyle');
const { normalizeAgentResult, getPreviewImages } = require("./lib/imageAssets");
const { publishToNaver, checkNaverSession, verifyOpenNaverSession } = require("./lib/naverPublisher");
const {TISTORY_ACCOUNT_ID, tistoryAccount}=require('./lib/tistoryTarget');
const {publishSequence}=require('./lib/publishSequence');
const { publishToTistory, checkTistorySession } = require("./lib/tistoryPublisher");
const { ensureSettingsFile, normalizeCodexModel, normalizeImageAspectRatio, normalizeMaxBodyImages, resolveCodexCmdPath, readSettings, writeSettings } = require("./lib/settings");
const {
  ensureAccountStoreFile,
  readAccountStore,
  writeAccountStore,
  updateAccountSession,
  getAccountProfileDir
} = require("./lib/accountStore");

const { configureBridge, getBridge } = require('./lib/extensionBridge');
const {pendingPublishState,cancelPendingPublish,savePublicationState}=require('./lib/pendingPublish');
const {retryPlan,publicPlan,jobFile}=require('./lib/historyRetry');
function historyForUi(root){
 const history=readHistory(root),settings=readSettings(root),accounts=readAccountStore(root,settings).accounts;
 return history.map(item=>({...item,retry:publicPlan(retryPlan(root,item,history,settings,accounts))}));
}

function pendingPublishBusy(){return Boolean(activeJob) || [...getBridge().tasks.values()].some(t=>t.type==='publish' && ['queued','running'].includes(t.state));}
const {retrieveResearch}=require('./lib/researchRetrieval');
let bridgeError = '';
function connectionStore() {
  const root=getRuntimeRoot(); const store=withAccountImageUrls(root,readAccountStore(root,readSettings(root)));
  return {...store, tistoryConnection:getBridge().snapshot(TISTORY_ACCOUNT_ID), accounts:store.accounts.map(a=>({...a,sessionStatus:getBridge().snapshot(a.id).status,sessionCheckedAt:getBridge().snapshot(a.id).checkedAt,connection:getBridge().snapshot(a.id)}))};
}
function prepareExtension() {
  const source=app.isPackaged ? path.join(process.resourcesPath,'extension') : path.join(__dirname,'..','extension');
  const destination=path.join(app.getPath('userData'),'chrome-extension');
  fs.mkdirSync(destination,{recursive:true}); fs.cpSync(source,destination,{recursive:true});
  clipboard.writeText(destination); return destination;
}
let mainWindow;
let activeJob = null;
const activeTistorySessions = new Map();

app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: "#11151d",
    title: "네이버 블로그 자동화 by @복사장의생존발악",
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {titleBarOverlay: {color:'#152030', symbolColor:'#edf3fc', height:40}}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone: ${details.reason || "unknown"} (${details.exitCode || 0})`);
  });
}

function getRuntimeRoot() {
  const overrideRoot = process.env.BLOGAUTO_RUNTIME_ROOT;
  if (overrideRoot) {
    return path.resolve(overrideRoot);
  }

  return path.join(app.getPath('userData'), 'runtime');
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function safeLog(jobId, message, level = "info", agent = "main") {
  let text = String(message || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/password\s*[:=]\s*\S+/gi, "password=[redacted]");
  if (/프롬프트\s*크기\s*:|토큰\s*사용량\s*:|^tokens?\s+used\b/i.test(text)) return;
  if (/^mcp:/i.test(text) || /codex_core_plugins::manifest/i.test(text)) {
    return;
  }
  if (text.includes("Call log:")) {
    text = text.split("Call log:")[0].trim();
  }
  const logDir=path.join(getRuntimeRoot(),'jobs',String(jobId));
  try{if(fs.existsSync(logDir))fs.appendFileSync(path.join(logDir,'events.jsonl'),JSON.stringify({jobId,level,agent,message:text,at:new Date().toISOString()})+'\n');}catch{/* Log persistence must not interrupt generation. */}
  emit("job:log", {
    jobId,
    level,
    agent,
    message: text,
    at: new Date().toISOString()
  });
}

function updateStatus(jobId, status, detail = "") {
  emit("job:status", { jobId, status, detail, at: new Date().toISOString() });
}

function persistCodexRateLimits(runtimeRoot, rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  return writeSettings(runtimeRoot, { codexRateLimits: rateLimits });
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function accountAssetDir(runtimeRoot, accountId) {
  return path.join(runtimeRoot, "account-assets", String(accountId || "unknown"));
}

function accountSampleImagePath(runtimeRoot, accountId, sourcePath) {
  const ext = path.extname(String(sourcePath || "")).toLowerCase();
  const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
  return path.join(accountAssetDir(runtimeRoot, accountId), `sample${safeExt}`);
}

function withAccountImageUrls(runtimeRoot, store) {
  return {
    ...store,
    accounts: (store.accounts || []).map((account) => {
      const sampleImagePath = String(account.sampleImagePath || "");
      const sampleImageUrl = sampleImagePath && fs.existsSync(sampleImagePath)
        ? pathToFileURL(sampleImagePath).toString()
        : "";
      return { ...account, sampleImageUrl };
    })
  };
}

function emitAccountStore(runtimeRoot) {
  emit("accounts:update", connectionStore());
}

function safeProfileSegment(value) {
  return String(value || "profile")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function getTistoryProfileDir(runtimeRoot, tistoryBlogId) {
  return path.join(runtimeRoot, "browser-profiles", safeProfileSegment(`tistory_${tistoryBlogId || "default"}`));
}

function tistorySessionKey(tistoryBlogId, browserProfileDir) {
  return String(tistoryBlogId || "") || browserProfileDir;
}

function crc32(buffer) {
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
  }));
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createTistoryTestPng(width = 640, height = 360) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      raw[offset] = Math.floor(40 + (x / Math.max(1, width - 1)) * 150);
      raw[offset + 1] = Math.floor(90 + (y / Math.max(1, height - 1)) * 120);
      raw[offset + 2] = 210;
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND")
  ]);
}

function ensureTistoryTestImage(runtimeRoot) {
  const dir = path.join(runtimeRoot, "test-assets");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "tistory-test-image.png");
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, createTistoryTestPng());
  }
  return filePath;
}

function buildTistoryTestArticle() {
  return [
    "[SECTION - 편집기 입력 테스트]",
    "이 글은 티스토리 전용 자동화 테스트 글입니다.",
    "네이버 세션 확인, 본문 생성, 이미지 생성, 네이버 발행 과정을 건너뛰고 티스토리 입력과 발행 흐름만 확인합니다.",
    "",
    "[IMAGE INSERT - 1]",
    "",
    "[SECTION - 발행 흐름 테스트]",
    "이 글이 티스토리 글 목록에 보이면 카카오 로그인, 제목 입력, 본문 입력, 이미지 업로드, 카테고리 선택, 최종 발행 단계까지 도달한 것입니다."
  ].join("\n");
}

function detectChromeInstall(){const chromePath=require('./lib/chromeLauncher').findChrome();return {available:Boolean(chromePath),path:chromePath};}

async function closeTistorySession(key) {
  const session = activeTistorySessions.get(key);
  if (!session) return;
  activeTistorySessions.delete(key);

}

function reusableTistorySession(key) {
  const session = activeTistorySessions.get(key);
  if (!session?.context || session.page?.isClosed?.()) {
    activeTistorySessions.delete(key);
    return null;
  }
  return session;
}

function sanitizeNaverTag(value) {
  return String(value || "")
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function buildTags(_topic,_keyword,articleTags) {
  return [...new Set((Array.isArray(articleTags)?articleTags:[]).map(sanitizeNaverTag).filter(Boolean))].slice(0,10);
}

function clearPendingNaverPublishDraft(runtimeRoot) {
  writeSettings(runtimeRoot, { pendingNaverPublishDraft: null, pendingGenerationDraft: null });
}

function pendingDraftMatches(draft, { account, blogId, category } = {}) {
  if (!draft || typeof draft !== "object") return false;
  const accountId = String(account?.id || "");
  return String(draft.accountId || "") === accountId
    && String(draft.blogId || "") === String(blogId || "")
    && String(draft.category || "") === String(category || "")
    && String(draft.status || "") === "pending_naver_publish";
}

function buildPendingNaverPublishDraft({
  jobId,
  account,
  blogId,
  category,
  topic,
  keyword,
  agentResult,
  tags,
  publishPrivate,
  publishVisibility,
  publishScheduleMode,
  reserveAfterHours,
  breakSentencesInBody,
  publishToTistoryAfterNaver,
  tistoryBlogId,
  latestLaneResult,
  researchTitleResult,
  tokenUsage
}) {
  if (!agentResult?.title || !agentResult?.article) return null;
  return {
    status: "pending_naver_publish",
    jobId,
    createdAt: new Date().toISOString(),
    accountId: account?.id || "",
    blogId,
    category,
    topic,
    keyword,
    title: agentResult.title,
    article: agentResult.article,
    titleImagePath: agentResult.titleImagePath || "",
    bodyImages: Array.isArray(agentResult.bodyImages) ? agentResult.bodyImages : [],
    tags: Array.isArray(tags) ? tags : [],
    publishPrivate,
    publishVisibility,
    publishScheduleMode,
    reserveAfterHours,
    breakSentencesInBody,
    publishToTistoryAfterNaver,
    tistoryBlogId,
    keywordLane: keywordLaneResultPayload(latestLaneResult),
    researchTitle: researchTitleResult?.finalTitle || researchTitleResult?.selectedTitle || "",
    topicThesis: researchTitleResult?.topicThesis || '',
    readerQuestion: researchTitleResult?.writerContract?.contentStrategy?.primaryQuestion || '',
    factBased: researchTitleResult?.factBased === true,
    sourceSummary: researchTitleResult?.searchFlowSummary || "",
    tokenTotal: Number(tokenUsage?.total || 0)
  };
}

function normalizeKeywordLane(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const parts = text.split(" ");
  if (parts.length % 2 === 0) {
    const half = parts.length / 2;
    if (parts.slice(0, half).join(" ") === parts.slice(half).join(" ")) {
      return parts.slice(0, half).join(" ");
    }
  }
  return text;
}

function splitKeywordLanes(keyword) {
  const seen = new Set();
  return String(keyword || "")
    .split(/[,\n]+/)
    .map(normalizeKeywordLane)
    .filter(Boolean)
    .filter((lane) => {
      const key = lane.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((phrase, index) => ({ index: index + 1, phrase }));
}

function keywordLaneFromEntry(entry) {
  return String(entry?.topic_lane || entry?.topicLane || "").trim();
}

function buildKeywordLanePlan(keyword, history = [], { blogId = "", category = "", excludedKeywordLanes = [] } = {}) {
  const allLanes = splitKeywordLanes(keyword);
  const excluded = new Set((Array.isArray(excludedKeywordLanes) ? excludedKeywordLanes : [])
    .map((lane) => String(lane || "").trim().toLowerCase())
    .filter(Boolean));
  const availableLanes = allLanes.filter((lane) => !excluded.has(lane.phrase.toLowerCase()));
  const lanes = availableLanes.length ? availableLanes : allLanes;
  const scopedHistory = (Array.isArray(history) ? history : [])
    .filter((entry) => !blogId || String(entry?.blog_id || "") === blogId)
    .filter((entry) => !category || String(entry?.category || "") === category || String(entry?.keyword || "") === String(keyword || ""));
  const usage = new Map(lanes.map((lane) => [lane.phrase.toLowerCase(), { count: 0, lastCreateAt: "" }]));
  for (const entry of scopedHistory) {
    const lane = keywordLaneFromEntry(entry);
    if (!lane) continue;
    const key = lane.toLowerCase();
    if (!usage.has(key)) continue;
    const stat = usage.get(key);
    stat.count += 1;
    stat.lastCreateAt = [stat.lastCreateAt, String(entry.create_at || "")].sort().pop() || stat.lastCreateAt;
  }
  const recommended = [...lanes].sort((a, b) => {
    const aStat = usage.get(a.phrase.toLowerCase()) || { count: 0, lastCreateAt: "" };
    const bStat = usage.get(b.phrase.toLowerCase()) || { count: 0, lastCreateAt: "" };
    if (aStat.count !== bStat.count) return aStat.count - bStat.count;
    if (aStat.lastCreateAt !== bStat.lastCreateAt) return String(aStat.lastCreateAt).localeCompare(String(bStat.lastCreateAt));
    return a.index - b.index;
  });
  return { lanes, recommended, usage: Object.fromEntries([...usage.entries()]) };
}

function normalizeResearchLaneResult(researchResult, lanePlan) {
  const lanes = Array.isArray(lanePlan?.lanes) ? lanePlan.lanes : [];
  const byIndex = new Map(lanes.map((lane) => [lane.index, lane]));
  const byPhrase = new Map(lanes.map((lane) => [lane.phrase.toLowerCase(), lane]));
  const selected = [];
  for (const index of Array.isArray(researchResult?.selectedKeywordIndexes) ? researchResult.selectedKeywordIndexes : []) {
    const lane = byIndex.get(Number(index));
    if (lane && !selected.some((item) => item.index === lane.index)) selected.push(lane);
  }
  for (const phrase of [
    researchResult?.topicLane,
    ...(Array.isArray(researchResult?.selectedKeywordPhrases) ? researchResult.selectedKeywordPhrases : [])
  ]) {
    const lane = byPhrase.get(String(phrase || "").trim().toLowerCase());
    if (lane && !selected.some((item) => item.index === lane.index)) selected.push(lane);
  }
  const fallback = Array.isArray(lanePlan?.recommended) ? lanePlan.recommended[0] : null;
  if (!selected.length && fallback) selected.push(fallback);
  const topicLane = String(researchResult?.topicLane || selected[0]?.phrase || "").trim();
  const searchQueries = (Array.isArray(researchResult?.searchQueries) ? researchResult.searchQueries : [])
    .map((query) => String(query || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((query) => query.length <= 140)
    .slice(0, 4);
  return {
    topicLane,
    selectedKeywordIndexes: selected.map((lane) => lane.index),
    selectedKeywordPhrases: selected.map((lane) => lane.phrase),
    searchQueries
  };
}

function keywordLaneHistoryFields(laneResult = {}) {
  return {
    topic_lane: String(laneResult.topicLane || ""),
    selected_keyword_indexes: Array.isArray(laneResult.selectedKeywordIndexes) ? laneResult.selectedKeywordIndexes : [],
    selected_keyword_phrases: Array.isArray(laneResult.selectedKeywordPhrases) ? laneResult.selectedKeywordPhrases : [],
    search_queries: Array.isArray(laneResult.searchQueries) ? laneResult.searchQueries : []
  };
}

function keywordLaneResultPayload(laneResult = {}) {
  return {
    topicLane: String(laneResult.topicLane || ""),
    selectedKeywordIndexes: Array.isArray(laneResult.selectedKeywordIndexes) ? laneResult.selectedKeywordIndexes : [],
    selectedKeywordPhrases: Array.isArray(laneResult.selectedKeywordPhrases) ? laneResult.selectedKeywordPhrases : [],
    searchQueries: Array.isArray(laneResult.searchQueries) ? laneResult.searchQueries : []
  };
}

function mergeSearchResults(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const key = require('./lib/evidenceText').canonicalUrl(item?.url || item?.fetchedUrl);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged.slice(0, 20).map((item, index) => ({
    ...item,
    sourceId: 'src-' + crypto.createHash('sha256').update(item.url || item.fetchedUrl).digest('hex').slice(0, 16)
  }));
}

function selectSearchTopicForResearch(researchResult, context = {}) {
  const directTopic = String(context.topic || "").trim();
  return String(
    researchResult?.finalTitle
    || researchResult?.selectedTitle
    || directTopic
    || `${context.category || ""} ${context.keyword || ""}`.trim()
  ).replace(/\s+/g, " ").trim();
}

function uniqueSearchQueries(values, limit = 4) {
  const seen = new Set();
  const queries = [];
  for (const value of Array.isArray(values) ? values : []) {
    const query = String(value || "").replace(/\s+/g, " ").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query.slice(0, 120));
    if (queries.length >= limit) break;
  }
  return queries;
}

function todayLabel() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
}

async function resolveTopicInput(form, category, log) {
  const seedKeyword = String(form.keyword || "").trim() || category;
  log("자동 주제 모드: 카테고리와 키워드를 Research/Title Agent에 전달합니다.");
  return {
    topic: "",
    keyword: seedKeyword
  };
}

function resolveAccount(form, accountStore) {
  const accountId = String(form.accountId || "").trim();
  const account = accountStore.accounts.find((item) => item.id === accountId);
  if (account) return account;
  return {
    id: accountId,
    label: String(form.blogId || "").trim() || "Naver 계정",
    blogId: String(form.blogId || "").trim(),
    sessionStatus: "unknown",
    categories: []
  };
}

async function verifyPublishSessionBeforeGeneration({ account, blogId, jobId }) {
  updateStatus(jobId,'publishing','연결된 Chrome의 글쓰기 권한 확인');
  const connection = getBridge().snapshot(account.id);
  safeLog(jobId, connection.status === 'waiting_login'
    ? '이 계정의 Chrome에서 로그인을 기다리고 있습니다. 로그인 확인이 완료되면 자동으로 이어갑니다. 대기를 끝내려면 계정 카드의 대기 취소를 누르세요.'
    : connection.busy ? '진행 중인 계정 로그인 확인 결과를 기다립니다.' : '계정 로그인과 블로그 글쓰기 권한을 확인합니다.');
  const result=await checkNaverSession({accountId:account.id,blogId,interactiveLogin:false,preflightTitle:true});
  if(result.status!=='valid') throw Object.assign(new Error(result.reason || '계정 연결 상태를 확인해 주세요.'), {code:'SESSION_EXPIRED'});
  return result.preparedSession;
}

async function verifyTistorySessionBeforeGeneration({form, jobId}) {
  safeLog(jobId, '티스토리 로그인과 대상 블로그 쓰기 권한을 확인합니다.');
  const result=await checkTistorySession({tistoryBlogId:form.tistoryBlogId,category:form.category,interactiveLogin:true});
  if(result.status!=='valid')throw new Error(result.reason || '티스토리 공용 Chrome을 연결해 주세요. 원고 생성은 시작하지 않았습니다.');
  return result;
}

async function publishSavedDraft(runtimeRoot, draft, jobId) {
  return publishSequence(draft, {
    save: value=>savePublicationState(runtimeRoot,value,jobId),
    log: message=>safeLog(jobId,message),
    naver: value=>publishToNaver({...value,log:message=>safeLog(jobId,message)}),
    tistory: value=>{
      updateStatus(jobId,'publishing',`네이버 ${value.publishVisibility==='draft'?'임시저장':'발행'} 완료 · 티스토리 이어 발행`);
      return publishToTistory({...value,log:message=>safeLog(jobId,message)});
    }
  });
}

async function startTistoryTestPublish(form = {}) {
  if (activeJob) {
    throw new Error("이미 실행 중인 작업이 있습니다.");
  }

  const runtimeRoot = getRuntimeRoot();
  ensureRuntimeFiles(runtimeRoot);
  ensureSettingsFile(runtimeRoot);
  const settings = readSettings(runtimeRoot);
  const jobId = `tistory_test_${Date.now()}`;
  activeJob = { id: jobId, cancelled: false };

  const tistoryBlogId = String(form.tistoryBlogId || settings.tistoryBlogId || "").trim();
  if (!tistoryBlogId) {
    activeJob = null;
    throw new Error("티스토리 블로그 ID가 필요합니다.");
  }

  const imagePath = ensureTistoryTestImage(runtimeRoot);
  const browserProfileDir = getTistoryProfileDir(runtimeRoot, tistoryBlogId);
  const tistoryKey = tistorySessionKey(tistoryBlogId, browserProfileDir);
  const preparedTistorySession = reusableTistorySession(tistoryKey);
  const title = `[티스토리 테스트] ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
  const article = buildTistoryTestArticle();
  const images = [{
    role: "body",
    sequence: 1,
    path: imagePath,
    url: pathToFileURL(imagePath).toString()
  }];
  const publishVisibility = String(form.publishVisibility || settings.publishVisibility || (settings.publishPrivate === false ? "public" : "private"));
  const publishScheduleMode = String(form.publishScheduleMode || settings.publishScheduleMode || "now");
  const reserveAfterHours = Number(form.reserveAfterHours || settings.reserveAfterHours || 0);
  const publishPrivate = publishVisibility !== "public";

  emit("job:preview", {
    jobId,
    title,
    article,
    images,
    imageNotes: ["티스토리 전용 테스트 이미지가 로컬에서 생성되었습니다."],
    tokenUsage: { total: 0 }
  });

  try {
    updateStatus(jobId, "publishing", "티스토리 테스트 발행");
    safeLog(jobId, "티스토리 전용 테스트 발행을 시작합니다.");
    await publishToTistory({
      tistoryBlogId,
      category: String(form.category || settings.category || "").trim(),
      publishPrivate,
      publishVisibility,
      publishScheduleMode,
      reserveAfterHours,
      failOnLoginRequired: false,
      title,
      article,
      titleImagePath: "",
      bodyImages: [{ sequence: 1, path: imagePath }],
      breakSentencesInBody: true,
      tags: ["티스토리테스트", "자동화테스트"],
      browserProfileDir,
      preparedContext: preparedTistorySession?.context,
      preparedPage: preparedTistorySession?.page,
      runtimeRoot,
      log: (message, level) => safeLog(jobId, message, level)
    });
    writeSettings(runtimeRoot, {
      tistoryBlogId,
      tistorySessionStatus: "valid",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    updateStatus(jobId, "success", "티스토리 테스트 발행 완료");
    safeLog(jobId, "티스토리 전용 테스트 발행 완료.");
    const payload = {
      jobId,
      status: "success",
      reason: "티스토리 전용 테스트 발행 완료.",
      title,
      article,
      images,
      imageNotes: ["티스토리 전용 테스트 이미지가 로컬에서 생성되었습니다."],
      tokenUsage: { total: 0 },
      history: historyForUi(runtimeRoot)
    };
    emit("job:complete", payload);
    return payload;
  } catch (error) {
    writeSettings(runtimeRoot, {
      tistorySessionStatus: error.code === "TISTORY_SESSION_EXPIRED" ? "expired" : "unknown",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    safeLog(jobId, `티스토리 전용 테스트 발행 실패: ${error.message}`, "error");
    updateStatus(jobId, "failed", error.message);
    throw error;
  } finally {
    activeJob = null;
  }
}

let modelRetryPending = null;
function awaitModelRetry(jobId, payload) {
  return new Promise(resolve=>{
    const id = `${jobId}-${Date.now()}`;
    modelRetryPending={id,resolve};
    emit('job:modelError',{...payload,id});
  });
}

async function startJob(form) {
  form = {...form, topicMode:"auto", topic:"", publishAfterGenerate:true};
  if (activeJob) {
    throw new Error("이미 실행 중인 작업이 있습니다.");
  }

  const runtimeRoot = getRuntimeRoot();
  ensureRuntimeFiles(runtimeRoot);
  ensureSettingsFile(runtimeRoot);
  const settings = readSettings(runtimeRoot);
  ensureAccountStoreFile(runtimeRoot, settings);

  const jobId = `job_${Date.now()}`;
  const prior=settings.pendingNaverPublishDraft || settings.pendingGenerationDraft;
  if(prior?.jobId){
    const file=jobFile(runtimeRoot,jobId,'retry-context.json');fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({retry_of:prior.jobId,retry_root_id:prior.retryRootId || prior.jobId}));
  }
  activeJob = { id: jobId, cancelled: false };

  const accountStore = readAccountStore(runtimeRoot, settings);
  const account = resolveAccount(form, accountStore);
  const category = String(form.category || "").trim();
  const blogId = String(form.blogId || account.blogId || account.naverId || "").trim();
  const codexCmdPath = resolveCodexCmdPath(form.codexCmdPath || settings.codexCmdPath);
  const codexModel = normalizeCodexModel(form.codexModel ?? settings.codexModel);
  const publishVisibility = String(settings.pendingNaverPublishDraft?.publishVisibility || form.publishVisibility || (form.publishPrivate === false ? "public" : "private"));
  const publishPrivate = publishVisibility !== "public";
  const publishScheduleMode = publishVisibility==='draft'?'now':String(form.publishScheduleMode || "now");
  const reserveAfterHours = Number(form.reserveAfterHours || 0);
  const resumeOptions=settings.pendingGenerationDraft?.checkpoint?.generationOptions;
  if(resumeOptions)form={...form,...resumeOptions,codexModel:form.codexModel,agentModels:form.agentModels};
  const categoryKeyword = String(form.keyword || "").trim();
  const includeTitleImage = form.includeTitleImage !== false;
  const titleImageAspectRatio = normalizeImageAspectRatio(form.titleImageAspectRatio || settings.titleImageAspectRatio || form.imageAspectRatio || settings.imageAspectRatio);
  const bodyImageAspectRatio = normalizeImageAspectRatio(form.bodyImageAspectRatio || settings.bodyImageAspectRatio || form.imageAspectRatio || settings.imageAspectRatio);
  const maxBodyImages = normalizeMaxBodyImages(form.maxBodyImages);
  const breakSentencesInBody = true;
  const agentModels = form.agentModels || settings.agentModels || {};
  const shouldPublish = form.publishAfterGenerate === true || form.topicMode === "auto";
  const pendingRecovery=settings.pendingNaverPublishDraft;
  const generationDraft=settings.pendingGenerationDraft;
  const pendingTarget=pendingRecovery || generationDraft;
  if(pendingTarget && (pendingTarget.accountId!==account.id || pendingTarget.blogId!==blogId || pendingTarget.category!==category)){
    activeJob=null;
    throw new Error('중단된 작업의 계정·블로그·카테고리가 현재 대상과 다릅니다. 기존 대상을 선택하거나 기존 작업 취소 버튼을 눌러 취소하세요.');
  }
  if(shouldPublish && pendingRecovery?.accountId===account.id && pendingRecovery.blogId===blogId && (pendingRecovery.status==='publish_uncertain' || ['running','uncertain'].includes(pendingRecovery.publications?.naver?.status) || ['running','uncertain'].includes(pendingRecovery.publications?.tistory?.status))) {
    try {
      if(pendingRecovery.category!==category)throw Object.assign(new Error('발행 결과 확인이 필요한 이전 원고의 카테고리를 선택하세요. 새 원고 생성은 중지했습니다.'),{code:'PUBLISH_UNCERTAIN'});
      settings.pendingNaverPublishDraft=await require('./lib/publishRecovery').recoverPendingPublication(pendingRecovery,{
        bridge:getBridge(),save:value=>savePublicationState(runtimeRoot,value,jobId),log:message=>safeLog(jobId,message)
      });
    } catch(error){activeJob=null;throw error;}
  }
  const resumeDraft=shouldPublish && pendingDraftMatches(settings.pendingNaverPublishDraft,{account,blogId,category}) ? settings.pendingNaverPublishDraft : null;
  const tistoryBlogId = resumeDraft
    ? (resumeDraft.publishToTistoryAfterNaver===true || (resumeDraft.publishVisibility!=='draft' && resumeDraft.publishToTistoryAfterNaver!==false) ? resumeDraft.tistoryBlogId || '' : '')
    : (publishVisibility!=='draft' || form.draftTistoryAutoPublish===true) ? account.tistoryBlogId || '' : '';
  const publishToTistoryAfterNaver = shouldPublish && Boolean(tistoryBlogId);
  let tistoryPublishReady = publishToTistoryAfterNaver;
  if(publishToTistoryAfterNaver && publishScheduleMode==='reserve' && publishVisibility!=='public'){
    activeJob=null;throw new Error('티스토리는 비공개 예약을 제공하지 않습니다. 공개 예약 또는 현재 비공개 저장으로 변경해 주세요. 원고 생성은 시작하지 않았습니다.');
  }
  if (!category) {
    activeJob = null;
    throw new Error("카테고리는 필수입니다.");
  }
  if (!categoryKeyword) {
    activeJob = null;
    throw new Error("카테고리별 검색 키워드는 필수입니다.");
  }
  if (shouldPublish && !blogId) {
    activeJob = null;
    throw new Error("발행까지 진행하려면 Blog ID가 필요합니다.");
  }
  if (publishToTistoryAfterNaver && !tistoryBlogId) {
    activeJob = null;
    throw new Error("티스토리 발행에는 블로그 ID가 필요합니다.");
  }
  if (shouldPublish) {
    safeLog(jobId, `Naver 블로그 주소 ID: ${blogId} (로그인은 열린 Chrome에서 직접 입력)`);
  }
  // Preserve the queue position before connection/login preflight can fail.
  if(!pendingRecovery && !generationDraft){
    writeSettings(runtimeRoot,{pendingGenerationDraft:{accountId:account.id,blogId,category,jobId,retryRootId:prior?.retryRootId || prior?.jobId || jobId,status:'generation_pending',checkpoint:null}});
  }

  let preparedNaverSession = null;
  let preparedTistorySession = null;
  let browserProfileDir = getAccountProfileDir(runtimeRoot, account);
  let latestAgentResultForResume = null;
  let latestTagsForResume = [];
  try {
    if (shouldPublish) {
      preparedNaverSession = resumeDraft?.publications?.naver?.status==='done' ? {} : await verifyPublishSessionBeforeGeneration({
        runtimeRoot,
        account,
        blogId,
        form,
        settings,
        jobId
      });
      browserProfileDir = preparedNaverSession.browserProfileDir || browserProfileDir;
      if (tistoryPublishReady && resumeDraft?.publications?.tistory?.status!=='done') {
        const tistorySession = await verifyTistorySessionBeforeGeneration({
          runtimeRoot,
          form: {...form,tistoryBlogId},
          settings,
          jobId
        });
        tistoryPublishReady = tistorySession.status === "valid";
        preparedTistorySession = tistoryPublishReady ? tistorySession.preparedSession || null : null;
      }
      safeLog(jobId, "Naver 세션 확인 완료. 주제 입력값 준비 단계로 이동합니다.");
    }
  } catch (error) {
    appendHistory(runtimeRoot,{id:jobId,create_at:new Date().toISOString(),account_id:account.id,blog_id:blogId,category,title:'',status:error.code==='SESSION_EXPIRED'?'session_expired':'failed',failure_phase:'connection',failure_kind:'execution',reason:error.message});
    activeJob = null;
    if (error.code === "SESSION_EXPIRED") {
      if (account.id) {
        updateAccountSession(runtimeRoot, account.id, "expired", settings);
        emitAccountStore(runtimeRoot);
      }
      safeLog(jobId, error.message, "warn");
      updateStatus(jobId, "session_expired", error.message);
      emit("job:complete", {
        jobId,
        accountId: account.id || "",
        topic: "",
        keyword: "",
        category,
        blogId,
        status: "session_expired",
        title: "",
        article: "",
        images: [],
        imageNotes: [],
        tokenUsage: { total: 0 },
        tags: [],
        history: historyForUi(runtimeRoot)
      });
      return { status: "session_expired", reason: error.message };
    }
    throw error;
  }

  let resolved;
  let topic = "";
  let keyword = "";
  try {
    safeLog(jobId, "주제 입력값 준비 시작");
    resolved = resumeDraft
      ? {topic:resumeDraft.topic || resumeDraft.title,keyword:resumeDraft.keyword || categoryKeyword}
      : await resolveTopicInput(form, category, (message, level) => safeLog(jobId, message, level, "research"));
    topic = resolved.topic;
    keyword = resolved.keyword;
    safeLog(jobId, "주제 입력값 준비 완료");
  } catch (error) {
    activeJob = null;
    throw error;
  }


  const jobDir = path.join(runtimeRoot, "jobs", jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const nonSensitiveJob = { jobId, accountId: account.id || "", topic, keyword, category, blogId, status: "generating" };
  const jobTokenUsage = {
    total: 0,
    grossTotal: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    promptCharacters: 0,
    estimatedPromptTokens: 0,
    agents: {},
    grossAgents: {},
    promptCharactersByAgent: {},
    rateLimits: null
  };
  writeSettings(runtimeRoot, {
    blogId,
    topic,
    keyword,
    category,
    codexCmdPath,
    codexModel,
    primarySearchProvider: form.primarySearchProvider || "naver",
    fallbackSearchProvider: form.fallbackSearchProvider || "google",
    naverSearchUrl: form.naverSearchUrl || "",
    googleSearchUrl: form.googleSearchUrl || "",
    naverEditorDomNotes: form.naverEditorDomNotes || "",
    publishAfterGenerate: shouldPublish,
    publishPrivate,
    topicMode: "auto",
    repeatTermMinutes: Number(form.repeatTermMinutes || 60),
    crossPublish: form.crossPublish === true,
    publishVisibility,
    publishScheduleMode,
    reserveAfterHours,
    publishToTistoryAfterNaver,
    tistoryBlogId,
    includeTitleImage,
    titleImageAspectRatio,
    bodyImageAspectRatio,
    maxBodyImages,
    breakSentencesInBody,
    agentModels
  });
  updateStatus(jobId, "generating", "Agent 생성 준비");

  const excludedKeywordLanes = Array.isArray(form.excludedKeywordLanes) ? form.excludedKeywordLanes : [];
  let keywordLanePlan = buildKeywordLanePlan(keyword, [], { blogId, category, excludedKeywordLanes });
  let latestLaneResult = normalizeResearchLaneResult({}, keywordLanePlan);
  let latestResearchTitleResult = null;
  let lastLoggedTitle="",lastLoggedLane="";
  let generationAttempts=[];
  const pendingDraft = settings.pendingNaverPublishDraft;
  if(shouldPublish && pendingDraft?.status==='publish_uncertain' && pendingDraft.accountId===account.id && pendingDraft.blogId===blogId){
    activeJob=null;
    throw new Error('이전 발행 결과가 불확실하여 재생성·자동 재발행을 중지했습니다. 네이버 게시글·예약 목록을 확인한 뒤, 이 원고를 다시 사용하지 않으려면 본문 오른쪽 상단의 ‘기존 작업 취소’ 버튼을 눌러 해제하세요.');
  }
  if (shouldPublish && pendingDraftMatches(pendingDraft, { account, blogId, category })) {
    const resumeAgentResult = {
      title: pendingDraft.title || "",
      article: pendingDraft.article || "",
      titleImagePath: pendingDraft.titleImagePath || "",
      bodyImages: Array.isArray(pendingDraft.bodyImages) ? pendingDraft.bodyImages : [],
      imageWarnings: []
    };
    const resumeTags = Array.isArray(pendingDraft.tags) ? pendingDraft.tags : [];
    latestAgentResultForResume = resumeAgentResult;
    latestTagsForResume = resumeTags;
    emit("job:preview", {
      jobId,
      title: resumeAgentResult.title,
      article: resumeAgentResult.article,
      images: getPreviewImages(resumeAgentResult),
      imageNotes: [],
      tokenUsage: jobTokenUsage,
      tags: resumeTags
    });
    try {
      updateStatus(jobId, "publishing", "Naver pending draft publish resume");
      safeLog(jobId, "이전 작업의 작성 완료 draft를 재사용해 발행만 이어갑니다.", "info");
      await publishSavedDraft(runtimeRoot,pendingDraft,jobId);
      const completionStatus=pendingDraft.publishVisibility==='draft'?'draft_saved':'success';
      const publishReason=pendingDraft.publishVisibility==='draft'?(pendingDraft.publishToTistoryAfterNaver ? '네이버 임시저장 및 티스토리 발행 완료.' : '네이버 임시저장 완료 · 빈 편집기 복귀 확인.'):pendingDraft.tistoryBlogId ? '네이버와 티스토리 발행 완료.' : '네이버 발행 완료.';
      clearPendingNaverPublishDraft(runtimeRoot);
      const embedding = createEmbedding(resumeAgentResult.title);
      appendHistory(runtimeRoot, {
        id: jobId,
        create_at: new Date().toISOString(),
        account_id: account.id || "",
        blog_id: blogId,
        title: resumeAgentResult.title,
        topic: pendingDraft.topic || topic,
        keyword: pendingDraft.keyword || keyword,
        category,
        ...(pendingDraft.keywordLane || {}),
        status: completionStatus,
        harness_version: "lean-agent-v1",
        final_verdict: "PASS",
        failure_phase: "",
        research_title: pendingDraft.researchTitle || "",
        topic_thesis: pendingDraft.topicThesis || '',
        reader_question: pendingDraft.readerQuestion || '',
        fact_based: pendingDraft.factBased === true,
        source_summary: pendingDraft.sourceSummary || "",
        embedding_model: "local-hash-v1",
        embedding,
        token_total: Number(pendingDraft.tokenTotal || 0),
        reason: publishReason
      });
      updateStatus(jobId, completionStatus, publishReason);
      emit("job:complete", {
        ...nonSensitiveJob,
        status: completionStatus,
        title: resumeAgentResult.title,
        article: resumeAgentResult.article,
        images: getPreviewImages(resumeAgentResult),
        imageNotes: [],
        tokenUsage: jobTokenUsage,
        tags: resumeTags,
        history: historyForUi(runtimeRoot)
      });
      return { status: completionStatus, resumedPendingPublish: true };
    } catch (error) {
      if(error.code==='PUBLISH_UNCERTAIN')writeSettings(runtimeRoot,{pendingNaverPublishDraft:{...readSettings(runtimeRoot).pendingNaverPublishDraft,status:'publish_uncertain'}});
      if (error.code === "SESSION_EXPIRED" && account.id) {
        updateAccountSession(runtimeRoot, account.id, "expired", settings);
        emitAccountStore(runtimeRoot);
      }
      appendHistory(runtimeRoot,{id:jobId,create_at:new Date().toISOString(),account_id:account.id,blog_id:blogId,category,title:resumeAgentResult.title,status:error.code==='PUBLISH_UNCERTAIN'?'publish_uncertain':'failed',failure_phase:'publish',failure_kind:'execution',reason:error.message});
      safeLog(jobId, error.message, "error");
      updateStatus(jobId, error.code === "SESSION_EXPIRED" ? "session_expired" : error.code === "PUBLISH_UNCERTAIN" ? "publish_uncertain" : "failed", error.message);
      emit("job:complete", {
        ...nonSensitiveJob,
        status: error.code === "SESSION_EXPIRED" ? "session_expired" : error.code === "PUBLISH_UNCERTAIN" ? "publish_uncertain" : "failed",
        title: resumeAgentResult.title,
        article: resumeAgentResult.article,
        images: getPreviewImages(resumeAgentResult),
        tags: resumeTags,
        tokenUsage: jobTokenUsage,
        history: historyForUi(runtimeRoot)
      });
      return {
        status: error.code === "SESSION_EXPIRED" ? "session_expired" : error.code === "PUBLISH_UNCERTAIN" ? "publish_uncertain" : "failed",
        reason: error.message,
        resumedPendingPublish: true
      };
    } finally {
      activeJob = null;
    }
  }
  try {
    const currentDateLabel = todayLabel();
    const history = readHistory(runtimeRoot);
    const accountHistory = require('./lib/topicHistory').accountHistory(history,{accountId:account.id,blogId});
    keywordLanePlan = buildKeywordLanePlan(keyword, accountHistory, { category, excludedKeywordLanes });
    latestLaneResult = normalizeResearchLaneResult({}, keywordLanePlan);
    const publishedTopicHistory=require('./lib/topicHistory').publishedTopics(accountHistory);
    const titleHistory = accountHistory.filter(entry=>entry.title && ['success','generated','draft_saved'].includes(entry.status)).map(entry=>({title:entry.title}));

    const usesImages = includeTitleImage || maxBodyImages > 0;
    const generationSubject = topic || `${category} ${keyword}`.trim();
    const modelSnapshot = {
      codexModel: codexModel || "Codex 기본값",
      main: agentModels.main || "high",
      research: agentModels.research || "high",
      writer: agentModels.writer || "high",
      image: agentModels.image || "medium"
    };
    safeLog(jobId, `Agent 모델 설정: Codex ${modelSnapshot.codexModel}, Main ${modelSnapshot.main}, Research/Title ${modelSnapshot.research}, Writer ${modelSnapshot.writer}, Image Worker ${modelSnapshot.image}`);
    safeLog(jobId, `Codex ${usesImages ? "본문/이미지 프롬프트" : "본문"} 생성 시작: ${generationSubject}`);
    if(generationDraft?.checkpoint)safeLog(jobId,'중단된 작업을 이어갑니다. 완료된 조사·본문·검증·이미지는 재사용하고 미완료 단계부터 다시 시도합니다.');
    const generationStartedAt = Date.now();
    let generationPhase = "준비 중";
    const generationHeartbeat = setInterval(() => {
      const minutes = Math.max(1, Math.ceil((Date.now() - generationStartedAt) / 60000));

      updateStatus(jobId, "generating", `${generationPhase} (${minutes}분 경과)`);
    }, 60000);
    const retrievalContext=createRetrievalContext();
    let codexResult;
    try {
      codexResult = await runCodexGeneration({
        generationCheckpoint: generationDraft?.checkpoint || null,
        onGenerationCheckpoint: checkpoint => {
          writeSettings(runtimeRoot,{pendingGenerationDraft:{accountId:account.id,blogId,category,jobId,retryRootId:prior?.retryRootId || prior?.jobId || jobId,status:'generation_pending',checkpoint}});
          fs.writeFileSync(path.join(jobDir,'generation-checkpoint.json'),JSON.stringify(checkpoint,null,2));
        },
        onModelError: payload=>awaitModelRetry(jobId,payload),
        codexCmdPath,
        runtimeRoot,
        jobDir,
        codexModel,
        topic,
        keyword,
        category,
        topicMode: "auto",
        searchResults: [],
        currentDateLabel,
        includeTitleImage,
        titleImageAspectRatio,
        bodyImageAspectRatio,
        maxBodyImages,
        sourceQuality: { status: "not_requested" },
        excludedTopics: form.excludedTopics || "",
        publishPurpose: form.publishPurpose || "",
        preferredTone: form.preferredTone || "",
        freshnessLevel: form.freshnessLevel || "auto",
        searchChannel: form.searchChannel || "blog",
        trustBlogAsSource: form.trustBlogAsSource === true,
        keywordLanes: keywordLanePlan.lanes,
        recommendedKeywordLanes: keywordLanePlan.recommended,
        agentModels,
        historyTitles: titleHistory.map((item) => item.title),
        publishedTopics: publishedTopicHistory,
        accountImageStyle: {
          accountId: account.id || "",
          sampleImagePath: account.sampleImagePath || "",
          sampleImageHash: account.sampleImageHash || "",
          sampleImageUpdatedAt: account.sampleImageUpdatedAt || "",
          imageStylePrompt: account.imageStylePrompt || "",
          imageStylePromptStatus: account.imageStylePromptStatus || "missing",
          imageStylePromptSourceImageHash: account.imageStylePromptSourceImageHash || ""
        },
        getAccountImageStyle: () => readAccountStore(runtimeRoot,readSettings(runtimeRoot)).accounts.find(item=>item.id===account.id) || {},
        onAccountImageStylePrompt: (styleResult, source) => {
          const store = readAccountStore(runtimeRoot, readSettings(runtimeRoot));
          const target = store.accounts.find((item) => item.id === account.id);
          if (!saveStyleResult(target,source,styleResult)) return;
          const saved = writeAccountStore(runtimeRoot, store, readSettings(runtimeRoot));
          emit("accounts:update", withAccountImageUrls(runtimeRoot, saved));
        },
        onArticleReady: (draft) => {
          // Preview only: unreviewed text is never a resumable publish draft.
          emit("job:preview", {jobId,title:draft.title,article:draft.article,
            previewStage:draft.previewStage,writerAttempt:draft.writerAttempt,
            images:[],imageNotes:[],tags:draft.tags || []});
        },
        onResearchTitle: (researchResult) => {
          latestResearchTitleResult = researchResult || null;
          latestLaneResult = normalizeResearchLaneResult(researchResult, keywordLanePlan);
          const selectedTitle = String(researchResult.finalTitle || researchResult.selectedTitle || "").trim();
          emit("job:selectedTitle", {
            jobId,
            title: selectedTitle,
            status: researchResult.status || "",
            verdict: researchResult.status || "",
            factBased: researchResult.factBased === true,
            searchNeed: researchResult.searchNeed || "",
            at: new Date().toISOString()
          });
          if (selectedTitle && selectedTitle!==lastLoggedTitle) {
            lastLoggedTitle=selectedTitle;
            safeLog(jobId, `선정 제목: ${selectedTitle}`, "info", "main");
          }
          if (latestLaneResult.topicLane && latestLaneResult.topicLane!==lastLoggedLane) {
            lastLoggedLane=latestLaneResult.topicLane;
            safeLog(jobId, `선택 키워드 lane: ${latestLaneResult.topicLane}`, "info", "research");
          }
        },
        onFinalTitleCandidate: (title) => {
          const key = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
          return { duplicate: titleHistory.some(item => key(item.title) === key(title)), reason: '동일한 제목이 이미 있습니다.' };
        },
        onTokenUsage: (usage) => {
          jobTokenUsage.total = Number(usage.total || 0);
          jobTokenUsage.grossTotal = Number(usage.grossTotal || jobTokenUsage.grossTotal || 0);
          jobTokenUsage.inputTokens = Number(usage.inputTokens || 0);
          jobTokenUsage.cachedInputTokens = Number(usage.cachedInputTokens || 0);
          jobTokenUsage.outputTokens = Number(usage.outputTokens || 0);
          jobTokenUsage.promptCharacters = Number(usage.promptCharacters || jobTokenUsage.promptCharacters || 0);
          jobTokenUsage.estimatedPromptTokens = Number(usage.estimatedPromptTokens || jobTokenUsage.estimatedPromptTokens || 0);
          if (usage.rateLimits) {
            jobTokenUsage.rateLimits = usage.rateLimits;
          }
          emit("job:tokens", {
            jobId,
            total: jobTokenUsage.total,
            grossTotal: jobTokenUsage.grossTotal,
            inputTokens: jobTokenUsage.inputTokens,
            cachedInputTokens: jobTokenUsage.cachedInputTokens,
            outputTokens: jobTokenUsage.outputTokens,
            promptCharacters: jobTokenUsage.promptCharacters,
            estimatedPromptTokens: jobTokenUsage.estimatedPromptTokens,
            rateLimits: jobTokenUsage.rateLimits,
            agent: usage.agent || "",
            agentTotal: Number(usage.agentTotal || 0),
            agentDelta: Number(usage.agentDelta || 0),
            agentGrossDelta: Number(usage.agentGrossDelta || 0),
            final: usage.final === true,
            at: new Date().toISOString()
          });
        },
        onSearchNeeded: async (researchResult, context) => {
          const searchContext = context || {};
          const searchTopic = selectSearchTopicForResearch(researchResult, {
            topic,
            category,
            keyword,
            topicMode: "auto"
          });
          const laneResult = normalizeResearchLaneResult(researchResult, keywordLanePlan);
          const searchKeyword = laneResult.selectedKeywordPhrases.join(", ") || laneResult.topicLane || category;
          const authorityQueries = [];
          const intentQueries = [];
          const searchQueries = uniqueSearchQueries([...authorityQueries, ...laneResult.searchQueries, ...intentQueries], 4);
          laneResult.searchQueries = searchQueries;
          latestLaneResult = laneResult;
          if (authorityQueries.length) {
            safeLog(jobId, `공식 근거 보강 검색어: ${authorityQueries.join(" / ")}`, "info", "research");
          }
          if (searchContext.writerSupplement && searchContext.writerIssueReason) {
            safeLog(jobId, `Writer Agent 근거 부족 사유로 보강 검색합니다: ${searchContext.writerIssueReason}`, "warn", "research");
          }
          safeLog(jobId, `Research/Title Agent 요청으로 검색 후보 수집 시작: ${researchResult.searchNeed || "normal"}`, "info", "research");
          const researchIntentGuidance = String(researchResult.topicThesis || '');
          const researchGuidance = [
            researchIntentGuidance,
            researchResult.searchFlowSummary,
            researchResult.writerBrief,
            searchContext.writerIssueReason,
            ...(Array.isArray(researchResult.coreQuestions) ? researchResult.coreQuestions : []),
            ...(Array.isArray(researchResult.mustCover) ? researchResult.mustCover : []),
            ...(Array.isArray(researchResult.uncertainItems) ? researchResult.uncertainItems : [])
          ].filter(Boolean).join(" ");
          const searchResults = await retrieveResearch({
            topic: searchTopic,
            keyword: searchKeyword,
            category,
            publishPurpose: form.publishPurpose || "",
            researchGuidance,
            verificationQueries: researchResult.verificationQueries || [],
            evidenceRequests: researchResult.evidenceRequests || [],
            searchQueries: laneResult.searchQueries,
            searchNeed: researchResult.searchNeed || "",
            topicMode: "auto",
            primaryProvider: form.primarySearchProvider || "naver",
            fallbackProvider: form.fallbackSearchProvider || "google",
            naverSearchUrl: form.naverSearchUrl,
            googleSearchUrl: form.googleSearchUrl,
            searchChannel: form.searchChannel || "blog",
            trustBlogAsSource: form.trustBlogAsSource === true,
            freshnessLevel: form.freshnessLevel || "auto",
            currentDate: currentDateLabel
          }, (message, level) => safeLog(jobId, message, level, "research"),{context:retrievalContext});
          fs.writeFileSync(path.join(jobDir,"retrieval-audit.json"),JSON.stringify({searchRequests:retrievalContext.searchRequests,documentRequests:retrievalContext.documentRequests,events:retrievalContext.events},null,2));
          const mergedSearchResults = mergeSearchResults(searchResults, searchContext.previousSearchResults);
          safeLog(jobId, `검색 후보 수집 완료: ${searchResults.length}개, 누적 ${mergedSearchResults.length}개`, "info", "research");
          const sourceQuality = summarizeSourceQuality(mergedSearchResults, "auto", {
            topic: searchTopic,
            keyword: searchKeyword,
            category,
            publishPurpose: form.publishPurpose || "",
            researchGuidance,
            searchQueries: laneResult.searchQueries,
            searchNeed: researchResult.searchNeed || "",
            freshnessLevel: form.freshnessLevel || "auto",
            currentDate: currentDateLabel
          });
          if (sourceQuality.status === "insufficient") {
            safeLog(jobId, sourceQuality.reason, "warn", "research");
          }
          return { searchResults: mergedSearchResults, sourceQuality };
        }
      }, (message, level, agent = "main") => {
        const phaseMatch = String(message || "").match(/^(?:Codex 단계:\s*|(?=전체 시도 \d+\/\d+))(.+)$/);
        if (phaseMatch) {
          generationPhase = phaseMatch[1];
          updateStatus(jobId, "generating", `Codex ${generationPhase}`);
        }
        safeLog(jobId, message, level, agent);
      });
    } finally {
      clearInterval(generationHeartbeat);
    }
    generationAttempts=codexResult.attempts || [];
    if (codexResult.tokenUsage?.total) {
      jobTokenUsage.total = Number(codexResult.tokenUsage.total || 0);
      jobTokenUsage.grossTotal = Number(codexResult.tokenUsage.grossTotal || 0);
      jobTokenUsage.inputTokens = Number(codexResult.tokenUsage.inputTokens || 0);
      jobTokenUsage.cachedInputTokens = Number(codexResult.tokenUsage.cachedInputTokens || 0);
      jobTokenUsage.outputTokens = Number(codexResult.tokenUsage.outputTokens || 0);
      jobTokenUsage.promptCharacters = Number(codexResult.tokenUsage.promptCharacters || 0);
      jobTokenUsage.estimatedPromptTokens = Number(codexResult.tokenUsage.estimatedPromptTokens || 0);
      jobTokenUsage.agents = codexResult.tokenUsage.agents || {};
      jobTokenUsage.grossAgents = codexResult.tokenUsage.grossAgents || {};
      jobTokenUsage.promptCharactersByAgent = codexResult.tokenUsage.promptCharactersByAgent || {};
    }
    if (codexResult.tokenUsage?.rateLimits) {
      jobTokenUsage.rateLimits = codexResult.tokenUsage.rateLimits;
    }
    persistCodexRateLimits(runtimeRoot, jobTokenUsage.rateLimits);
    if (String(codexResult.status || "").toLowerCase() === "duplicate_retry") {
      writeSettings(runtimeRoot,{pendingGenerationDraft:null});
      const duplicateTitle = String(codexResult.title || codexResult.researchTitleResult?.finalTitle || "").trim();
      const duplicateEmbedding = createEmbedding(duplicateTitle);
      const duplicateSimilarity = Number(codexResult.duplicateSimilarity || 0);
      const duplicateEntry = {
        id: jobId,
        create_at: new Date().toISOString(),
        account_id: account.id || "",
        blog_id: blogId,
        title: duplicateTitle,
        topic,
        keyword,
        category,
        ...keywordLaneHistoryFields(latestLaneResult),
        status: "duplicate_retry",
        harness_version: "lean-agent-v1",
        final_verdict: "REVISION",
        failure_phase: "title_duplicate",
        research_title: duplicateTitle,
        embedding_model: "local-hash-v1",
        embedding: duplicateEmbedding,
        token_total: jobTokenUsage.total,
        token_gross_total: jobTokenUsage.grossTotal,
        token_input: jobTokenUsage.inputTokens,
        token_cached_input: jobTokenUsage.cachedInputTokens,
        token_output: jobTokenUsage.outputTokens,
        prompt_characters: jobTokenUsage.promptCharacters,
        token_agents: jobTokenUsage.agents,
        reason: codexResult.failureReason || `기존 제목과 cosine similarity ${duplicateSimilarity.toFixed(3)}`
      };
      appendHistory(runtimeRoot, duplicateEntry);
      safeLog(jobId, `${duplicateEntry.reason} — 본문·검수·이미지 생성을 생략했습니다.`, "warn");
      updateStatus(jobId, "duplicate_retry", "유사 제목으로 조기 중단");
      emit("job:complete", {
        ...nonSensitiveJob,
        status: "duplicate_retry",
        title: duplicateTitle,
        article: "",
        images: [],
        imageNotes: [],
        tokenUsage: jobTokenUsage,
        history: historyForUi(runtimeRoot)
      });
      return { status: "duplicate_retry", keywordLane: keywordLaneResultPayload(latestLaneResult) };
    }
    if(codexResult.article)latestAgentResultForResume={title:codexResult.title || codexResult.researchTitleResult?.finalTitle || '',article:codexResult.article,tags:codexResult.tags || [],bodyImages:[],titleImagePath:''};
    const sourceFailureReason = codexResult.status==='failed' ? (codexResult.failureReason || '생성을 완료하지 못했습니다.') : '';
    if (sourceFailureReason) {
      latestResearchTitleResult = codexResult.researchTitleResult || latestResearchTitleResult;
      latestLaneResult = normalizeResearchLaneResult(latestResearchTitleResult, keywordLanePlan);
      const sourceError = new Error(sourceFailureReason);
      sourceError.failurePhase = codexResult.failurePhase || (codexResult.researchTitleResult ? "research" : "");
      sourceError.failureKind = codexResult.failureKind || 'execution';
      throw sourceError;
    }
    const researchTitleResult = codexResult.researchTitleResult || {};

    const agentResult = normalizeAgentResult({
      runtimeRoot,
      jobDir,
      topic,
      keyword,
      includeTitleImage,
      maxBodyImages,
      currentDateLabel,
      result: codexResult
    });
    latestAgentResultForResume = agentResult;
    if(codexResult.publishable===false || agentResult.imageWarnings?.length){
      throw Object.assign(new Error([...(codexResult.notes || []),...(agentResult.imageWarnings || [])].join(' / ') || '이미지 생성을 완료하지 못했습니다. 본문을 보존하고 자동 진행을 중지합니다.'),{failureKind:'execution',failurePhase:'image'});
    }
    for (const note of agentResult.imageWarnings || []) {
      const imageNoteLevel = /실패|없|못|권한|거부|찾을 수 없|Access|EPERM|denied/i.test(String(note || ""))
        ? "warn"
        : "info";
      safeLog(jobId, note, imageNoteLevel);
    }

    const embedding = createEmbedding(agentResult.title);
    const tags = buildTags(topic, keyword, agentResult.tags);
    latestTagsForResume = tags;
    emit("job:preview", {
      jobId,
      title: agentResult.title,
      article: agentResult.article,
      images: getPreviewImages(agentResult),
      imageNotes: [...(agentResult.imageWarnings || []),...(codexResult.publishable===false ? codexResult.notes || [] : [])],
      tokenUsage: jobTokenUsage,
      tags
    });

    let publishStatus = "generated";
    let publishReason = [...(codexResult.publishable===false ? codexResult.notes || [] : []),...(agentResult.imageWarnings || [])].join(" / ");

    if (shouldPublish && codexResult.publishable !== false && !agentResult.imageWarnings?.length) {
      const durableDraft=buildPendingNaverPublishDraft({jobId,account,blogId,category,topic,keyword,agentResult,tags,publishPrivate,publishVisibility,publishScheduleMode,reserveAfterHours,breakSentencesInBody,publishToTistoryAfterNaver,tistoryBlogId,latestLaneResult,researchTitleResult,tokenUsage:jobTokenUsage});
      savePublicationState(runtimeRoot,durableDraft,jobId);
      writeSettings(runtimeRoot,{pendingGenerationDraft:null});
      updateStatus(jobId, "publishing", `Naver 블로그 ${publishVisibility === "draft" ? "임시저장" : publishVisibility === "public" ? "전체공개 발행" : "비공개 발행"} 자동화`);
      await publishSavedDraft(runtimeRoot,durableDraft,jobId);
      publishReason=publishVisibility==='draft'?(publishToTistoryAfterNaver ? '네이버 임시저장 및 티스토리 발행 완료.' : '네이버 임시저장 완료 · 빈 편집기 복귀 확인.'):tistoryBlogId ? '네이버와 티스토리 발행 완료.' : '네이버 발행 완료.';
      clearPendingNaverPublishDraft(runtimeRoot);
      publishStatus = publishVisibility==='draft'?'draft_saved':'success';
      updateStatus(jobId, publishStatus, publishReason);
    } else {
      publishReason = "사용자가 발행 실행을 끄고 생성만 실행했습니다.";
      writeSettings(runtimeRoot,{pendingGenerationDraft:null});
      updateStatus(jobId, "generated", "본문 생성 완료, 발행 대기");
    }

    const entry = {
      id: jobId,
      create_at: new Date().toISOString(),
      account_id: account.id || "",
      blog_id: blogId,
      title: agentResult.title,
      topic,
      keyword,
      category,
      ...keywordLaneHistoryFields(latestLaneResult),
      status: publishStatus,
      harness_version: "lean-agent-v1",
      final_verdict: "PASS",
      failure_phase: "",
      research_title: researchTitleResult.finalTitle || researchTitleResult.selectedTitle || "",
      topic_thesis: researchTitleResult.topicThesis || '',
      reader_question: researchTitleResult.writerContract?.contentStrategy?.primaryQuestion || '',
      topic_type: researchTitleResult.topicType || "",
      fact_based: researchTitleResult.factBased === true,
      source_summary: researchTitleResult.searchFlowSummary || "",
      embedding_model: "local-hash-v1",
      embedding,
      token_total: jobTokenUsage.total,
      token_gross_total: jobTokenUsage.grossTotal,
      token_input: jobTokenUsage.inputTokens,
      token_cached_input: jobTokenUsage.cachedInputTokens,
      token_output: jobTokenUsage.outputTokens,
      prompt_characters: jobTokenUsage.promptCharacters,
      token_agents: jobTokenUsage.agents,
      attempts:generationAttempts,
      reason: publishReason
    };
    appendHistory(runtimeRoot, entry);
    if (publishStatus === "success") {
      safeLog(jobId, "Naver 발행 완료");
    }

    emit("job:complete", {
      ...nonSensitiveJob,
      status: publishStatus,
      title: agentResult.title,
      article: agentResult.article,
      images: getPreviewImages(agentResult),
        imageNotes: agentResult.imageWarnings || [],
      tokenUsage: jobTokenUsage,
      tags,
      history: historyForUi(runtimeRoot)
    });
    return { status: publishStatus, keywordLane: keywordLaneResultPayload(latestLaneResult) };
  } catch (error) {
    if(error.failureKind==='quality')writeSettings(runtimeRoot,{pendingGenerationDraft:null});
    const failedStatus = error.code === "SESSION_EXPIRED"
      ? "session_expired"
      : error.code === "PUBLISH_UNCERTAIN" ? "publish_uncertain"
      : error.code === "CODEX_USAGE_LIMIT" ? "codex_usage_limit"
        : error.code === "CODEX_EXEC_FAILED" ? "codex_exec_failed"
          : "failed";
    persistCodexRateLimits(runtimeRoot, jobTokenUsage.rateLimits);
    if(error.code==='PUBLISH_UNCERTAIN')writeSettings(runtimeRoot,{pendingNaverPublishDraft:{...readSettings(runtimeRoot).pendingNaverPublishDraft,status:'publish_uncertain'}});
    if (failedStatus === "session_expired" && account.id) {
      updateAccountSession(runtimeRoot, account.id, "expired", settings);
      emitAccountStore(runtimeRoot);
      const pendingDraft = buildPendingNaverPublishDraft({
        jobId,
        account,
        blogId,
        category,
        topic,
        keyword,
        agentResult: latestAgentResultForResume,
        tags: latestTagsForResume,
        publishPrivate,
        publishVisibility,
        publishScheduleMode,
        reserveAfterHours,
        breakSentencesInBody,
        publishToTistoryAfterNaver,
        tistoryBlogId,
        latestLaneResult,
        researchTitleResult: latestResearchTitleResult,
        tokenUsage: jobTokenUsage
      });
      if (pendingDraft) {
        writeSettings(runtimeRoot, { pendingNaverPublishDraft: pendingDraft });
        safeLog(jobId, "Naver 작성 완료 draft를 보존했습니다. 세션확인 후 재생성 없이 발행을 이어갑니다.", "warn");
      }
    }
    const embedding = createEmbedding(`${topic} ${keyword}`.trim() || topic);
    appendHistory(runtimeRoot, {
      id: jobId,
      create_at: new Date().toISOString(),
      account_id: account.id || "",
      blog_id: blogId,
      title: latestAgentResultForResume?.title || "",
      topic,
      keyword,
      category,
      ...keywordLaneHistoryFields(latestLaneResult),
      status: failedStatus,
      embedding_model: "local-hash-v1",
      embedding,
      token_total: jobTokenUsage.total,
      token_gross_total: jobTokenUsage.grossTotal,
      token_input: jobTokenUsage.inputTokens,
      token_cached_input: jobTokenUsage.cachedInputTokens,
      token_output: jobTokenUsage.outputTokens,
      prompt_characters: jobTokenUsage.promptCharacters,
      token_agents: jobTokenUsage.agents,
      attempts:error.attempts || generationAttempts,
      failure_phase: error.failurePhase || "",
      failure_kind: error.failureKind || "execution",
      research_title: latestResearchTitleResult?.finalTitle || latestResearchTitleResult?.selectedTitle || "",
      reason: error.message
    });
    safeLog(jobId, error.message, "error");
    updateStatus(jobId, failedStatus, error.message);
    emit("job:complete", {
      ...nonSensitiveJob,
      status: failedStatus,
      title: latestAgentResultForResume?.title || "",
      article: latestAgentResultForResume?.article || "",
      images: latestAgentResultForResume ? getPreviewImages(latestAgentResultForResume) : [],
      failurePhase: error.failurePhase || "",
      failureKind: error.failureKind || 'execution',
      reason: error.message,
      tokenUsage: jobTokenUsage,
      tags: latestTagsForResume,
      history: historyForUi(runtimeRoot)
    });
    return {
      status: failedStatus,
      reason: error.message,
      failurePhase: error.failurePhase || "",
      failureKind: error.failureKind || 'execution',
      keywordLane: keywordLaneResultPayload(latestLaneResult)
    };
  } finally {
    activeJob = null;
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('window:theme', (event, theme) => {
    if (event.sender !== mainWindow?.webContents || !['dark','light'].includes(theme)) return;
    if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay({color:theme === 'light' ? '#eaf5ed' : '#152030',symbolColor:theme === 'light' ? '#24352a' : '#edf3fc',height:40});
  });
  const bridge=configureBridge(getRuntimeRoot(),process.env.BLOGAUTO_TEST_BRIDGE_PORT === '0' ? 0 : undefined);

  try {await bridge.start();}catch(error){bridgeError='확장 연결 포트를 사용할 수 없습니다. 다른 BlogAuto 앱을 종료하고 다시 실행하세요. '+error.message;}
  bridge.on('status',()=>emit('accounts:update',connectionStore()));
  bridge.on('progress',(_accountId,message)=>{if(activeJob)safeLog(activeJob.id,message);});
  ensureRuntimeFiles(getRuntimeRoot());
  ensureSettingsFile(getRuntimeRoot());
  ensureAccountStoreFile(getRuntimeRoot(), readSettings(getRuntimeRoot()));
  createWindow();

  ipcMain.handle("app:getInitialData", () => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    return {
      runtimeRoot,
      codexCmdPath: resolveCodexCmdPath(settings.codexCmdPath),
      codexInstallation: require('./lib/codexPlatform').detectCodexInstallation(settings.codexCmdPath),
      chrome: detectChromeInstall(),
      settings,
      accountStore: connectionStore(),
      bridgeError,
      pendingPreview:settings.pendingNaverPublishDraft ? {...settings.pendingNaverPublishDraft,images:getPreviewImages(settings.pendingNaverPublishDraft)} : null,
      history: historyForUi(runtimeRoot)
    };
  });

  ipcMain.handle('codex:models', () => require('./lib/codexModels').getCodexCatalog(readSettings(getRuntimeRoot()).codexCmdPath));
  ipcMain.handle("chrome:installAndQuit", async () => {
    await shell.openExternal("https://www.google.com/chrome/");
    setTimeout(() => app.quit(), 500);
    return true;
  });

  ipcMain.handle("settings:save", (_event, settings) => {
    const runtimeRoot = getRuntimeRoot();
    return writeSettings(runtimeRoot, settings);
  });
  ipcMain.handle("codex:refreshUsage", async () => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const savedRateLimits = settings.codexRateLimits || null;
    if (activeJob || process.env.BLOGAUTO_SKIP_CODEX_USAGE_REFRESH === "1") {
      return {
        skipped: true,
        rateLimits: savedRateLimits,
        tokenUsage: {
          total: 0,
          rateLimits: savedRateLimits
        }
      };
    }
    let snapshot;
    try {
      snapshot = await fetchCodexUsageSnapshot({
        codexCmdPath: resolveCodexCmdPath(settings.codexCmdPath),
        cwd: runtimeRoot
      });
    } catch (error) {
      snapshot = {
        source: "unavailable",
        unavailableReason: error instanceof Error ? error.message : String(error || "Codex 사용량 조회 실패"),
        rateLimits: null,
        tokenUsage: {
          total: 0,
          rateLimits: null
        }
      };
    }
    if (snapshot.rateLimits) {
      persistCodexRateLimits(runtimeRoot, snapshot.rateLimits);
    }
    if (!snapshot.rateLimits && savedRateLimits) {
      return {
        ...snapshot,
        source: snapshot.source || "saved",
        savedFallback: true,
        rateLimits: savedRateLimits,
        tokenUsage: {
          ...(snapshot.tokenUsage || {}),
          total: Number(snapshot.tokenUsage?.total || 0),
          rateLimits: savedRateLimits
        }
      };
    }
    return snapshot;
  });
  ipcMain.handle("accounts:save", (_event, store) => {
    const runtimeRoot = getRuntimeRoot();
    const existing = readAccountStore(runtimeRoot, readSettings(runtimeRoot));
    if (pendingPublishBusy() && existing.accounts.some(account => !store.accounts?.some(next => next.id === account.id))) {
      throw new Error("작업 진행 중에는 계정을 삭제할 수 없습니다. 작업 종료 후 다시 시도하세요.");
    }
    writeAccountStore(runtimeRoot, store, readSettings(runtimeRoot));
    const publicStore = connectionStore();
    emit("accounts:update", publicStore);
    return publicStore;
  });
  ipcMain.handle("accounts:chooseSampleImage", async (_event, accountId) => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    let store = readAccountStore(runtimeRoot, settings);
    let account = store.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose sample image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return withAccountImageUrls(runtimeRoot, readAccountStore(runtimeRoot,settings));
    }
    // The file picker yields: preserve edits and account deletions made while open.
    store=readAccountStore(runtimeRoot,settings);
    account=store.accounts.find(item=>item.id===accountId);
    if(!account)throw new Error('이미지를 등록할 계정이 삭제되었습니다.');
    const sourcePath = result.filePaths[0];
    const destDir = accountAssetDir(runtimeRoot, account.id);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = accountSampleImagePath(runtimeRoot, account.id, sourcePath);
    fs.copyFileSync(sourcePath, destPath);
    const nextHash = fileHash(destPath);
    const changed = nextHash !== account.sampleImageHash;
    account.sampleImagePath = destPath;
    account.sampleImageHash = nextHash;
    account.sampleImageUpdatedAt = new Date().toISOString();
    if (changed) {
      account.imageStylePromptStatus = account.imageStylePrompt ? "stale" : "missing";
      account.imageStylePromptError = "";
    }
    const saved = writeAccountStore(runtimeRoot, store, settings);
    const publicStore = withAccountImageUrls(runtimeRoot, saved);
    emit("accounts:update", publicStore);
    return publicStore;
  });
  ipcMain.handle("accounts:deleteSampleImage", (_event, accountId) => {
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const store = readAccountStore(runtimeRoot, settings);
    const account = store.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    const samplePath = String(account.sampleImagePath || "");
    const assetRoot = path.resolve(accountAssetDir(runtimeRoot, account.id));
    const resolvedSample = samplePath ? path.resolve(samplePath) : "";
    if (resolvedSample && resolvedSample.startsWith(assetRoot) && fs.existsSync(resolvedSample)) {
      fs.rmSync(resolvedSample, { force: true });
    }
    account.sampleImagePath = "";
    account.sampleImageHash = "";
    account.sampleImageUpdatedAt = "";
    account.imageStylePrompt = "";
    account.imageStylePromptUpdatedAt = "";
    account.imageStylePromptStatus = "missing";
    account.imageStylePromptSourceImageHash = "";
    account.imageStylePromptError = "";
    const saved = writeAccountStore(runtimeRoot, store, settings);
    const publicStore = withAccountImageUrls(runtimeRoot, saved);
    emit("accounts:update", publicStore);
    return publicStore;
  });
  let bulkSessionPromise = null;
  ipcMain.handle('accounts:checkAllSessions', () => {
    if (bulkSessionPromise) return bulkSessionPromise;
    if (pendingPublishBusy()) throw new Error('작업 종료 후 세션 일괄 확인을 실행하세요.');
    const runtimeRoot=getRuntimeRoot();
    const accounts=readAccountStore(runtimeRoot,readSettings(runtimeRoot)).accounts;
    bulkSessionPromise=require('./lib/bulkSessions').checkBulkSessions(accounts,{
      bridge:getBridge(),
      open:account=>require('./lib/chromeLauncher').openAccountChrome(runtimeRoot,account,shell),
      check:account=>account.platform==='tistory'
        ? checkTistorySession({tistoryBlogId:account.blogId,interactiveLogin:true})
        : checkNaverSession({accountId:account.id,blogId:account.blogId,interactiveLogin:true}),
      log:message=>safeLog('session',message)
    }).finally(()=>{bulkSessionPromise=null;emit('accounts:update',connectionStore());});
    return bulkSessionPromise;
  });
  ipcMain.handle('accounts:checkSession', async (_event,accountId,options={}) => {
    const account=readAccountStore(getRuntimeRoot(),readSettings(getRuntimeRoot())).accounts.find(a=>a.id===accountId);
    if(!account) throw new Error('계정을 찾을 수 없습니다.');
    const result=await checkNaverSession({accountId,blogId:account.blogId,interactiveLogin:options.interactive!==false});
    emit('accounts:update',connectionStore());
    const {preparedSession,...publicResult}=result; return publicResult;
  });
  ipcMain.handle('chrome:openAccount',async(_event,id)=>{
    const account=readAccountStore(getRuntimeRoot(),readSettings(getRuntimeRoot())).accounts.find(a=>a.id===id);
    if(!account)throw new Error('먼저 블로그 계정을 추가하세요.');
    return require('./lib/chromeLauncher').openAccountChrome(getRuntimeRoot(),account,shell);
  });
  ipcMain.handle('tistory:open',async(_event,blogId)=>require('./lib/chromeLauncher').openAccountChrome(getRuntimeRoot(),tistoryAccount(blogId),shell));
  ipcMain.handle('tistory:pair',(_event,blogId)=>{
    const account=tistoryAccount(blogId);
    const pairing=getBridge().pairCode(account.id,account.blogId,account.label,'tistory');
    clipboard.writeText(pairing.code);return pairing;
  });
  ipcMain.handle('extension:setup', async()=>{const folder=prepareExtension();await shell.openPath(folder);return {folder};});
  ipcMain.handle('extension:copy',()=>{clipboard.writeText('chrome://extensions');return true;});
  ipcMain.handle('extension:pair',(_event,accountId)=>{
    if(bridgeError)throw new Error(bridgeError);
    const account=readAccountStore(getRuntimeRoot(),readSettings(getRuntimeRoot())).accounts.find(a=>a.id===accountId);
    if(!account)throw new Error('먼저 계정을 추가하세요.');
    const pairing=getBridge().pairCode(account.id,account.blogId,account.label);clipboard.writeText(pairing.code);return pairing;
  });
  ipcMain.handle('extension:connections',()=>connectionStore());
  ipcMain.handle('extension:cancel',(_event,id)=>{getBridge().cancelAccount(id);return connectionStore();});

  ipcMain.handle('extension:revoke',(_event,id)=>{getBridge().revoke(id);return connectionStore();});
  ipcMain.handle("tistory:checkSession", async (_event, tistoryBlogId) => {
    if (activeJob) {
      throw new Error("작업 실행 중에는 티스토리 세션을 확인할 수 없습니다.");
    }
    const runtimeRoot = getRuntimeRoot();
    const settings = readSettings(runtimeRoot);
    const selectedBlogId = String(tistoryBlogId || settings.tistoryBlogId || "").trim();
    const browserProfileDir = getTistoryProfileDir(runtimeRoot, selectedBlogId);
    const key = tistorySessionKey(selectedBlogId, browserProfileDir);
    const existingTistorySession = reusableTistorySession(key);
    const result = existingTistorySession
      ? {
        status: "valid",
        reason: "reused_open_tistory_editor",
        url: existingTistorySession.page?.url?.() || "",
        preparedSession: existingTistorySession
      }
      : await checkTistorySession({
        tistoryBlogId: selectedBlogId,
        browserProfileDir,
        runtimeRoot,
        keepOpen: true,
        log: (message, level) => safeLog("session", message, level)
      });
    if (result.preparedSession) {
      activeTistorySessions.set(key, result.preparedSession);
    }
    writeSettings(runtimeRoot, {
      tistoryBlogId: selectedBlogId,
      tistorySessionStatus: result.status === "valid" ? "valid" : "unknown",
      tistorySessionCheckedAt: new Date().toISOString()
    });
    return {
      status: result.status,
      reason: result.reason || "",
      url: result.url || ""
    };
  });
  ipcMain.handle("tistory:testPublish", (_event, form) => startTistoryTestPublish(form));
  ipcMain.handle("history:load", () => historyForUi(getRuntimeRoot()));
  ipcMain.handle('history:retry', (_event, {id,form}) => {
    if(pendingPublishBusy())throw new Error('진행 중인 작업을 마친 뒤 재시도하세요.');
    const root=getRuntimeRoot(),settings=readSettings(root),history=readHistory(root),store=readAccountStore(root,settings);
    const item=history.find(h=>h.id===id);if(!item)throw new Error('작업 이력을 찾을 수 없습니다.');
    const plan=retryPlan(root,item,history,settings,store.accounts);
    if(!plan.allowed)throw new Error(plan.reason);
    const target={accountId:plan.accountId,blogId:plan.blogId,category:plan.category,jobId:plan.sourceId,retryRootId:plan.rootId};
    writeSettings(root,plan.mode==='publish'
      ? {pendingNaverPublishDraft:{...plan.draft,...target},pendingGenerationDraft:null}
      : {pendingNaverPublishDraft:null,pendingGenerationDraft:{...target,status:'generation_pending',checkpoint:plan.checkpoint || null}});
    return startJob({...form,accountId:plan.accountId,blogId:plan.blogId,category:plan.category});
  });
  ipcMain.handle('job:pendingState',()=>pendingPublishState(getRuntimeRoot(),pendingPublishBusy()));
  ipcMain.handle('job:cancelPending',()=>cancelPendingPublish(getRuntimeRoot(),pendingPublishBusy()));
  ipcMain.handle("job:start", (_event, form) => startJob(form));
  ipcMain.handle('job:modelRetry', (event, choice) => {
    if(event.sender!==mainWindow?.webContents || !modelRetryPending || choice.id!==modelRetryPending.id)return false;
    if(!['retry','cancel'].includes(choice.action))return false;
    if(choice.action==='retry' && choice.model && normalizeCodexModel(choice.model)!==choice.model)throw new Error('지원하지 않는 모델입니다.');
    const pending=modelRetryPending;modelRetryPending=null;
    pending.resolve({action:choice.action,model:choice.model});return true;
  });
  ipcMain.handle("file:open", (_event, filePath) => {
    if (!filePath) return false;
    const runtimeRoot = path.resolve(getRuntimeRoot());
    const resolved = path.resolve(String(filePath));
    if (path.relative(runtimeRoot, resolved).startsWith('..') || path.isAbsolute(path.relative(runtimeRoot, resolved))) {
      throw new Error("런타임 폴더 밖의 파일은 열 수 없습니다.");
    }
    return shell.openExternal(pathToFileURL(resolved).toString());
  });
  ipcMain.handle("file:showInFolder", (_event, filePath) => {
    if (!filePath) return false;
    const runtimeRoot = path.resolve(getRuntimeRoot());
    const resolved = path.resolve(String(filePath));
    if (path.relative(runtimeRoot, resolved).startsWith('..') || path.isAbsolute(path.relative(runtimeRoot, resolved))) {
      throw new Error("런타임 폴더 밖의 파일 위치는 열 수 없습니다.");
    }
    shell.showItemInFolder(resolved);
    return true;
  });

  if (process.env.BLOGAUTO_AUTOSTART === "1") {
    const runAutostart = () => {
      const runtimeRoot = getRuntimeRoot();
      const settings = readSettings(runtimeRoot);
      setTimeout(() => {
        startJob(settings).catch((error) => {
          safeLog("autorun", error.message, "error");
          updateStatus("autorun", "failed", error.message);
        });
      }, 700);
    };

    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once("did-finish-load", runAutostart);
    } else {
      runAutostart();
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const key of activeTistorySessions.keys()) {
    closeTistorySession(key).catch(() => {});
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  getBridge().stop();
});
