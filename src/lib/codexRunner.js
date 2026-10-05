const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { normalizeMaxBodyImages, normalizeCodexModel } = require("./settings");
const { buildCodexEnvironment } = require("./codexPlatform");

const DEFAULT_AGENT_MODELS = {
  main: "high",
  research: "high",
  writer: "high",
  image: "medium",
  imageStyle: "medium"
};
const VALID_AGENT_MODEL_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1", "3:4"]);
const CODEX_USAGE_LIMIT_TYPES = new Set([
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);
const AGENT_DISPLAY_NAMES = {
  main: "Main Agent",
  research: "Research/Title Agent",
  writer: "Writer Agent",
  image: "Image Worker",
  imageStyle: "Image Style Agent"
};

function normalizeAgentModels(models = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_MODELS).map(([agent, fallback]) => {
    const value = String(models?.[agent] || fallback);
    return [agent, VALID_AGENT_MODEL_EFFORTS.has(value) ? value : fallback];
  }));
}

function modelEffortForAgent(options, agent) {
  if (agent === 'humanizer') return normalizeAgentModels(options.agentModels).writer;
  return normalizeAgentModels(options.agentModels)[agent] || DEFAULT_AGENT_MODELS[agent] || "high";
}

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function agentDisplayName(agent) {
  if (agent === 'humanizer') return 'Blog Humanizer';
  return AGENT_DISPLAY_NAMES[String(agent || "").toLowerCase()] || "Agent";
}

function shouldRunCodexViaShell(commandPath) {
  if (process.platform !== "win32") return false;
  const value = String(commandPath || "");
  const ext = path.extname(value).toLowerCase();
  return ext === ".cmd" || ext === ".bat" || !path.isAbsolute(value);
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeRateLimitType(value) {
  return String(value || "")
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/[A-Z]/g, (char, index) => `${index ? "_" : ""}${char.toLowerCase()}`)
    .replace(/__+/g, "_")
    .replace(/^rate_limit_reached_type[:=]/i, "")
    .trim()
    .toLowerCase();
}

function createCodexUsageLimitError(rateLimitType = "", detail = "") {
  const normalizedType = normalizeRateLimitType(rateLimitType);
  const isUsageLimit = CODEX_USAGE_LIMIT_TYPES.has(normalizedType) || /usage_limit/i.test(normalizedType);
  const message = isUsageLimit
    ? "Codex 사용량 한도에 도달해 작업을 중단합니다. 한도가 초기화되거나 사용량이 추가된 뒤 다시 실행해 주세요."
    : "Codex 한도에 도달해 작업을 중단합니다. 한도가 초기화되거나 제한이 해제된 뒤 다시 실행해 주세요.";
  const error = new Error(message);
  error.code = "CODEX_USAGE_LIMIT";
  error.codexRateLimitType = normalizedType || "unknown";
  error.codexLimitDetail = String(detail || "").slice(0, 1000);
  return error;
}

function createCodexExecutionError(message, { model = "", detail = "" } = {}) {
  const activeModel = model ? ` 현재 Codex 모델: ${model}.` : "";
  const diagnostic = detail ? `\n마지막 Codex 출력: ${detail}` : "";
  const error = new Error(`${message}${activeModel} Codex CLI 실행환경, 로그인 상태, 모델 설정을 확인해 주세요.${diagnostic}`);
  error.code = "CODEX_EXEC_FAILED";
  error.failurePhase = "codex";
  error.codexModel = model || "";
  error.codexExecutionDetail = String(detail || "").slice(0, 1000);
  return error;
}

function isCodexUsageLimitError(error) {
  return error?.code === "CODEX_USAGE_LIMIT";
}

function tryParseJsonLine(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectRateLimitReachedTypes(value, found = [], depth = 0) {
  if (!value || depth > 8) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectRateLimitReachedTypes(item, found, depth + 1);
    return found;
  }
  if (typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    if (["rate_limit_reached_type", "rateLimitReachedType", "x-codex-rate-limit-reached-type"].includes(key)) {
      const type = normalizeRateLimitType(nested);
      if (type && type !== "null" && type !== "undefined") found.push(type);
    }
    collectRateLimitReachedTypes(nested, found, depth + 1);
  }
  return found;
}

function detectCodexUsageLimitSignal(line) {
  const text = stripAnsi(line).trim();
  if (!text) return null;

  const parsed = tryParseJsonLine(text);
  const jsonTypes = parsed ? collectRateLimitReachedTypes(parsed) : [];
  const directMatch = text.match(/\b(workspace_owner_usage_limit_reached|workspace_member_usage_limit_reached)\b/i);
  const type = normalizeRateLimitType(jsonTypes[0] || directMatch?.[1] || "");
  if (CODEX_USAGE_LIMIT_TYPES.has(type)) {
    return { type, detail: text };
  }

  if (/\bUsageLimitExceeded\b/i.test(text)) {
    return { type: "usage_limit_exceeded", detail: text };
  }
  if (/\busage[_ -]?limit\b/i.test(text) && /\b(reached|exceeded|exhausted|hit)\b/i.test(text)) {
    return { type: "usage_limit_message", detail: text };
  }
  return null;
}

function jsonTokenTotal(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info?.total_token_usage?.total_tokens,
    payload?.info?.last_token_usage?.total_tokens,
    payload?.info?.total_tokens,
    payload?.total_token_usage?.total_tokens,
    payload?.last_token_usage?.total_tokens,
    payload?.total_tokens,
    event?.info?.total_token_usage?.total_tokens,
    event?.info?.last_token_usage?.total_tokens,
    event?.total_token_usage?.total_tokens
  ];
  for (const candidate of candidates) {
    const total = Number(candidate);
    if (Number.isFinite(total) && total >= 0) return total;
  }
  return null;
}

function normalizeTokenNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function tokenUsageFromInfo(info = {}) {
  const totalUsage = info?.total_token_usage || null;
  const lastUsage = info?.last_token_usage || null;
  const grossTotal = normalizeTokenNumber(totalUsage?.total_tokens);
  const inputTokens = normalizeTokenNumber(totalUsage?.input_tokens);
  const cachedInputTokens = normalizeTokenNumber(totalUsage?.cached_input_tokens);
  const outputTokens = normalizeTokenNumber(totalUsage?.output_tokens);
  const lastTotal = normalizeTokenNumber(lastUsage?.total_tokens);
  const lastInputTokens = normalizeTokenNumber(lastUsage?.input_tokens);
  const lastCachedInputTokens = normalizeTokenNumber(lastUsage?.cached_input_tokens);
  const lastOutputTokens = normalizeTokenNumber(lastUsage?.output_tokens);

  let total = null;
  if (inputTokens !== null || outputTokens !== null) {
    total = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0)) + (outputTokens || 0);
  } else if (grossTotal !== null) {
    total = grossTotal;
  } else if (lastInputTokens !== null || lastOutputTokens !== null) {
    total = Math.max(0, (lastInputTokens || 0) - (lastCachedInputTokens || 0)) + (lastOutputTokens || 0);
  } else if (lastTotal !== null) {
    total = lastTotal;
  }

  if (total === null && grossTotal === null && lastTotal === null) return null;
  return {
    total: total || 0,
    grossTotal: grossTotal ?? lastTotal ?? total ?? 0,
    inputTokens: inputTokens || 0,
    cachedInputTokens: cachedInputTokens || 0,
    outputTokens: outputTokens || 0,
    lastTotal: lastTotal || 0,
    lastInputTokens: lastInputTokens || 0,
    lastCachedInputTokens: lastCachedInputTokens || 0,
    lastOutputTokens: lastOutputTokens || 0
  };
}

function jsonTokenUsage(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info,
    payload,
    event?.info,
    event
  ];
  for (const candidate of candidates) {
    const usage = tokenUsageFromInfo(candidate);
    if (usage) return usage;
  }
  const total = jsonTokenTotal(event);
  return total === null ? null : { total, grossTotal: total };
}

function normalizePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}

function normalizeCodexRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = normalizePercent(window.used_percent ?? window.usedPercent);
  const remainingPercent = usedPercent === null ? null : Number((100 - usedPercent).toFixed(2));
  const windowMinutes = Number(window.window_minutes ?? window.windowMinutes);
  return {
    usedPercent,
    remainingPercent,
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    resetsAt: String(window.resets_at ?? window.resetsAt ?? "")
  };
}

function normalizeCodexRateLimits(rawRateLimits) {
  if (!rawRateLimits || typeof rawRateLimits !== "object") return null;
  const primary = normalizeCodexRateLimitWindow(rawRateLimits.primary);
  const secondary = normalizeCodexRateLimitWindow(rawRateLimits.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: String(rawRateLimits.limit_id ?? rawRateLimits.limitId ?? ""),
    limitName: rawRateLimits.limit_name ?? rawRateLimits.limitName ?? null,
    primary,
    secondary,
    credits: rawRateLimits.credits ?? null,
    planType: String(rawRateLimits.plan_type ?? rawRateLimits.planType ?? ""),
    rateLimitReachedType: normalizeRateLimitType(rawRateLimits.rate_limit_reached_type ?? rawRateLimits.rateLimitReachedType ?? ""),
    updatedAt: new Date().toISOString()
  };
}

function jsonRateLimits(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info?.rate_limits,
    payload?.rate_limits,
    event?.info?.rate_limits,
    event?.rate_limits
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCodexRateLimits(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function codexSessionsRoot() {
  const codexHome = String(process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function listRecentSessionFiles(root, limit = 80) {
  if (!root || !fs.existsSync(root)) return [];
  const stack = [root];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);
}

function readLatestCodexRateLimitsFromSessions() {
  const files = listRecentSessionFiles(codexSessionsRoot());
  for (const filePath of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/).reverse();
    for (const line of lines) {
      const parsed = tryParseJsonLine(line);
      if (!parsed) continue;
      const rateLimits = jsonRateLimits(parsed);
      if (!rateLimits) continue;
      rateLimits.updatedAt = String(parsed.timestamp || rateLimits.updatedAt || new Date().toISOString());
      rateLimits.source = "codex-session";
      return {
        source: "codex-session",
        tokenUsage: {
          ...(jsonTokenUsage(parsed) || { total: 0, grossTotal: jsonTokenTotal(parsed) || 0 }),
          rateLimits
        },
        rateLimits
      };
    }
  }
  return null;
}

function normalizePathForSearch(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function sessionCwdFromRaw(raw) {
  for (const line of String(raw || "").split(/\r?\n/).slice(0, 40)) {
    const parsed = tryParseJsonLine(line);
    if (!parsed) continue;
    const cwd = parsed?.payload?.cwd;
    if (typeof cwd === "string" && cwd.trim()) return cwd;
  }
  return "";
}

function sessionMatchesJob(raw, jobDir, resultPath) {
  const normalizedJobDir = normalizePathForSearch(jobDir);
  const normalizedResultPath = normalizePathForSearch(resultPath);
  const sessionCwd = sessionCwdFromRaw(raw);
  if (sessionCwd) {
    return normalizePathForSearch(sessionCwd) === normalizedJobDir;
  }
  const searchable = normalizePathForSearch(raw);
  return searchable.includes(normalizedResultPath) || searchable.includes(normalizedJobDir);
}

function readLatestCodexTokenUsageFromSessions({
  sinceMs = 0,
  jobDir = "",
  resultFileName = ""
} = {}) {
  const expectedResultPath = resultFileName && jobDir
    ? normalizePathForSearch(path.join(jobDir, resultFileName))
    : "";
  const files = listRecentSessionFiles(codexSessionsRoot(), 120);
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (sinceMs && stat.mtimeMs < sinceMs - 10000) continue;
    } catch {
      continue;
    }

    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }

    if (expectedResultPath && !sessionMatchesJob(raw, jobDir, path.join(jobDir, resultFileName))) continue;

    let latestUsage = null;
    let latestRateLimits = null;
    let updatedAt = "";
    for (const line of raw.split(/\r?\n/)) {
      const parsed = tryParseJsonLine(line);
      if (!parsed) continue;
      const parsedUsage = jsonTokenUsage(parsed);
      if (parsedUsage) {
        latestUsage = parsedUsage;
        updatedAt = String(parsed.timestamp || updatedAt || "");
      }
      const parsedRateLimits = jsonRateLimits(parsed);
      if (parsedRateLimits) {
        latestRateLimits = parsedRateLimits;
        latestRateLimits.updatedAt = String(parsed.timestamp || latestRateLimits.updatedAt || new Date().toISOString());
        latestRateLimits.source = "codex-session";
        updatedAt = String(parsed.timestamp || updatedAt || "");
      }
    }
    if (latestUsage || latestRateLimits) {
      return {
        source: "codex-session",
        sessionFile: filePath,
        updatedAt,
        tokenUsage: {
          ...(latestUsage || { total: 0, grossTotal: 0 }),
          rateLimits: latestRateLimits
        },
        rateLimits: latestRateLimits
      };
    }
  }
  return null;
}

function pushAssistantContentText(content, texts) {
  if (typeof content === "string") {
    texts.push(content);
    return;
  }
  if (!content) return;
  if (Array.isArray(content)) {
    for (const item of content) pushAssistantContentText(item, texts);
    return;
  }
  if (typeof content !== "object") return;
  if (typeof content.text === "string") texts.push(content.text);
  if (typeof content.output_text === "string") texts.push(content.output_text);
  if (typeof content.message === "string") texts.push(content.message);
}

function extractAssistantOutputTexts(event) {
  const payload = event?.payload || event || {};
  const item = payload.item || payload.payload || payload;
  const texts = [];

  if (payload.type === "agent_message" && typeof payload.message === "string") {
    texts.push(payload.message);
  }
  if (payload.type === "response_item" && item?.role === "assistant") {
    pushAssistantContentText(item.content, texts);
  }
  if (item?.type === "message" && item?.role === "assistant") {
    pushAssistantContentText(item.content, texts);
  }
  if (item?.type === "agent_message" && typeof item.message === "string") {
    texts.push(item.message);
  }
  if (payload.type === "agent_message_delta" && typeof payload.delta === "string") {
    texts.push(payload.delta);
  }
  return texts;
}

function isUsefulCodexFeedback(line) {
  const text = stripAnsi(line).trim();
  if (!text) return false;
  if (looksLikeMojibake(text)) return false;
  if (/^OpenAI Codex\b/i.test(text)) return false;
  if (/^-{3,}$/.test(text)) return false;
  if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(text)) return false;
  if (/^(user|assistant)$/i.test(text)) return false;
  if (/^BLOGAUTO_RESULT_READY$/i.test(text)) return false;
  if (/^mcp:/i.test(text)) return false;
  if (/codex_core::tools::router/i.test(text)) return false;
  if (/codex_core_plugins::manifest/i.test(text)) return false;
  if (/ignoring interface\.defaultPrompt/i.test(text)) return false;
  if (/^Wall time:/i.test(text)) return false;
  if (/^Output:/i.test(text)) return false;
  if (/ConvertFrom-Json|CategoryInfo|FullyQualifiedErrorId/i.test(text)) return false;
  if (/^(Get-Content|Invoke-WebRequest|Set-Content|Out-File|Copy-Item|Move-Item|Remove-Item)\s*:/i.test(text)) return false;
  if (/Cannot find path|because it does not exist|원격 서버에 연결할 수 없습니다|액세스가 거부되었습니다|AccessException|PermissionDenied|Exception\b|At line:/i.test(text)) return false;
  if (/^위치\s+줄|^At line:/i.test(text)) return false;
  if (/^\+\s+/.test(text)) return false;
  if (/^[\{\}\],]+$/.test(text)) return false;
  const inlineJsonFragment = text.startsWith("{") || text.startsWith("[")
    ? text.slice(1).trimStart()
    : "";
  if (inlineJsonFragment.startsWith("\"") && inlineJsonFragment.indexOf("\":") > 1) return false;
  const inlineJsonColonIndex = inlineJsonFragment.indexOf(":");
  if (inlineJsonColonIndex > 0 && /^[A-Za-z0-9_$-]+$/.test(inlineJsonFragment.slice(0, inlineJsonColonIndex))) return false;
  if (/^"[^"]+"\s*:\s*/.test(text)) return false;
  if (/^"[^"]*"\s*,?$/.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}T.*\b(WARN|DEBUG|TRACE)\b/i.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}T.*\bERROR\b.*codex_core/i.test(text)) return false;
  if (/^\[?codex\]?\s*mcp:/i.test(text)) return false;
  return true;
}

function looksLikeMojibake(text) {
  const value = String(text || "");
  if (value.includes("\uFFFD")) return true;
  const questionMarks = (value.match(/\?/g) || []).length;
  const cjkMarkers = (value.match(/[一-龥燎-刺]/g) || []).length;
  if (questionMarks >= 2 && cjkMarkers >= 2) return true;
  const markerCount = [
    "怨", "寃", "湲", "醫", "諛", "蹂", "吏", "泥", "理", "踰", "援", "紐",
    "묒", "떖", "쇰", "ъ", "꽦", "쒕", "떎", "쒖", "섏", "먯", "꾩", "낅", "뺤", "앸", "뻽", "듬", "땲",
    "씤", "덈", "쓣", "쓽", "쟻", "젙", "룞", "쉶", "깆", "낵", "쓬", "븯"
  ].reduce((count, marker) => count + (value.includes(marker) ? 1 : 0), 0);
  return (markerCount >= 2 && questionMarks >= 1) || markerCount >= 4;
}

function shouldSuppressWriterFeedback(agent, level) {
  return agent === "writer" && !["warn", "error"].includes(String(level || "info"));
}

function shouldForwardRawCodexOutput(options = {}) {
  return options.debugCodexRawOutput === true || process.env.BLOGAUTO_DEBUG_CODEX_RAW === "1";
}

function parseTokenLine(text, tokenState) {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return null;
  const sameLine = cleaned.match(/tokens?\s+used\s*:?\s*([0-9][0-9,]*)/i);
  if (sameLine) {
    const total = Number(sameLine[1].replace(/,/g, ""));
    return Number.isFinite(total) ? total : null;
  }
  if (/tokens?\s+used/i.test(cleaned)) {
    tokenState.awaitingValue = true;
    return null;
  }
  if (tokenState.awaitingValue) {
    const nextLine = cleaned.match(/^([0-9][0-9,]*)$/);
    tokenState.awaitingValue = false;
    if (nextLine) {
      const total = Number(nextLine[1].replace(/,/g, ""));
      return Number.isFinite(total) ? total : null;
    }
  }
  return null;
}

function parseProgressLine(text, options = {}) {
  const match = String(text || "").trim().match(/^BLOGAUTO_PROGRESS:\s*(.+)$/i);
  if (!match) return null;
  const code = match[1].trim().toLowerCase();
  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  const usesImages = options.includeTitleImage !== false || bodyImageLimit > 0;
  if (code === "image" && !usesImages) return null;
  const labels = {
    research: "리서치 흐름 분석 중",
    title: "제목 선정 중",
    source_review: "검색 후보 검토 중",
    date_filter: "기간성 정보 검증 중",
    writer: "Writer Agent 작성 중",
    article: "본문 작성 중",
    main_review: "Main Agent 최종 검수 중",
    image: "이미지 생성 중",
    save: "결과 저장 중"
  };
  return labels[code] || match[1].trim();
}

function compactSearchResultsForPrompt(searchResults, {
  maxResults = 12,
  excerptChars = 700
} = {}) {
  return rankSearchResultsForPrompt(searchResults)
    .slice(0, maxResults)
    .map((item, index) => {
      const relevance = item?.relevance || {};
      return {
        sourceId: String(item?.sourceId || `source-${index + 1}`),
        provider: String(item?.provider || ""),
        title: String(item?.title || ""),
        url: String(item?.url || ""),
        fetchedUrl: String(item?.fetchedUrl || ""),
        contentLength: Number(item?.contentLength || 0),
        excerpt: String(item?.excerpt || "").replace(/\s+/g, " ").trim().slice(0, excerptChars),
        relevance: {
          score: Number(relevance.score || 0),
          topicMatchedTerms: Array.isArray(relevance.topicMatchedTerms) ? relevance.topicMatchedTerms.slice(0, 8) : [],
          keywordMatchedTerms: Array.isArray(relevance.keywordMatchedTerms) ? relevance.keywordMatchedTerms.slice(0, 8) : [],
          officialSource: relevance.officialSource === true,
          institutionalSource: relevance.institutionalSource === true,
          independentSource: relevance.independentSource === true,
          blogTrustedSource: relevance.blogTrustedSource === true,
          lowTrustSource: relevance.lowTrustSource === true,
          currentFactSignal: relevance.currentFactSignal === true,
          strictEvidence: relevance.strictEvidence === true,
          authorityEvidence: relevance.authorityEvidence === true,
          independentEvidence: relevance.independentEvidence === true
        }
      };
    });
}

function searchResultPromptKey(item) {
  return String(item?.fetchedUrl || item?.url || item?.title || "").trim().toLowerCase();
}

function isAuthorityPromptCandidate(item) {
  const relevance = item?.relevance || {};
  return relevance.officialSource === true || relevance.institutionalSource === true;
}

function isIndependentPromptCandidate(item) {
  return item?.relevance?.independentSource === true;
}

function isStrongPromptCandidate(item) {
  const relevance = item?.relevance || {};
  return relevance.strictEvidence === true
    && relevance.currentFactSignal === true
    && relevance.lowTrustSource !== true
    && Number(relevance.score || 0) >= 8;
}

function scoreSearchResultForPrompt(item) {
  return Number(item?.relevance?.score || 0);
}

function uniquePromptCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = searchResultPromptKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function rankSearchResultsForPrompt(searchResults) {
  const items = Array.isArray(searchResults) ? searchResults.filter(Boolean) : [];
  const authorityItems = items
    .filter(isAuthorityPromptCandidate)
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  const independentItems = items
    .filter((item) => !isAuthorityPromptCandidate(item) && isIndependentPromptCandidate(item))
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  const strongItems = items
    .filter((item) => !isAuthorityPromptCandidate(item) && !isIndependentPromptCandidate(item) && isStrongPromptCandidate(item))
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  return uniquePromptCandidates([...authorityItems, ...independentItems, ...strongItems, ...items]);
}

function compactResearchHandoffForPrompt(researchResult, { includeWriterContract = false } = {}) {
  const source = researchResult && typeof researchResult === "object" ? researchResult : {};
  const compact = {
    status: source.status || "",
    failureReason: source.failureReason || "",
    finalTitle: source.finalTitle || source.selectedTitle || "",
    topicThesis: source.topicThesis || "",
    topicLane: source.topicLane || "",
    selectedKeywordPhrases: Array.isArray(source.selectedKeywordPhrases) ? source.selectedKeywordPhrases : [],
    searchNeed: source.searchNeed || "",
    factBased: source.factBased === true,
    factChecks: source.factChecks || [],
    directTopicPreserved: source.directTopicPreserved !== false,
    anchorEvent: source.anchorEvent || {},
    currentPeg: source.currentPeg || {},
    currentBridgeRequired: source.currentBridgeRequired === true,
    currentBridgeSatisfied: source.currentBridgeSatisfied === true,
    coreQuestions: compactTextList(source.coreQuestions),
    mustCover: compactTextList(source.mustCover),
    avoidDirections: compactTextList(source.avoidDirections),
    confirmedFacts: compactTextList(source.confirmedFacts),
    uncertainItems: compactTextList(source.uncertainItems),
    usableSources: (Array.isArray(source.usableSources) ? source.usableSources : []).slice(0, 12).map((item) => ({
      sourceId: item?.sourceId || "",
      title: item?.title || "",
      url: item?.url || "",
      reason: item?.reason || ""
    })),
    writerBrief: source.writerBrief || ""
  };
  if (includeWriterContract) compact.writerContract = source.writerContract || {};
  return compact;
}

function compactWriterResultForPrompt(writerResult) {
  const source = writerResult && typeof writerResult === "object" ? writerResult : {};
  return {
    status: source.status || "",
    failureReason: source.failureReason || "",
    title: source.title || "",
    article: source.article || "",
    tags: Array.isArray(source.tags) ? source.tags : [],
    titleImagePrompt: source.titleImagePrompt || "",
    titleImageText: Array.isArray(source.titleImageText) ? source.titleImageText : [],
    bodyImages: Array.isArray(source.bodyImages) ? source.bodyImages : [],
    notes: compactTextList(source.notes)
  };
}

function isMissingCodexResultFileError(error) {
  return /Codex result file was not created:/i.test(String(error?.message || ""));
}

function buildImageStylePrompt({
  jobDir,
  sampleImagePath,
  sampleImageHash = ""
}) {
  const resultPath = path.join(jobDir, "image-style-result.json");
  return [
    "You are the Image Style Agent for a Korean Naver Blog automation app.",
    "Analyze the local sample image and write a reusable image style prompt.",
    "Do not generate images. Do not write article content.",
    `Sample image path: ${sampleImagePath}`,
    `Sample image hash: ${sampleImageHash || "(unknown)"}`,
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: image",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Style prompt requirements:",
    "- Describe visual style only: composition, layout, palette, lighting, texture, camera/framing, graphic treatment, typography style if visible, and overall mood.",
    "- Make it reusable for future Korean Naver Blog title thumbnails and body support images.",
    "- Do not identify private people, infer sensitive traits, or copy exact text from the sample image.",
    "- Do not include article-specific facts, dates, products, programs, or claims from the sample image.",
    "- Keep the prompt concrete enough for image generation and under 1200 Korean/English characters.",
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"imageStylePrompt\": string, \"notes\": string[] }.",
    "- If the image cannot be inspected, set status to \"failed\" and explain the reason concisely in Korean.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildImageWorkerPrompt({
  jobDir,
  runtimeRoot,
  includeTitleImage = true,
  imageAspectRatio = DEFAULT_IMAGE_ASPECT_RATIO,
  titleImageAspectRatio,
  bodyImageAspectRatio,
  maxBodyImages = 10,
  writerResult,
  finalTitle,
  accountImageStylePrompt = "",
  imageRevisionFeedback = "",
  researchTitleResult,
  articleOpening = ""
}) {
  const resultPath = path.join(jobDir, "image-worker-result.json");
  const imageDir = path.join(runtimeRoot || path.dirname(path.dirname(jobDir)), "image");
  const selectedTitleImageAspectRatio = normalizeImageAspectRatio(titleImageAspectRatio || imageAspectRatio);
  const selectedBodyImageAspectRatio = normalizeImageAspectRatio(bodyImageAspectRatio || imageAspectRatio);
  const bodyImageLimit = normalizeMaxBodyImages(maxBodyImages);
  fs.mkdirSync(imageDir, { recursive: true });
  return [
    "You are the Image Worker for a Korean Naver Blog automation app.",
    "You are not a content agent. Do not rewrite the title, article, tags, facts, or structure.",
    "Generate only the requested reference images from the Writer Agent image prompts.",
    `Final title: ${finalTitle || writerResult?.title || ""}`,
    `Image output directory: ${imageDir}`,
    `Output JSON path: ${resultPath}`,
    imageRevisionFeedback ? `Previous image contract failure to correct: ${imageRevisionFeedback}` : "",
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: image",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Image generation scope:",
    includeTitleImage ? "- Generate exactly one title image when titleImagePrompt is available." : "- Do not generate a title image.",
    bodyImageLimit > 0 ? `- Generate exactly one body image for every supplied bodyImages item, up to ${bodyImageLimit}; do not skip, merge, or reorder sections.` : "- Do not generate body images.",
    `- Requested title image aspect ratio: ${selectedTitleImageAspectRatio}.`,
    `- Requested body image aspect ratio: ${selectedBodyImageAspectRatio}.`,
    "- Generate title images in the requested title image aspect ratio and body images in the requested body image aspect ratio.",
    "- Keep each selected orientation and do not substitute a different ratio unless the image tool cannot support it.",
    "- Do not run shell, PowerShell, Node, Python, Copy-Item, cp, move, or file-copy commands for images.",
    "- Image Worker must not copy image files into the app image directory. The desktop app will copy returned image paths later.",
    "- If image generation returns a file outside the app image directory, return that original generated file path as-is.",
    "- If image generation fails or the tool is unavailable, return empty paths and put the reason in notes.",
    "- If image generation returns a concrete existing image file path ending in .png, .jpg, .jpeg, or .webp, return that path.",
    "- If the image tool responds with generated image data but without a concrete file path, do not paste base64 into the JSON. Save the generated bytes to a concrete file in the job directory before returning its path; otherwise return an empty path and explain the failure.",
    "- Use the exact sequence numbers from bodyImages[].sequence.",
    "- Paths must point to concrete .png, .jpg, .jpeg, or .webp files. Do not return a directory path.",
    "- Prefer concrete editorial blog visuals that summarize the article or nearby section. Avoid abstract decorative backgrounds.",
    accountImageStylePrompt ? "- Apply this account-specific visual style prompt unless it conflicts with factual accuracy, no-text rules, or the article context:" : "",
    accountImageStylePrompt ? accountImageStylePrompt : "",
    "",
    "Title image policy:",
    includeTitleImage ? "- The title image is a mobile-feed editorial thumbnail: visually synthesize the title AND the whole article’s core message and supported reader promise, using one clear focal point. Do not compress every section into a dense infographic." : "- Title image generation is disabled.",
    includeTitleImage ? `- The title image must use aspect ratio ${selectedTitleImageAspectRatio}.` : "",
    includeTitleImage ? "- Visible Korean text is mandatory. Render every supplied titleImageText string verbatim, large, readable, accurate, and integrated into a clear headline/key-fact hierarchy." : "",
    includeTitleImage ? "- Do not add long Korean paragraphs, fake official marks, unverified amounts, unverified dates, or labels that are not supported by the article." : "",
    includeTitleImage ? "- Use one main visual cue and at most one supporting cue, clear contrast and generous crop-safe margins. Keep Korean text legible at small thumbnail size and retain essential qualifications. Preserve the requested aspect ratio and account style; do not invent new claims or captions." : "",
    includeTitleImage ? "- Inspect the generated title image before accepting it. If any required text is missing, unreadable, materially misspelled, or the image materially contradicts the article promise, report that image as failed with the specific reason. Do not regenerate within this task; the app permits one targeted retry." : "",
    "",
    "Body image policy:",
    bodyImageLimit > 0 ? "- Body images are section-compression visuals, not generic decoration and not title cards. Avoid readable Korean paragraphs, long labels, UI copy, and text-heavy charts." : "- Body image generation is disabled.",
    bodyImageLimit > 0 ? `- Every body image must use aspect ratio ${selectedBodyImageAspectRatio}.` : "",
    bodyImageLimit > 0 ? "- For every supplied item, preserve sequence and sectionHeading and compress the entire section's concrete subject, relationship, process, comparison, timeline, or decision cue into one coherent image." : "",
    bodyImageLimit > 0 ? "- Inspect each generated body image before accepting it. If it is generic, loosely related, or misses the section's central structure, report that image as failed with the specific reason. Do not regenerate within this task; the app permits one targeted retry." : "",
    "",
    "Writer Agent image handoff:",
    JSON.stringify({
      readerPromise: researchTitleResult?.writerContract?.readerPromise || "",
      contentStrategy: researchTitleResult?.writerContract?.contentStrategy || null,
      articleContext: require('./publicationFormat').referenceParts(writerResult?.article || articleOpening).body,
      titleImagePrompt: writerResult?.titleImagePrompt || "",
      titleImageText: Array.isArray(writerResult?.titleImageText) ? writerResult.titleImageText : [],
      bodyImages: Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages.slice(0, bodyImageLimit) : []
    }, null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"partial\" | \"failed\", \"failureReason\": string, \"titleImagePath\": string, \"titleImageVerified\": boolean, \"bodyImages\": [{\"sequence\": number, \"sectionHeading\": string, \"path\": string, \"prompt\": string, \"summaryVerified\": boolean}], \"notes\": string[] }.",
    "- If no image prompt is available, return status \"failed\", empty image paths, and a concise Korean note.",
    "- If some images succeed and some fail, return status \"partial\" with successful paths and notes for failures.",
    "- Keep notes concise and include only generation failures or verification facts needed by the app.",
    "- Status \"success\" is allowed only when every requested image has a concrete image file path, titleImageVerified is true when requested, and every body image has summaryVerified true.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function mergeImageWorkerResult(writerResult, imageResult, options = {}) {
  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  const writerBodyImages = Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages : [];
  const generatedBodyImages = Array.isArray(imageResult?.bodyImages) ? imageResult.bodyImages : [];
  const mergedBodyImages = generatedBodyImages
    .filter((item) => String(item?.path || "").trim())
    .slice(0, bodyImageLimit)
    .map((item) => ({
      sequence: Number(item.sequence || 0),
      sectionHeading: String(item.sectionHeading || writerBodyImages.find((writerImage) => Number(writerImage.sequence) === Number(item.sequence))?.sectionHeading || ""),
      path: String(item.path || ""),
      prompt: String(item.prompt || writerBodyImages.find((writerImage) => Number(writerImage.sequence) === Number(item.sequence))?.prompt || ""),
      summaryVerified: item.summaryVerified === true
    }))
    .filter((item) => item.sequence > 0);

  const notes = [
    ...(Array.isArray(imageResult?.notes) ? imageResult.notes : [])
  ];
  if (imageResult && String(imageResult.status || "").toLowerCase() !== "success") {
    const reason = String(imageResult.failureReason || "").trim();
    notes.push(reason || "이미지 Worker가 일부 또는 전체 이미지를 생성하지 못했습니다. 이미지 삽입은 가능한 항목만 진행합니다.");
  }

  return {
    ...writerResult,
    titleImagePath: options.includeTitleImage === false ? "" : String(imageResult?.titleImagePath || ""),
    bodyImages: mergedBodyImages,
    notes
  };
}

function mergeImageWorkerAttempts(previousResult, currentResult) {
  if (!previousResult) return currentResult || {};
  const previousImages = Array.isArray(previousResult.bodyImages) ? previousResult.bodyImages : [];
  const currentImages = Array.isArray(currentResult?.bodyImages) ? currentResult.bodyImages : [];
  const bySequence = new Map();
  for (const item of [...previousImages, ...currentImages]) {
    const sequence = Number(item?.sequence || 0);
    if (sequence <= 0) continue;
    const existing = bySequence.get(sequence);
    const itemIsUsable = Boolean(String(item?.path || "").trim()) && item?.summaryVerified === true;
    const existingIsUsable = Boolean(String(existing?.path || "").trim()) && existing?.summaryVerified === true;
    if (!existing || itemIsUsable || !existingIsUsable) bySequence.set(sequence, item);
  }
  const titleFromCurrent = Boolean(String(currentResult?.titleImagePath || "").trim())
    && currentResult?.titleImageVerified === true;
  return {
    ...previousResult,
    ...currentResult,
    status: "success",
    failureReason: "",
    titleImagePath: titleFromCurrent ? currentResult.titleImagePath : previousResult.titleImagePath || currentResult?.titleImagePath || "",
    titleImageVerified: titleFromCurrent ? true : previousResult.titleImageVerified === true || currentResult?.titleImageVerified === true,
    bodyImages: [...bySequence.values()].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0)),
    notes: compactTextList([previousResult.notes, currentResult?.notes])
  };
}

function pendingImageWriterResult(writerResult, imageResult, options = {}) {
  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  const titlePending = options.includeTitleImage !== false
    && !(String(imageResult?.titleImagePath || "").trim() && imageResult?.titleImageVerified === true);
  const generatedImages = Array.isArray(imageResult?.bodyImages) ? imageResult.bodyImages : [];
  const pendingBodyImages = (Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages : [])
    .slice(0, bodyImageLimit)
    .filter((expected) => {
      const actual = generatedImages.find((item) => Number(item?.sequence) === Number(expected?.sequence));
      return !actual
        || !String(actual.path || "").trim()
        || actual.summaryVerified !== true
        || normalizedSectionHeading(actual.sectionHeading) !== normalizedSectionHeading(expected.sectionHeading);
    });
  return {
    title: writerResult?.title || "",
    article: writerResult?.article || "",
    titleImagePrompt: titlePending ? writerResult?.titleImagePrompt || "" : "",
    titleImageText: titlePending && Array.isArray(writerResult?.titleImageText) ? writerResult.titleImageText : [],
    bodyImages: pendingBodyImages
  };
}

function imageWorkerContractIssueReason(imageResult, writerResult, options = {}) {
  const status = String(imageResult?.status || "").toLowerCase();
  if (!["success", "partial"].includes(status)) {
    return String(imageResult?.failureReason || "").trim() || "Image Worker가 모든 요청 이미지를 성공 상태로 반환하지 않았습니다.";
  }
  if (options.includeTitleImage !== false) {
    if (!String(imageResult?.titleImagePath || "").trim()) {
      return "본문 전체를 압축한 타이틀 이미지 파일이 없습니다.";
    }
    if (imageResult?.titleImageVerified !== true) {
      return "타이틀 이미지의 필수 문구 가독성과 본문 전체 요약 여부가 검증되지 않았습니다.";
    }
  }

  const bodyImageLimit = normalizeMaxBodyImages(options.maxBodyImages);
  if (bodyImageLimit === 0) return "";
  const expected = Array.isArray(writerResult?.bodyImages)
    ? writerResult.bodyImages.slice(0, bodyImageLimit)
    : [];
  const generated = Array.isArray(imageResult?.bodyImages) ? imageResult.bodyImages : [];
  if (generated.length !== expected.length) {
    return `섹션별 본문 이미지 ${expected.length}장이 필요하지만 ${generated.length}장이 반환됐습니다.`;
  }
  for (const expectedImage of expected) {
    const actual = generated.find((item) => Number(item?.sequence) === Number(expectedImage?.sequence));
    if (!actual || (!String(actual.path || "").trim())) {
      return `본문 섹션 ${expectedImage.sequence} 이미지 파일이 없습니다.`;
    }
    if (normalizedSectionHeading(actual.sectionHeading) !== normalizedSectionHeading(expectedImage.sectionHeading)) {
      return `본문 섹션 ${expectedImage.sequence} 이미지의 sectionHeading이 Writer 전달값과 다릅니다.`;
    }
    if (actual.summaryVerified !== true) {
      return `본문 섹션 ${expectedImage.sequence} 이미지가 섹션 전체 압축 이미지로 검증되지 않았습니다.`;
    }
  }
  return "";
}

function readAgentResult(jobDir, fileName = "agent-result.json") {
  const resultPath = path.join(jobDir, fileName);
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Codex result file was not created: ${fileName}`);
  }
  const raw = fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    throw new Error(`Codex Agent 결과 JSON 파싱 실패(${fileName}): ${message}`);
  }
}

function preserveAgentFile(jobDir, fromName, toName) {
  const fromPath = path.join(jobDir, fromName);
  const toPath = path.join(jobDir, toName);
  if (fs.existsSync(fromPath)) {
    fs.copyFileSync(fromPath, toPath);
  }
}

function removeAgentResultFile(jobDir, fileName) {
  const resultPath = path.join(jobDir, fileName);
  if (fs.existsSync(resultPath)) {
    fs.rmSync(resultPath, { force: true });
  }
}

function compactTextList(values) {
  return (Array.isArray(values) ? values : [values])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function uniqueCompactTextList(values, limit = 8) {
  const seen = new Set();
  const result = [];
  for (const value of compactTextList(values)) {
    const key = value.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function firstCompactText(values, fallback = "") {
  return compactTextList(values)[0] || fallback;
}

function summarizeUsableSourcesForContract(sources, limit = 5) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, limit)
    .map((source) => uniqueCompactTextList([
      source?.sourceId ? `id: ${source.sourceId}` : "",
      source?.title ? `title: ${source.title}` : "",
      source?.url ? `url: ${source.url}` : "",
      source?.reason ? `use: ${source.reason}` : ""
    ], 4).join(" / "))
    .filter(Boolean);
}

function buildWriterContract(researchResult = {}, context = {}) {
  return { ...(researchResult.writerContract || {}),
    selectedTitle: researchResult.finalTitle || context.finalTitle || context.topic || '',
    confirmedFacts: researchResult.writerContract?.confirmedFacts || researchResult.confirmedFacts || [],
    factChecks: researchResult.factChecks || [],
    ...(context.preferredTone ? { tone: context.preferredTone } : {}) };
}

function summarizeAgentReason(values, fallback, maxLength = 700) {
  const text = compactTextList(values)
    .map((value) => stripAnsi(value).replace(/\s+/g, " ").trim())
    .filter((value) => value && !looksLikeMojibake(value))
    .join(" / ")
    .trim();
  return (text || fallback).slice(0, maxLength);
}

function researchRevisionReason(researchResult) {
  return summarizeAgentReason([
    researchResult?.failureReason,
    researchResult?.notes,
    researchResult?.uncertainItems
  ], "Research/Title Agent가 본문 작성 전 추가 확인이 필요하다고 판단했습니다.");
}

function currentBridgeIssueReason(researchResult) {
  if (researchResult?.currentBridgeRequired !== true) return "";
  if (researchResult?.currentBridgeSatisfied === true) return "";
  return summarizeAgentReason([
    researchResult?.failureReason,
    researchResult?.currentPeg?.summary,
    researchResult?.uncertainItems,
    researchResult?.notes
  ], "과거 anchorEvent를 현재 이슈로 다루려면 현재 진행 상황이나 최근 변화(currentPeg)가 확인되어야 합니다.");
}

function isResearchSourceFailure(result) {
  return result?.status === 'REVISION' && Array.isArray(result.searchQueries) && result.searchQueries.length > 0;
}

function isAuthoritySourceQualityFailure(sourceQuality) {
  return sourceQuality?.status === "insufficient"
    && sourceQuality?.authorityEvidenceRequired === true
    && Number(sourceQuality?.authorityEvidenceCandidates || 0) === 0;
}

function authoritySourceQualityIssueReason(sourceQuality) {
  if (!isAuthoritySourceQualityFailure(sourceQuality)) return "";
  return sourceQuality.reason
    || "블로그 후보는 주제 단서로 확인되었지만 공식/기관 근거가 부족합니다. 공식 원문 보강 검색이 필요합니다.";
}

function writerOutputIssueReason(writerResult, options={}) {
  const writerStatus = String(writerResult?.status || "").toLowerCase();
  const writerReason = summarizeAgentReason([
    writerResult?.failureReason,
    writerResult?.notes,
    writerResult?.revisionInstructions
  ], "Writer Agent가 본문 작성에 실패했습니다.");

  if (writerStatus === "failed") return writerReason;
  if (!writerStatus) return "Writer Agent 상태값이 비어 있습니다.";
  if (writerStatus !== "success") return `Writer Agent 상태값이 유효하지 않습니다: ${writerStatus}`;
  if (!String(writerResult?.article || "").trim()) {
    return "Writer Agent가 본문(article)을 비워 반환했습니다.";
  }
  const {cleanSourceUrl,referenceParts,isBlogCitation}=require('./publicationFormat');
  const parts=referenceParts(writerResult.article);
  if(/\[(?:(?:참고|출처)\s*)?\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/.test(parts.body))return '본문에는 참고 번호를 넣지 마세요. 출처는 맨 아래 [SECTION - 참고자료]에만 모으세요.';
  if(parts.count>1 || (parts.count && /^\[SECTION\s*-/m.test(parts.references)))return '참고자료는 글 맨 아래 한 번만 배치하세요.';
  if(options.researchTitleResult?.factBased===true || options.researchTitleResult?.factChecks?.some(f=>f.essential===true) || (options.researchTitleResult?.searchNeed && options.researchTitleResult.searchNeed!=='skip')) {
    const {sourcesFor}=require('./generationPrompts');
    const sources=new Map(sourcesFor(options).map(s=>[s.sourceId,s]));
    const citations=writerResult.citations;
    if(!Array.isArray(citations) || !citations.length)return '출처 의존 글의 본문 참고자료와 citations가 없습니다. 실제 사용한 원문을 표시하세요.';
    for(const citation of citations){
      const source=sources.get(citation.sourceId);
      if(!source || ![source.url,source.fetchedUrl].filter(Boolean).map(cleanSourceUrl).includes(cleanSourceUrl(citation.url)))return '본문 출처가 전달한 원문과 일치하지 않습니다. 제공된 sourceId와 URL을 사용하세요.';
      if(!isBlogCitation(citation) && !parts.references.includes(cleanSourceUrl(citation.url)))return '참고자료 URL이 본문에 표시되지 않았습니다. 맨 아래 [SECTION - 참고자료]에 실제 사용한 원문 링크를 모으세요.';
    }
  }
  return require('./articleRequirements').articleLengthIssue(writerResult);
}

function articleSections(article) {
  const text = String(article || "");
  const matches = [...text.matchAll(/^\[SECTION\s*-\s*(.+?)\]\s*$/gmi)];
  return matches.map((match, index) => ({
    heading: String(match[1] || "").replace(/\s+/g, " ").trim(),
    content: text.slice(match.index, matches[index + 1]?.index ?? text.length)
  }));
}

function normalizedSectionHeading(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function writerImageContractIssueReason(writerResult, options = {}) {
  if(options.includeTitleImage!==false && !String(writerResult?.titleImagePrompt || '').trim())return '타이틀 이미지 설명이 필요합니다.';
  const limit=normalizeMaxBodyImages(options.maxBodyImages);
  const images=Array.isArray(writerResult?.bodyImages)?writerResult.bodyImages:[];
  const markers=[...String(writerResult?.article || '').matchAll(/^\[IMAGE INSERT\s*-\s*(\d+)\]\s*$/gmi)].map(m=>Number(m[1]));
  if(images.length>limit)return '요청한 이미지 한도를 초과했습니다.';
  const sequences=images.map(i=>Number(i.sequence));
  if(new Set(sequences).size!==sequences.length || new Set(markers).size!==markers.length || markers.length!==images.length)return '이미지 번호가 중복되었거나 본문 마커와 일치하지 않습니다.';
  if(images.some(i=>!Number.isInteger(Number(i.sequence)) || Number(i.sequence)<1 || !markers.includes(Number(i.sequence)) || !String(i.prompt || '').trim()))return '이미지 번호, 본문 위치 또는 설명을 확인해 주세요.';
  const sections=articleSections(writerResult?.article);
  const bodySections=sections.filter(s=>s.heading!=='참고자료');
  for(const image of images){
    const section=bodySections.find(s=>normalizedSectionHeading(s.heading)===normalizedSectionHeading(image.sectionHeading));
    if(!section || !section.content.includes(`[IMAGE INSERT - ${image.sequence}]`))return '본문 이미지는 참고자료가 아닌 해당 소제목의 섹션에 배치해야 합니다.';
  }
  if(new Set(images.map(i=>normalizedSectionHeading(i.sectionHeading))).size!==images.length)return '같은 섹션의 중복 이미지 대신 다른 주요 섹션에 배치하세요.';
  if(limit>0 && bodySections.length && !images.length)return '본문 주요 섹션을 함축하는 이미지를 최대한 배치하세요. 이미지 계획이 비어 있습니다.';
  if(limit>0 && images.length<Math.min(limit,bodySections.length)){
    const omissions=Array.isArray(writerResult?.imageOmissions)?writerResult.imageOmissions:[];
    const missing=bodySections.filter(s=>!images.some(i=>normalizedSectionHeading(i.sectionHeading)===normalizedSectionHeading(s.heading)) && !omissions.some(o=>normalizedSectionHeading(o.sectionHeading)===normalizedSectionHeading(s.heading) && String(o.reason || '').trim()));
    if(missing.length)return `참고자료를 제외한 섹션에 이미지를 최대한 배치하세요. 누락된 섹션: ${missing.map(s=>s.heading).join(', ')}. 생략이 필요하면 imageOmissions에 구체적인 이유를 적으세요.`;
  }
  return '';
}

function isSourceInsufficientWriterIssue(_reason, writerResult) {
  return writerResult?.failureCode === 'INSUFFICIENT_EVIDENCE';
}

function retryableWriterFailureReason(writerResult, researchResult) {
  const issueReason = writerOutputIssueReason(writerResult);
  if (!issueReason) return "";
  if (isSourceInsufficientWriterIssue(issueReason, writerResult, researchResult)) {
    return "";
  }
  return issueReason;
}

function revisionFeedbackFrom(mainReviewResult, writerResult) {
  return compactTextList([
    mainReviewResult?.failureReason,
    mainReviewResult?.revisionInstructions,
    mainReviewResult?.issues,
    mainReviewResult?.notes,
    writerResult?.failureReason,
    writerResult?.notes
  ]).join(" / ").slice(0, 4000);
}

function mainReviewPassIssueReason(mainReviewResult) {
  if (String(mainReviewResult?.status || "").toUpperCase() !== "PASS") return "";
  const requiredTrueFields = [
    ['articleAnswersTitle', 'title coverage'], ['topicPreserved', 'topic'],
    ['factualityPass', 'factuality'], ['sourceUsePass', 'source use'],
    ['riskExpressionPass', 'risk'], ['publishable', 'publishable']
  ];
  const failedFields = requiredTrueFields
    .filter(([field]) => mainReviewResult?.[field] !== true)
    .map(([, label]) => label);
  if (failedFields.length) {
    return `Main Agent returned PASS but required review checks failed: ${failedFields.join(", ")}`;
  }
  const failureReason = String(mainReviewResult?.failureReason || "").trim();
  if (failureReason) {
    return `Main Agent returned PASS with a failure reason: ${failureReason}`;
  }
  return "";
}

async function runCodexTask({
  options,
  prompt,
  promptFileName,
  resultFileName,
  log = () => {},
  tokenOffset = 0,
  grossTokenOffset = 0,
  inputTokenOffset = 0,
  cachedInputTokenOffset = 0,
  outputTokenOffset = 0,
  promptCharacterOffset = 0,
  agentTokenOffset = 0,
  agent = "main"
}) {
  const directText=require('./textTaskOutput').isTextStage(agent);
  if(directText)prompt=require('./textTaskOutput').responsePrompt(prompt);
  else if(options.trustBlogAsSource===true)prompt+='\n'+require('./generationPrompts').sourceOnlyPolicy;
  else prompt += '\nQuality policy: source-quality scores and domain classifications are discovery hints, not proof or vetoes. Assess original excerpts, dates, scope and conflicts. Stable explanations need no artificial current-news hook. A single directly relevant primary source can suffice; unknown domains may be primary sources. Blogs can inform discovery or first-hand experience, but cannot alone establish high-stakes or release claims. Omit nonessential unsupported details instead of blocking the whole topic. Never invent facts. Minor style differences are notes, not revision grounds.';
  fs.writeFileSync(path.join(options.jobDir, promptFileName), prompt, "utf8");
  removeAgentResultFile(options.jobDir, resultFileName);
  const outputState = { section: "meta" };
  const tokenState = {
    awaitingValue: false,
    total: 0,
    grossTotal: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    lastTotal: 0,
    lastInputTokens: 0,
    lastCachedInputTokens: 0,
    lastOutputTokens: 0,
    rateLimits: null
  };
  let taskEffort = modelEffortForAgent(options, agent);
  let taskStartedAt = Date.now();
  const promptCharacters = String(prompt || "").length;
  const estimatedPromptTokens = Math.ceil(promptCharacters / 3);
  const fallbackUsage = {
    total: 0,
    grossTotal: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rateLimits: null
  };

  const recoverTokenUsageFromSession = () => {
    if (tokenState.total > 0 && tokenState.rateLimits) return;
    const recovered = readLatestCodexTokenUsageFromSessions({
      sinceMs: taskStartedAt,
      jobDir: options.jobDir,
      resultFileName
    });
    if (!recovered?.tokenUsage) return;
    const recoveredTotal = Number(recovered.tokenUsage.total || 0);
    if (recoveredTotal > 0 && tokenState.total <= 0) {
      Object.assign(tokenState, {
        total: recoveredTotal,
        grossTotal: Number(recovered.tokenUsage.grossTotal || recoveredTotal || 0),
        inputTokens: Number(recovered.tokenUsage.inputTokens || 0),
        cachedInputTokens: Number(recovered.tokenUsage.cachedInputTokens || 0),
        outputTokens: Number(recovered.tokenUsage.outputTokens || 0),
        lastTotal: Number(recovered.tokenUsage.lastTotal || 0),
        lastInputTokens: Number(recovered.tokenUsage.lastInputTokens || 0),
        lastCachedInputTokens: Number(recovered.tokenUsage.lastCachedInputTokens || 0),
        lastOutputTokens: Number(recovered.tokenUsage.lastOutputTokens || 0)
      });
    }
    if (!tokenState.rateLimits && recovered.tokenUsage.rateLimits) {
      tokenState.rateLimits = recovered.tokenUsage.rateLimits;
    }
  };

  const reportTokenUsage = ({ final = false } = {}) => {
    const taskTokens = fallbackUsage.total + Number(tokenState.total || 0);
    const taskGrossTokens = fallbackUsage.grossTotal + Number(tokenState.grossTotal || tokenState.total || 0);
    const taskInputTokens = fallbackUsage.inputTokens + Number(tokenState.inputTokens || 0);
    const taskCachedInputTokens = fallbackUsage.cachedInputTokens + Number(tokenState.cachedInputTokens || 0);
    const taskOutputTokens = fallbackUsage.outputTokens + Number(tokenState.outputTokens || 0);
    const cumulativeTokens = tokenOffset + taskTokens;
    const cumulativeGrossTokens = grossTokenOffset + taskGrossTokens;
    const cumulativePromptCharacters = promptCharacterOffset + promptCharacters;
    const agentCumulativeTokens = agentTokenOffset + taskTokens;
    if (typeof options.onTokenUsage === "function") {
      options.onTokenUsage({
        total: cumulativeTokens,
        grossTotal: cumulativeGrossTokens,
        inputTokens: inputTokenOffset + taskInputTokens,
        cachedInputTokens: cachedInputTokenOffset + taskCachedInputTokens,
        outputTokens: outputTokenOffset + taskOutputTokens,
        promptCharacters: cumulativePromptCharacters,
        estimatedPromptTokens: Math.ceil(cumulativePromptCharacters / 3),
        lastTotal: Number(tokenState.lastTotal || 0),
        rateLimits: tokenState.rateLimits,
        agent,
        agentTotal: agentCumulativeTokens,
        agentDelta: taskTokens,
        agentGrossDelta: taskGrossTokens,
        final: Boolean(final)
      });
    }
  };

  const seenProgress = new Set();
  const progressLog = text => { if (!seenProgress.has(text)) { seenProgress.add(text); log(text, "info", agent); } };
  const handleOutputLine = (line, level = "info") => {
    const text = stripAnsi(line).trim();
    if (!text) return;

    const parsedJson = tryParseJsonLine(text);
    if (parsedJson) {
      const parsedRateLimits = jsonRateLimits(parsedJson);
      if (parsedRateLimits) {
        tokenState.rateLimits = parsedRateLimits;
      }
      const parsedUsage = jsonTokenUsage(parsedJson);
      if (parsedUsage || parsedRateLimits) {
        if (parsedUsage) {
          Object.assign(tokenState, {
            total: Number(parsedUsage.total || 0),
            grossTotal: Number(parsedUsage.grossTotal || parsedUsage.total || 0),
            inputTokens: Number(parsedUsage.inputTokens || 0),
            cachedInputTokens: Number(parsedUsage.cachedInputTokens || 0),
            outputTokens: Number(parsedUsage.outputTokens || 0),
            lastTotal: Number(parsedUsage.lastTotal || 0),
            lastInputTokens: Number(parsedUsage.lastInputTokens || 0),
            lastCachedInputTokens: Number(parsedUsage.lastCachedInputTokens || 0),
            lastOutputTokens: Number(parsedUsage.lastOutputTokens || 0)
          });
        }
        reportTokenUsage();
      }
      for (const assistantText of extractAssistantOutputTexts(parsedJson)) {
        String(assistantText || "")
          .split(/\r?\n/)
          .forEach((nestedLine) => {
            const assistantProgress = parseProgressLine(nestedLine, options);
            if (assistantProgress) {
              progressLog(`Codex 단계: ${assistantProgress}`);
            }
          });
      }
      return;
    }

    const progress = parseProgressLine(text, options);
    if (progress) {
      progressLog(`Codex 단계: ${progress}`);
      return;
    }

    const parsedTokens = parseTokenLine(text, tokenState);
    if (parsedTokens !== null) {
      tokenState.total = parsedTokens;
      tokenState.grossTotal = parsedTokens;
      reportTokenUsage();
      return;
    }

    if (/^user$/i.test(text)) {
      outputState.section = "user";
      return;
    }
    if (/^assistant$/i.test(text)) {
      outputState.section = "assistant";
      return;
    }
    if (outputState.section === "user") {
      return;
    }
    if (outputState.section === "assistant") {
      return;
    }
    if (shouldForwardRawCodexOutput(options) && isUsefulCodexFeedback(text) && !shouldSuppressWriterFeedback(agent, level)) {
      log(text, level, agent);
    }
  };

  const executeCodex = () => new Promise((resolve, reject) => {
    const codexModel = normalizeCodexModel(options.codexModel);
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...(directText ? ['--output-last-message',path.join(options.jobDir,resultFileName)] : []),
      ...(codexModel ? ["--model", codexModel] : []),
      "-c",
      `model_reasoning_effort=${taskEffort}`,
      "-"
    ];
    const child = spawn(options.codexCmdPath, args, {
      cwd: options.jobDir,
      env: buildCodexEnvironment({ command: options.codexCmdPath }),
      windowsHide: true,
      shell: shouldRunCodexViaShell(options.codexCmdPath)
    });

    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const streamBuffers = { info: "", warn: "" };
    const diagnosticLines = [];
    const rememberDiagnosticLine = (line) => {
      const text = stripAnsi(line).trim();
      if (!text) return;
      diagnosticLines.push(text);
      while (diagnosticLines.length > 8) diagnosticLines.shift();
    };
    const processOutputLine = (line, level = "info") => {
      if (settled) return;
      rememberDiagnosticLine(line);
      const limitSignal = detectCodexUsageLimitSignal(line);
      if (limitSignal) {
        const parsedLimitJson = tryParseJsonLine(stripAnsi(line).trim());
        const limitRateLimits = parsedLimitJson ? jsonRateLimits(parsedLimitJson) : null;
        if (limitRateLimits) {
          tokenState.rateLimits = limitRateLimits;
          reportTokenUsage();
        }
        const limitError = createCodexUsageLimitError(limitSignal.type, limitSignal.detail);
        log(limitError.message, "error", agent);
        child.kill();
        settle(limitError);
        return;
      }
      handleOutputLine(line, level);
    };

    const handleChunk = (chunk, level = "info") => {
      const key = level === "warn" ? "warn" : "info";
      streamBuffers[key] += String(chunk);
      const lines = streamBuffers[key].split(/\r?\n/);
      streamBuffers[key] = lines.pop() || "";
      for (const line of lines) {
        processOutputLine(line, level);
      }
    };

    const flushStreamBuffers = () => {
      for (const [key, buffered] of Object.entries(streamBuffers)) {
        if (!buffered) continue;
        streamBuffers[key] = "";
        processOutputLine(buffered, key === "warn" ? "warn" : "info");
      }
    };

    child.stdout.on("data", (chunk) => handleChunk(chunk));
    child.stderr.on("data", (chunk) => handleChunk(chunk, "warn"));
    child.stdin.end(prompt);
    child.on("error", (error) => settle(createCodexExecutionError(
      `Codex 실행 실패: ${error.message}`,
      { model: codexModel, detail: diagnosticLines.join("\n") }
    )));
    child.on("close", (code) => {
      flushStreamBuffers();
      if (code === 0) settle();
      else settle(createCodexExecutionError(
        `Codex가 종료 코드 ${code}로 실패했습니다.`,
        { model: codexModel, detail: diagnosticLines.join("\n") }
      ));
    });
  });

  try {
    taskStartedAt = Date.now();
    await executeCodex();
  } catch (error) {
    if (isCodexUsageLimitError(error)) {
      throw error;
    }
    if (taskEffort !== "xhigh" || !/unsupported.{0,80}(effort|reasoning)|invalid.{0,80}reasoning_effort/i.test(error.message)) {
      throw error;
    }
    recoverTokenUsageFromSession();
    fallbackUsage.total += Number(tokenState.total || 0);
    fallbackUsage.grossTotal += Number(tokenState.grossTotal || tokenState.total || 0);
    fallbackUsage.inputTokens += Number(tokenState.inputTokens || 0);
    fallbackUsage.cachedInputTokens += Number(tokenState.cachedInputTokens || 0);
    fallbackUsage.outputTokens += Number(tokenState.outputTokens || 0);
    fallbackUsage.rateLimits = tokenState.rateLimits || fallbackUsage.rateLimits;
    log("xhigh 호출이 실패하여 high로 낮춰 다시 실행합니다.", "warn", agent);
    taskEffort = "high";
    tokenState.awaitingValue = false;
    tokenState.total = 0;
    tokenState.grossTotal = 0;
    tokenState.inputTokens = 0;
    tokenState.cachedInputTokens = 0;
    tokenState.outputTokens = 0;
    tokenState.lastTotal = 0;
    tokenState.lastInputTokens = 0;
    tokenState.lastCachedInputTokens = 0;
    tokenState.lastOutputTokens = 0;
    tokenState.rateLimits = null;
    removeAgentResultFile(options.jobDir, resultFileName);
    taskStartedAt = Date.now();
    await executeCodex();
  }
  recoverTokenUsageFromSession();
  reportTokenUsage({ final: true });

  return {
    ...readAgentResult(options.jobDir, resultFileName),
    tokenUsage: {
      total: fallbackUsage.total + Number(tokenState.total || 0),
      grossTotal: fallbackUsage.grossTotal + Number(tokenState.grossTotal || tokenState.total || 0),
      inputTokens: fallbackUsage.inputTokens + Number(tokenState.inputTokens || 0),
      cachedInputTokens: fallbackUsage.cachedInputTokens + Number(tokenState.cachedInputTokens || 0),
      outputTokens: fallbackUsage.outputTokens + Number(tokenState.outputTokens || 0),
      lastTotal: tokenState.lastTotal,
      lastInputTokens: tokenState.lastInputTokens,
      lastCachedInputTokens: tokenState.lastCachedInputTokens,
      lastOutputTokens: tokenState.lastOutputTokens,
      rateLimits: tokenState.rateLimits || fallbackUsage.rateLimits,
      promptCharacters,
      estimatedPromptTokens
    }
  };
}

async function fetchCodexUsageSnapshot() {
  return readLatestCodexRateLimitsFromSessions() || {source:'unavailable',rateLimits:null,tokenUsage:{total:0,rateLimits:null},unavailableReason:'최근 사용량 기록이 없습니다. 표시 갱신을 위한 유료 모델 호출은 하지 않습니다.'};
}

async function runCodexGeneration(options, log=()=>{}) {
  return require('./generationPipeline').generate(options,log,{
    runTask:require('./modelRetry').createRetryTask(runCodexTask,options,log), bodyImageLimit:normalizeMaxBodyImages,
    stylePrompt:buildImageStylePrompt, researchPrompt:require("./generationPrompts").researchPrompt,
    researchRetry:require("./generationPrompts").researchPrompt, writerPrompt:require("./generationPrompts").writerPrompt,
    writerRetry:require("./generationPrompts").writerPrompt, reviewPrompt:require("./generationPrompts").reviewPrompt,
    writerIssue:writerOutputIssueReason,imagePromptIssue:writerImageContractIssueReason,
    reviewIssue:mainReviewPassIssueReason,pendingImages:pendingImageWriterResult,
    imagePrompt:buildImageWorkerPrompt,mergeImages:mergeImageWorkerAttempts,
    imageIssue:imageWorkerContractIssueReason,applyImages:mergeImageWorkerResult
  });
}

module.exports = {
  runCodexTask,
  runCodexGeneration,
  fetchCodexUsageSnapshot,
  _private: {
    compactSearchResultsForPrompt,
    compactResearchHandoffForPrompt,
    compactWriterResultForPrompt,
    rankSearchResultsForPrompt,
    buildImageWorkerPrompt,
    buildWriterContract,
    writerOutputIssueReason,
    mainReviewPassIssueReason,
    articleSections,
    writerImageContractIssueReason,
    imageWorkerContractIssueReason,
    mergeImageWorkerAttempts,
    pendingImageWriterResult
  }
};
