const {canonicalUrl,navigationOnly,evidenceExcerpt}=require('./evidenceText');
const {readSourceDocument}=require('./sourceDocument');
const http = require("node:http");
const https = require("node:https");

const MAX_RESPONSE_CHARS = 1_500_000;
const MAX_EXCERPT_CHARS = 3000;
const MAX_SELECTED_CONTENT_RESULTS = 20;
const MAX_SEARCH_QUERY_VARIANTS = 4;
const MAX_AUTHORITY_LINK_CANDIDATES = 6;
const CONTENT_FETCH_CONCURRENCY = 4;
const CANDIDATE_FETCH_TIMEOUT_MS = 20000;
const MIN_SELECTED_CANDIDATES_BEFORE_FALLBACK = 5;

const AD_WORDS = [
  "ad",
  "ads",
  "shopping",
  "mall",
  "sponsor",
  "sponsored",
  "파워링크",
  "광고",
  "쇼핑",
  "구매",
  "최저가"
];

const STOP_WORDS = new Set([
  "그리고",
  "그러나",
  "하지만",
  "정보",
  "관련",
  "최신",
  "현재",
  "오늘",
  "기준",
  "확인",
  "방법",
  "안내",
  "바로가기",
  "공식",
  "뉴스",
  "블로그",
  "또는",
  "이내",
  "가능한",
  "정보를",
  "중심으로",
  "있습니다",
  "합니다",
  "서비스",
  "홈페이지",
  "본문",
  "바로",
  "가기",
  "naver",
  "google",
  "www",
  "com",
  "html",
  "https",
  "http"
]);

const CURRENT_FACT_PATTERN = /(모집|채용|접수|신청\s*기간|신청기간|지원\s*대상|지원대상|대상\s*연령|대상연령|신청\s*조건|신청조건|참여\s*대상|참여대상|사업\s*기간|사업기간|운영\s*기간|운영기간|운영\s*시간|영업\s*시간|영업시간|휴무|정기\s*휴무|브레이크\s*타임|라스트\s*오더|예약|주차|가격|요금|입장료|메뉴|전화|주소|위치|판매\s*기간|행사\s*기간|공연\s*일정|업데이트|최신|현재|기준|마감|공고|자격|선발|교육\s*기간|교육기간)/i;
const DATE_FACT_PATTERN = /(20\d{2}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}[./-]\d{1,2}[./-]\d{1,2}|today|yesterday|tomorrow|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
const LOW_TRUST_DOMAIN_PATTERN = /(blogspot\.com|tistory\.com|wordpress\.com|blog\.naver\.com|m\.blog\.naver\.com|cafe\.naver\.com|brunch\.co\.kr|post\.naver\.com)/i;
const OFFICIAL_DOMAIN_PATTERN = /(^|\.)go\.kr$|(^|\.)gov(\.[a-z]{2,})?$|(^|\.)mil(\.[a-z]{2,})?$|(^|\.)edu(\.[a-z]{2,})?$|(^|\.)ac\.kr$/i;
const INSTITUTIONAL_DOMAIN_PATTERN = /(^|\.)or\.kr$|(^|\.)org$|(^|\.)int$|(^|\.)re\.kr$/i;
const PLATFORM_DOMAIN_PATTERN = /(^|\.)(google|naver|youtube|youtu|facebook|instagram|threads|twitter|x|linkedin|reddit|pinterest|github|medium|velog|notion)\./i;
const UNSUPPORTED_CONTENT_URL_PATTERN = /\.(?:pdf|xls|xlsx|csv|doc|docx|ppt|pptx|hwp|hwpx|zip|7z|rar)(?:[?#].*)?$/i;
const NAVER_BLOG_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const NAVER_NEWS_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.news.all&where=news&sm=tab_jum&query={query}";
const NAVER_WEB_SEARCH_URL = "https://search.naver.com/search.naver?where=web&query={query}";

function normalizeFreshnessLevel(value) {
  return ["auto", "low", "medium", "high"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "auto";
}

function parseReferenceDate(value = "") {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = String(value || "").trim();
  const korean = text.match(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})?\s*일?/);
  if (korean) {
    const year = Number(korean[1]);
    const month = Number(korean[2]);
    const day = Number(korean[3] || 1);
    return new Date(year, month - 1, day);
  }
  const parsed = text ? new Date(text) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function freshnessDateHints(options = {}) {
  if (normalizeFreshnessLevel(options.freshnessLevel) !== "high") return [];
  const date = parseReferenceDate(options.currentDate || options.writingDate || options.today);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const previousDate = new Date(year, month - 2, 1);
  const previousYear = previousDate.getFullYear();
  const previousMonth = previousDate.getMonth() + 1;
  return uniqueStrings([
    `${year}년 ${month}월`,
    `${previousYear}년 ${previousMonth}월`,
    `${year}년`,
    "최신",
    "최근",
    "발표",
    "보도자료",
    "원문"
  ]);
}

function freshnessSearchSuffix(options = {}) {
  return freshnessDateHints(options).slice(0, 8).join(" ");
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = /^http:\/\//i.test(url) ? http : https;
    const request = client.get(url, {
      headers: {
        "user-agent": "Mozilla/5.0 NaverBlogAutomator/0.1",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.7"
      },
      timeout: 12000
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchText(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_RESPONSE_CHARS) {
          request.destroy(new Error("본문이 너무 커서 일부 후보를 건너뜁니다."));
        }
      });
      response.on("end", () => resolve(body));
    });
    request.on("timeout", () => request.destroy(new Error("검색 요청 시간이 초과되었습니다.")));
    request.on("error", reject);
  });
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, num) => String.fromCharCode(parseInt(num, 10)));
}

function stripTags(value) {
  return decodeEntities(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyAd(text, url) {
  return /파워링크|스폰서\s*광고|\bsponsored\b/i.test(text) || /(?:adcr|adclick)\.naver\.com|googleadservices\.com/i.test(url);
}

function isLowValueResult(text, url) {
  if(navigationOnly(url))return true;
  const joined = `${text} ${url}`.toLowerCase();
  const host = hostFromUrl(url);
  if (/^(search|search\.shopping|shopping|nid|m\.search)\.naver\.com$/.test(host)) return true;
  if (host==='help.naver.com' && /\/(?:support\/)?alias\/search\//.test(new URL(url).pathname)) return true;
  if (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/(search|preferences|accounts|sorry)/.test(new URL(url).pathname)) return true;
  if (/^(검색옵션|검색\s*고객센터|개인정보처리방침|도움말|고객센터)$/i.test(String(text).trim())) {
    return true;
  }
  if (/\b(friend1004|jupiter\d+|apollon\d+|dionysus\d+)\.com\b/i.test(url)) {
    return true;
  }
  if (isUnsupportedContentUrl(url)) {
    return true;
  }
  if (/^keep\.naver\.com$/i.test(host)) {
    return true;
  }
  return /\/privacy(?:[/?#]|$)|\/feedback(?:[/?#]|$)|\/websearch(?:[/?#]|$)/i.test(url);
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isUnsupportedContentUrl(url) {
  const normalized = String(url || "").split("#")[0].split("?")[0];
  return !/\.(pdf|hwp|hwpx)$/i.test(normalized) && UNSUPPORTED_CONTENT_URL_PATTERN.test(normalized);
}

function isOfficialDomain(url) {
  const host = hostFromUrl(url);
  return OFFICIAL_DOMAIN_PATTERN.test(host);
}

function isInstitutionalDomain(url) {
  const host = hostFromUrl(url);
  return INSTITUTIONAL_DOMAIN_PATTERN.test(host);
}

function isLowTrustDomain(url) {
  return LOW_TRUST_DOMAIN_PATTERN.test(hostFromUrl(url));
}

function isPlatformDomain(url) {
  return PLATFORM_DOMAIN_PATTERN.test(hostFromUrl(url));
}

function isTrustedBlogSource(url, profile) {
  if (profile?.trustBlogAsSource !== true) return false;
  return /(^|\.)blog\.naver\.com$|(^|\.)m\.blog\.naver\.com$/i.test(hostFromUrl(url));
}

function isIndependentEditorialSource(url) {
  const host = hostFromUrl(url);
  if (!host) return false;
  if (isOfficialDomain(url) || isInstitutionalDomain(url)) return false;
  if (isLowTrustDomain(url) || isPlatformDomain(url)) return false;
  if (isUnsupportedContentUrl(url)) return false;
  return /\./.test(host);
}

function splitKeywordPhrases(keyword) {
  return String(keyword || "")
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !STOP_WORDS.has(item.toLowerCase()))
    .slice(0, 12);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactTopicForSearch(topic, keyword = "", maxLength = 90) {
  let compacted = String(topic || "")
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
  for (const phrase of splitKeywordPhrases(keyword)) {
    compacted = compacted.replace(new RegExp(escapeRegExp(phrase), "gi"), " ");
  }
  return compacted
    .replace(/[.,;:!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function evidenceText(options) {
  return [
    options.topic,
    options.keyword,
    options.category,
    options.publishPurpose,
    options.researchGuidance,
    normalizeSearchQueries(options.searchQueries).join(" ")
  ].filter(Boolean).join(" ");
}

function highFreshnessEnabled(options = {}) {
  return normalizeFreshnessLevel(options.freshnessLevel) === "high";
}

function requiresStrictSourceEvidence(options) {
  const searchNeed = String(options.searchNeed || "").toLowerCase();
  if (searchNeed !== "strict") return false;
  const text = evidenceText(options);
  return /(모집|채용|접수|신청|공고|지원금|고용지원|취업지원|정책|교육|훈련|대상|자격|마감|기간|공식|현재\s*유효|운영\s*중|신뢰\s*가능)/i.test(text);
}

function requiresAuthoritySourceEvidence(options) {
  if (!requiresStrictSourceEvidence(options)) return false;
  const text = evidenceText(options);
  return /(정책|지원금|정책자금|대출|융자|보조금|공고|신청|접수|모집|채용|고용지원|취업지원|국비|교육|훈련|법령|법률|세금|세무|의료|금융|보험|자격|마감)/i.test(text);
}

function requiresIndependentSourceEvidence(options) {
  if (String(options.searchNeed || "").toLowerCase() !== "strict" || requiresAuthoritySourceEvidence(options)) return false;
  const text = evidenceText(options);
  return /\b(ai|artificial intelligence|llm|agent|gemini|openai|anthropic|claude|google|deepmind|nvidia|intel|amd|microsoft|meta|semiconductor|gpu|chip|model|flash|spark|io|i\/o|computex|roadmap|launch|launched|release|released|announce|announced|announcement|unveil|unveiled|debut|update|updated|earnings|investor|market)\b/i.test(text)
    || /(AI|인공지능|모델|에이전트|반도체|발표|출시|공개|업데이트|로드맵|실적|투자|시장|업계동향)/i.test(text);
}

function buildSearchProfile(options) {
  const independentEvidence = requiresIndependentSourceEvidence(options);
  return {
    strictEvidence: options.trustBlogAsSource!==true && options.searchNeed==='strict',
    authorityEvidence: requiresAuthoritySourceEvidence(options),
    independentEvidence,
    keywordPhrases: splitKeywordPhrases(options.keyword),
    trustBlogAsSource: options.trustBlogAsSource === true,
    highFreshness: highFreshnessEnabled(options),
    referenceDate: parseReferenceDate(options.currentDate || options.writingDate || options.today)
  };
}

function candidateSignals(candidate, profile) {
  const text = `${candidate.title || ""} ${candidate.excerpt || ""}`;
  const lower = text.toLowerCase();
  const phraseMatches = profile.keywordPhrases
    .filter((phrase) => lower.includes(phrase.toLowerCase()))
    .slice(0, 10);
  const blogTrustedSource = profile.strictEvidence && isTrustedBlogSource(candidate.url, profile);
  const freshness = candidateFreshnessSignals(text, profile);
  return {
    officialSource: profile.strictEvidence && isOfficialDomain(candidate.url),
    institutionalSource: profile.strictEvidence && isInstitutionalDomain(candidate.url),
    independentSource: profile.strictEvidence && isIndependentEditorialSource(candidate.url),
    blogTrustedSource,
    lowTrustSource: profile.strictEvidence && isLowTrustDomain(candidate.url) && !blogTrustedSource,
    currentFactSignal: profile.strictEvidence
      && (CURRENT_FACT_PATTERN.test(text) || DATE_FACT_PATTERN.test(text))
      && freshness.staleYear !== true,
    phraseMatches,
    staleYear: freshness.staleYear,
    currentYearSignal: freshness.currentYearSignal,
    recentMonthSignal: freshness.recentMonthSignal
  };
}

function candidateFreshnessSignals(text, profile = {}) {
  if (!profile.highFreshness) {
    return { staleYear: false, currentYearSignal: false, recentMonthSignal: false };
  }
  const reference = parseReferenceDate(profile.referenceDate);
  const currentYear = reference.getFullYear();
  const currentMonth = reference.getMonth() + 1;
  const previousDate = new Date(currentYear, currentMonth - 2, 1);
  const recentPairs = new Set([
    `${currentYear}-${currentMonth}`,
    `${previousDate.getFullYear()}-${previousDate.getMonth() + 1}`
  ]);
  const years = [...String(text || "").matchAll(/(20\d{2})\s*년?/g)].map((match) => Number(match[1]));
  const yearMonthPairs = [...String(text || "").matchAll(/(20\d{2})\s*년\s*(\d{1,2})\s*월/g)]
    .map((match) => `${Number(match[1])}-${Number(match[2])}`);
  const hasExplicitYear = years.length > 0;
  const currentYearSignal = years.includes(currentYear);
  const recentMonthSignal = yearMonthPairs.some((pair) => recentPairs.has(pair));
  const staleYear = hasExplicitYear && !currentYearSignal;
  return { staleYear, currentYearSignal, recentMonthSignal };
}

function parseLinks(html, provider, channel = 'web') {
  const results = [];
  const seen = new Set();
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) && results.length < 40) {
    let url = decodeEntities(match[1]);
    const title = stripTags(match[2]);
    if (!title || title.length < 6) continue;
    if (/^(지도|자세히 보기|이용약관|개인정보처리방침|검색 고객센터|전체서비스)(?:\s*새 창 열림)?$|^©\s*NAVER/i.test(title)) continue;
    if (provider === "google" && url.startsWith("/url?")) {
      const parsed = new URL(url, "https://www.google.com");
      url = parsed.searchParams.get("q") || "";
    }
    if (provider === "naver" && url.startsWith("/")) {
      url = new URL(url, "https://search.naver.com").toString();
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (isLikelyAd(title, url)) continue;
    if (isLowValueResult(title, url) || !channelAllows(url, channel, provider)) continue;
    const key = canonicalUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ provider, title, url });
  }
  return results;
}

function channelAllows(url, channel, provider) {
  try {
    const u=new URL(url);
    if(channel==='blog') {
      if(/^(m\.)?blog\.naver\.com$/.test(u.hostname))return /^\/[^/]+\/\d+\/?$/.test(u.pathname) || (/\/PostView\.naver$/i.test(u.pathname) && /^\d+$/.test(u.searchParams.get('logNo') || ''));
      return provider==='google' && /\.tistory\.com$/.test(u.hostname) && u.pathname!=='/';
    }
    if(channel==='news' && provider==='naver')return /(^|\.)(news|sports|entertain)\.naver\.com$/.test(u.hostname) && /article|read/.test(u.pathname);
    return true;
  }catch{return false;}
}
function normalizeOutboundUrl(rawUrl, baseUrl = "") {
  try {
    let url = new URL(decodeEntities(rawUrl), baseUrl || "https://search.naver.com").toString();
    const parsed = new URL(url);
    const nested = parsed.searchParams.get("url")
      || parsed.searchParams.get("u")
      || parsed.searchParams.get("target")
      || parsed.searchParams.get("to");
    if (nested && /^https?:\/\//i.test(nested)) {
      url = decodeEntities(nested);
    }
    return /^https?:\/\//i.test(url) ? url : "";
  } catch {
    return "";
  }
}

function extractAuthorityLinks(html, baseUrl = "") {
  const results = [];
  const seen = new Set();
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(String(html || ""))) && results.length < MAX_AUTHORITY_LINK_CANDIDATES) {
    const url = normalizeOutboundUrl(match[1], baseUrl);
    if (!url || /getImageFile|\.(?:png|jpe?g|gif|svg|webp)(?:[?#]|$)/i.test(url)) continue;
    if (!isOfficialDomain(url) && !isInstitutionalDomain(url)) continue;
    const parsed=new URL(url), label=stripTags(match[2]);
    if(canonicalUrl(url)===canonicalUrl(baseUrl) || /^(본문|주메뉴).*바로가기|^(홈|HOME|정책정보|행사정보|로그인|회원가입|목록|메뉴열기)$/i.test(label))continue;
    if(/^\/$|\/(?:main|index)\.(?:do|html?)$/i.test(parsed.pathname) || /(?:View|List)\.do$/i.test(parsed.pathname) && ![...parsed.searchParams.keys()].some(k=>/id|seq|no/i.test(k)))continue;
    if (isLowValueResult("", url) || isUnsupportedContentUrl(url)) continue;
    const key = canonicalUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = stripTags(match[2]) || hostFromUrl(url);
    results.push({ provider: "source-link", title, url });
  }
  return results;
}

function extractAttachmentLinks(html,baseUrl) {
  const output=[];const pattern=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let match;
  while((match=pattern.exec(html)) && output.length<3){
    const url=normalizeOutboundUrl(match[1],baseUrl),title=stripTags(match[2]);if(!url)continue;
    if(require('./mediaFilter').isVideoUrl(url))continue;
    if(!/getImageFile|\.(?:png|jpe?g|gif|svg|webp)(?:[?#]|$)/i.test(url) && (/\.(pdf|hwp|hwpx)(?:[?#]|$)/i.test(url) || (/pdf|hwpx?|한글파일|다운로드/i.test(title) && /download|filedown|file|attach/i.test(url))))output.push({provider:'attachment',title,url});
  }return output;
}

function candidateMatchesSearchIntent(candidate, options) {
  const searchText = `${candidate.title || ""} ${candidate.url || ""}`.toLowerCase();
  const keywordTokens = tokenize(options.keyword || "");
  const topicTokens = tokenize(compactTopicForSearch(options.topic || "", options.keyword || ""));
  const queryTokens = tokenize(normalizeSearchQueries(options.searchQueries).join(" "));
  const requiredTokens = uniqueStrings([...keywordTokens, ...topicTokens, ...queryTokens])
    .filter((token) => token.length > 2 || /[0-9]/.test(token))
    .slice(0, 16);
  if (!requiredTokens.length) return true;
  return requiredTokens.some((token) => searchText.includes(token.toLowerCase()));
}

function findNaverBlogFrame(html, url) {
  if (!/blog\.naver\.com/i.test(url)) return "";
  const match = String(html || "").match(/<iframe[^>]+(?:id|name)=["']?mainFrame["']?[^>]+src=["']([^"']+)["']/i)
    || String(html || "").match(/<iframe[^>]+src=["']([^"']*PostView[^"']+)["']/i);
  if (!match) return "";
  return new URL(decodeEntities(match[1]), "https://blog.naver.com").toString();
}

function mobileNaverBlogUrl(url) {
  const match = String(url || "").match(/^https?:\/\/blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (!match) return "";
  return `https://m.blog.naver.com/${match[1]}/${match[2]}`;
}

function extractMetaDescription(html) {
  const match = String(html || "").match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)
    || String(html || "").match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
  return match ? stripTags(match[1]) : "";
}

function extractReadableText(html) {
  const withoutNoise = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(header|footer|nav|aside)\b[\s\S]*?<\/\1>/gi, " ");

  const preferredBlocks = [];
  const preferredRegex = /<(article|main|section|div|p)\b[^>]*(?:se-main-container|se_component_wrap|post_ct|post-view|article|content|entry|본문|view|post)[^>]*>([\s\S]*?)<\/\1>/gi;
  let block;
  while ((block = preferredRegex.exec(withoutNoise)) && preferredBlocks.length < 8) {
    const text = stripTags(block[2]);
    if (text.length > 120) preferredBlocks.push(text);
  }

  const text = preferredBlocks.length
    ? preferredBlocks.join("\n")
    : stripTags(withoutNoise);
  return text
    .replace(/\s*(공감|댓글|스크랩|공유하기|이 블로그|카테고리 글)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const text = String(value || "").toLowerCase();
  const tokens = text.match(/[가-힣a-z0-9]{2,}/g) || [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .slice(0, 80);
}

function tokenCounts(items) {
  const counts = new Map();
  for (const item of items) {
    for (const token of new Set(tokenize(item))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

function selectCommonTokens(candidates, options) {
  const counts = tokenCounts(candidates.map((item) => `${item.title} ${item.excerpt || ""}`));
  const topicTokens = new Set(tokenize(options.topic || ""));
  const keywordTokens = new Set(tokenize(options.keyword || ""));
  return [...counts.entries()]
    .map(([token, count]) => ({
      token,
      score: count + (topicTokens.has(token) ? 4 : 0) + (keywordTokens.has(token) ? 1 : 0)
    }))
    .filter((item) => item.score >= 2 || topicTokens.has(item.token) || keywordTokens.has(item.token))
    .sort((a, b) => b.score - a.score)
    .slice(0, 16)
    .map((item) => item.token);
}

function scoreCandidate(candidate, commonTokens, options, profile = buildSearchProfile(options)) {
  const textTokens = new Set(tokenize(`${candidate.title} ${candidate.excerpt || ""}`));
  const topicTokens = new Set(tokenize(options.topic || ""));
  const keywordTokens = new Set(tokenize([
    options.keyword || "",
    normalizeSearchQueries(options.searchQueries).join(" ")
  ].filter(Boolean).join(" ")));
  const signals = candidateSignals(candidate, profile);
  let score = 0;
  const matchedTerms = [];
  const topicMatchedTerms = [];
  const keywordMatchedTerms = [];

  for (const token of commonTokens) {
    if (textTokens.has(token)) {
      score += 1;
      matchedTerms.push(token);
    }
  }
  for (const token of topicTokens) {
    if (textTokens.has(token)) {
      score += 6;
      if (!matchedTerms.includes(token)) matchedTerms.push(token);
      topicMatchedTerms.push(token);
    }
  }
  for (const token of keywordTokens) {
    if (textTokens.has(token)) {
      score += 1;
      if (!matchedTerms.includes(token)) matchedTerms.push(token);
      keywordMatchedTerms.push(token);
    }
  }
  for (const phrase of signals.phraseMatches) {
    score += 4;
    if (!matchedTerms.includes(phrase)) matchedTerms.push(phrase);
    if (!keywordMatchedTerms.includes(phrase)) keywordMatchedTerms.push(phrase);
  }
  if (signals.officialSource) score += 5;
  if (signals.institutionalSource) score += 3;
  if (signals.independentSource) score += 3;
  if (signals.blogTrustedSource) score += 2;
  if (signals.currentFactSignal) score += 4;
  if (signals.lowTrustSource) score -= 4;
  if (signals.currentYearSignal) score += 2;
  if (signals.recentMonthSignal) score += 3;
  if (signals.staleYear) score -= 10;
  if ((candidate.excerpt || "").length > 180) score += 2;
  return {
    score,
    matchedTerms: matchedTerms.slice(0, 10),
    topicMatchedTerms: topicMatchedTerms.slice(0, 10),
    keywordMatchedTerms: keywordMatchedTerms.slice(0, 10),
    officialSource: signals.officialSource,
    institutionalSource: signals.institutionalSource,
    independentSource: signals.independentSource,
    blogTrustedSource: signals.blogTrustedSource,
    lowTrustSource: signals.lowTrustSource,
    currentFactSignal: signals.currentFactSignal,
    staleYear: signals.staleYear,
    currentYearSignal: signals.currentYearSignal,
    recentMonthSignal: signals.recentMonthSignal,
    strictEvidence: profile.strictEvidence,
    authorityEvidence: profile.authorityEvidence,
    independentEvidence: profile.independentEvidence
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchCandidateContent(candidate, options={}, log=()=>{}) {
  const attempts = [candidate.url];
  const mobileUrl = mobileNaverBlogUrl(candidate.url);
  if (mobileUrl) attempts.push(mobileUrl);
  const outboundLinks = [];
  let extractionError='';

  for (const attemptUrl of attempts) {
    try {
      let html = await readSourceDocument(attemptUrl,{onProgress:message=>log(message,'info'),maxPages:40,maxOcrPages:4});
      if(isLowValueResult(candidate.title,html.url) || (['naver','google'].includes(candidate.provider) && !channelAllows(html.url,normalizeSearchChannel(options.searchChannel),candidate.provider)))throw new Error('검색 범위 밖으로 이동한 원문을 제외했습니다.');
      if(typeof html.text==='string')return {...candidate,fetchedUrl:html.url,contentLength:html.text.length,fullText:html.text,excerpt:evidenceExcerpt(html.text,(options.searchQueries || []).join(' '),MAX_EXCERPT_CHARS),outboundLinks:[],extractionNote:html.extractionNote || ''};
      const resolvedUrl=html.url;
      html=html.html;
      outboundLinks.push(...extractAttachmentLinks(html,attemptUrl),...((isOfficialDomain(attemptUrl)||isInstitutionalDomain(attemptUrl))?[]:extractAuthorityLinks(html, attemptUrl)));
      const frameUrl = findNaverBlogFrame(html, attemptUrl);
      if (frameUrl) {
        html = await withTimeout(
          fetchText(frameUrl),
          CANDIDATE_FETCH_TIMEOUT_MS,
          "네이버 블로그 본문 프레임 요청 시간이 초과되었습니다."
        );
        outboundLinks.push(...extractAttachmentLinks(html,frameUrl),...extractAuthorityLinks(html, frameUrl));
      }
      const description = extractMetaDescription(html);
      const readable = extractReadableText(html);
      const text = readable.length >= 160 ? readable : description;
      if (text && text.length >= 80) {
        return {
          ...candidate,
          fetchedUrl: resolvedUrl,
          contentLength: text.length,
          fullText:text,
          excerpt: evidenceExcerpt(text, (options.searchQueries || []).join(" "), MAX_EXCERPT_CHARS),
          outboundLinks: uniqueCandidates(outboundLinks).slice(0, MAX_AUTHORITY_LINK_CANDIDATES)
        };
      }
    } catch(error) {
      extractionError=error.message;
      log(`원문 추출 실패: ${candidate.url} · ${error.message}`, 'warn');
      // Try the next URL form.
    }
  }

  return {
    ...candidate,
    fetchedUrl: "",
    contentLength: 0,
    extractionError,
    excerpt: "",
    outboundLinks: uniqueCandidates(outboundLinks).slice(0, MAX_AUTHORITY_LINK_CANDIDATES)
  };
}

function uniqueCandidates(items) {
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(items) ? items : []) {
    if(require('./mediaFilter').isVideoUrl(item?.url))continue;
    const key = canonicalUrl(item?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function mergeCandidateLists(priorityItems, existingItems, limit = 20) {
  return uniqueCandidates([...(priorityItems || []), ...(existingItems || [])]).slice(0, limit);
}

function isAuthorityCandidate(item) {
  return isOfficialDomain(item?.url) || isInstitutionalDomain(item?.url);
}

function isPrioritySourceCandidate(item, profile) {
  if (!profile?.strictEvidence) return false;
  if (isAuthorityCandidate(item)) return true;
  return profile.independentEvidence === true && isIndependentEditorialSource(item?.url);
}

function buildCandidateFetchList(items, profile, limit = 20) {
  const unique = uniqueCandidates(items);
  if (!profile?.strictEvidence) return unique.slice(0, limit);
  const priority = unique.filter((item) => isPrioritySourceCandidate(item, profile));
  return mergeCandidateLists(priority, unique, limit);
}

function normalizeSearchChannel(value) {
  return ["blog", "news", "web"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "blog";
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeSearchQueries(searchQueries) {
  const rawQueries = Array.isArray(searchQueries)
    ? searchQueries
    : String(searchQueries || "").split(/\n+/);
  return uniqueStrings(rawQueries)
    .filter((query) => query.length >= 3)
    .map((query) => query.slice(0, 140).trim())
    .slice(0, MAX_SEARCH_QUERY_VARIANTS);
}

function naverSearchTemplateFor(options = {}) {
  const channel = normalizeSearchChannel(options.searchChannel);
  if (channel === "news") return NAVER_NEWS_SEARCH_URL;
  if (channel === "web") return NAVER_WEB_SEARCH_URL;
  return NAVER_BLOG_SEARCH_URL;
}

function buildSearchUrl(provider, template, topic, keyword, topicMode, querySuffix = "", queryOverride = "") {
  const queryText = queryOverride
    ? [String(queryOverride || "").replace(/\s+/g, " ").trim(), querySuffix]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260)
    : buildQueryText(topic, keyword, topicMode, querySuffix);
  const query = encodeURIComponent(queryText);
  if (template && template.includes("{query}")) {
    return template.replace("{query}", query);
  }
  if (provider === "naver") {
    return `https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query=${query}`;
  }
  return `https://www.google.com/search?q=${query}&num=20&hl=ko`;
}

async function providerSearch(provider, options, querySuffix = "", queryOverride = "", fetcher=fetchText) {
  const template = provider === "naver" ? naverSearchTemplateFor(options) : options.googleSearchUrl;
  let url = buildSearchUrl(
    provider,
    template,
    options.topic,
    options.keyword,
    options.topicMode,
    querySuffix,
    queryOverride
  );
  if(provider==='google' && normalizeSearchChannel(options.searchChannel)==='blog'){
    const scoped=new URL(url),q=scoped.searchParams.get('q');
    if(q===null)throw new Error('블로그 범위를 적용할 수 없는 Google 검색 URL입니다.');
    scoped.searchParams.set('q','('+q+') (site:blog.naver.com OR site:tistory.com)');url=scoped.href;
  }
  const html = await fetcher(url);
  const results=parseLinks(html, provider, normalizeSearchChannel(options.searchChannel));
  // Search engines may ignore OR/site syntax. Enforce the requested host scope
  // before treating unrelated results as readable evidence and suppressing fallback.
  const sites=[...String(queryOverride).matchAll(/(?:^|\s)site:([a-z0-9.-]+)/gi)].map(m=>m[1].toLowerCase());
  return sites.length?results.filter(item=>sites.some(site=>{const host=hostFromUrl(item.url);return host===site || host.endsWith('.'+site);})):results;
}

function isStrongCandidate(item, profile) {
  if (!profile.strictEvidence) return Number(item?.relevance?.score || 0) >= 3;
  const relevance = item.relevance || {};
  const hasDirectKeyword = Array.isArray(relevance.keywordMatchedTerms) && relevance.keywordMatchedTerms.length > 0;
  const hasAuthoritySource = relevance.officialSource === true || relevance.institutionalSource === true;
  const hasIndependentSource = relevance.independentSource === true;
  const hasReliableSource = profile.authorityEvidence
    ? hasAuthoritySource
    : profile.independentEvidence
      ? hasAuthoritySource || hasIndependentSource
      : hasAuthoritySource || relevance.blogTrustedSource === true || relevance.lowTrustSource !== true;
  return hasReliableSource
    && relevance.currentFactSignal === true
    && hasDirectKeyword
    && Number(relevance.score || 0) >= 8;
}

function selectAuthorityClues(items, options) {
  const text = [
    options.topic,
    options.keyword,
    options.publishPurpose,
    options.researchGuidance,
    normalizeSearchQueries(options.searchQueries).join(" "),
    ...items.slice(0, 5).flatMap((item) => [item?.title, item?.excerpt])
  ].filter(Boolean).join(" ");
  const priority = [
    ...(String(text).match(/20\d{2}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|20\d{2}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일/g) || []),
    ...(String(text).match(/[가-힣A-Za-z0-9]+(?:부|청|처|공단|공사|진흥원|위원회|센터|재단|협회|소상공인24|고용24|기업마당)/g) || []),
    ...(String(text).match(/[가-힣A-Za-z0-9]+(?:지원사업|정책자금|직접대출|공고|모집|사업|제도|법|Act)/g) || [])
  ];
  return uniqueStrings(priority)
    .filter((item) => item.length >= 3)
    .slice(0, 8)
    .join(" ");
}

function selectEvidenceSearchTerms(options, items = []) {
  const text = [
    options.topic,
    options.keyword,
    options.category,
    options.publishPurpose,
    options.researchGuidance,
    normalizeSearchQueries(options.searchQueries).join(" "),
    ...items.slice(0, 5).flatMap((item) => [item?.title, item?.excerpt])
  ].filter(Boolean).join(" ");
  const groups = [
    {
      pattern: /(신청|접수|모집|채용|지원금|지원\s*대상|지원\s*조건|정책\s*자금|대출|보조금|자격|마감|공고)/i,
      terms: ["공식 공고", "신청 조건", "대상 자격", "접수 기간"]
    },
    {
      pattern: /(공시|계약|수주|공급계약|IR|investor|투자자|실적|잠정실적|매출|영업이익|배당|자사주)/i,
      terms: ["공시", "IR", "투자자 자료", "계약 원문"]
    },
    {
      pattern: /(보고서|전망|지표|지수|통계|데이터|등급|신용평가|산업\s*전망|수주잔고|선가|시장\s*자료)/i,
      terms: ["보고서", "지표", "통계", "원문", "PDF"]
    },
    {
      pattern: /(발표|출시|공개|업데이트|로드맵|제품|모델|기술|launch|release|announcement|unveil)/i,
      terms: ["공식 발표", "뉴스룸", "자료", "원문"]
    },
    {
      pattern: /(법령|법률|규제|세금|세무|의료|보험|허가|인증)/i,
      terms: ["법령", "고시", "기관 원문", "PDF"]
    }
  ];
  const terms = [];
  for (const group of groups) {
    if (group.pattern.test(text)) {
      terms.push(...group.terms);
    }
  }
  if (/PDF|원문|공식|기관|자료/i.test(text)) {
    terms.push("공식 자료", "원문", "PDF");
  }
  return uniqueStrings(terms.length ? terms : ["공식 자료", "원문", "보고서", "PDF"])
    .slice(0, 8)
    .join(" ");
}

function focusedOfficialSearchSuffix(options, profile, items = []) {
  if (!profile.strictEvidence) return "";
  const phrases = profile.keywordPhrases.slice(0, 4).join(" ");
  const topic = String(options.topic || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const clues = selectAuthorityClues(items, options);
  const evidenceTerms = selectEvidenceSearchTerms(options, items);
  return [clues, topic, phrases, evidenceTerms]
    .filter(Boolean)
    .join(" ")
    .slice(0, 220);
}

function focusedIndependentSearchSuffix(options, profile, items = []) {
  if (!profile.strictEvidence || !profile.independentEvidence) return "";
  const phrases = profile.keywordPhrases.slice(0, 4).join(" ");
  const topic = String(options.topic || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const clues = selectAuthorityClues(items, options);
  return [clues, topic, phrases, "news report coverage analysis launch release announced"]
    .filter(Boolean)
    .join(" ")
    .slice(0, 220);
}

function compactKeywordQuery(keyword, maxPhrases = 6) {
  return splitKeywordPhrases(keyword).slice(0, maxPhrases).join(" ");
}

function buildQueryText(topic, keyword, topicMode, querySuffix = "") {
  const cleanedTopic = String(topic || "").replace(/\s+/g, " ").trim();
  const keywordText = compactKeywordQuery(keyword, String(topicMode || "manual") === "auto" ? 6 : 4);
  const isAuto = String(topicMode || "manual") === "auto";
  const topicText = isAuto
    ? compactTopicForSearch(cleanedTopic, keyword, keywordText ? 55 : 140)
    : cleanedTopic.slice(0, 140);
  const base = (isAuto ? [keywordText, topicText] : [topicText, keywordText])
    .filter(Boolean)
    .join(" ")
    .slice(0, 180);
  return [base, querySuffix]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

async function collectProviderCandidates(providers, options, log, querySuffix = "", control = {}) {
  const all = [];
  for (const provider of providers) {
    if (!["naver", "google"].includes(provider)) continue;
    if (control.attemptedProviders instanceof Set) {
      control.attemptedProviders.add(provider);
    }
    try {
      log(`${provider.toUpperCase()} 검색을 시도합니다.`);
      const optionVariants = [options];
      for (const optionVariant of optionVariants) {
        const results = await (control.searchProvider || providerSearch)(
          provider,
          optionVariant,
          querySuffix,
          control.queryOverride || ""
        );
        all.push(...results);
      }
    } catch (error) {
      log(`${provider.toUpperCase()} 검색 실패: ${error.message}`);
    }
    if (all.length >= 20 && control.forceAllProviders !== true) break;
  }
  return all;
}

function shouldRunFallbackForSparseSelection(selected, attemptedProviders, primary, fallback, profile) {
  if (!["naver", "google"].includes(fallback)) return false;
  if (fallback === primary) return false;
  if (attemptedProviders instanceof Set && attemptedProviders.has(fallback)) return false;
  return (Array.isArray(selected) ? selected.length : 0) === 0;
}

function createRetrievalContext(){return {queries:new Map(),documents:new Map(),searchRequests:0,documentRequests:0,maxSearchRequests:24,maxDocumentRequests:60,attachmentRequests:0,maxAttachmentRequests:8,events:[]};}
async function collectSearchResults(options, log = () => {}, dependencies = {}) {
  const cache=dependencies.context || createRetrievalContext();
  let stageDocuments=0,budgetBlocked=false;
  const warnOnce=(key,message)=>{cache.budgetWarnings ||= new Set();if(!cache.budgetWarnings.has(key)){cache.budgetWarnings.add(key);log(message,'warn');}};
  const discovery=options.retrievalStage==='discovery';
  const originalSearch=dependencies.searchProvider || providerSearch;
  const cachedSearch=async(provider,settings,suffix,query)=>{
    const key=JSON.stringify([provider,normalizeSearchChannel(settings.searchChannel),String(query || buildQueryText(settings.topic,settings.keyword,settings.topicMode)).replace(/\s+/g,' ').trim().toLowerCase(),suffix || '',settings.naverSearchUrl || '',settings.googleSearchUrl || '']);
    if(cache.queries.has(key)){log('검색 결과 재사용: '+query);return cache.queries.get(key);}
    if(cache.searchRequests>=cache.maxSearchRequests){log('작업 검색 요청 한도에 도달하여 추가 요청을 중지합니다.','warn');return [];}
    cache.searchRequests++;cache.events.push({type:'search',provider,channel:settings.searchChannel,query});
    const pending=originalSearch(provider,settings,suffix,query).catch(error=>{cache.events.push({type:'search_error',query,reason:error.message});throw error;});
    cache.queries.set(key,pending);return pending;
  };
  const primary = String(options.primaryProvider || "naver").toLowerCase();
  const fallback = String(options.fallbackProvider || "google").toLowerCase();
  const providers = [primary];
  log('검색 범위: '+normalizeSearchChannel(options.searchChannel)+' · '+primary.toUpperCase()+' 우선, 읽을 수 있는 결과가 없을 때만 '+fallback.toUpperCase()+' 대체 검색');
  const profile = buildSearchProfile(options);
  const queryVariants = normalizeSearchQueries(options.searchQueries);
  const attemptedProviders = new Set();
  const providerControl = {
    forceAllProviders: true,
    searchProvider: cachedSearch,
    attemptedProviders
  };
  const collectRawCandidates = async (querySuffix = "", providerList = providers, control = providerControl) => {
    if (!queryVariants.length) {
      return collectProviderCandidates(providerList, options, log, querySuffix, control);
    }
    const collected = [];
    for (const query of queryVariants) {
      log(`Narrow search query: ${query}`);
      const queryResults = await collectProviderCandidates(
        providerList,
        options,
        log,
        querySuffix,
        { ...control, queryOverride: query }
      );
      collected.push(...queryResults);
    }
    return collected;
  };
  const initialFreshnessSuffix = queryVariants.length ? "" : profile.highFreshness ? freshnessSearchSuffix(options) : "";
  let all = await collectRawCandidates(initialFreshnessSuffix);

  const buildFilteredCandidates = (items) => {
    const seen = new Set();
    const filtered = items
      .filter((item) => {
        const key = canonicalUrl(item.url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .filter((item) => !isLowValueResult(item.title, item.url) && channelAllows(item.url, normalizeSearchChannel(options.searchChannel), item.provider))
      ;
    return buildCandidateFetchList(filtered, profile, options.maxCandidates || 20);
  };
  let candidates = buildFilteredCandidates(all);

  if (!candidates.length && shouldRunFallbackForSparseSelection([], attemptedProviders, primary, fallback, profile)) {
    log(`읽을 수 있는 결과가 없어 동일 채널로 대체 검색: ${fallback.toUpperCase()}`);
    const fallbackResults = await collectRawCandidates("", [fallback], { ...providerControl, forceAllProviders: true });
    all = [...all, ...fallbackResults];
    candidates = buildFilteredCandidates(all);
  }

  if (!candidates.length) return [];

  const contentCache = cache.documents;
  const enrichAndScore = async (items) => {
    const freshItems=items.filter(item=>!contentCache.has(canonicalUrl(item.url)));
    log('새 원문 '+freshItems.length+'개 확인 · 기존 원문 '+(items.length-freshItems.length)+'개 재사용');
    let completed = 0;
    const enriched = await mapLimit(
      items,
      CONTENT_FETCH_CONCURRENCY,
      async (candidate) => {
        const key=canonicalUrl(candidate.url);
        if (!contentCache.has(key)) {
          if(cache.documentRequests>=cache.maxDocumentRequests || stageDocuments>=(options.maxStageDocuments || Infinity) || (discovery && (cache.discoveryDocuments || 0)>=24)){
            budgetBlocked=true;warnOnce(options.retrievalStage || 'all','원문 수집 예산 도달: '+(options.retrievalStage || '전체')+' 단계의 새 다운로드를 중지하고 확보한 자료를 사용합니다.');return null;
          }
          if(candidate.provider==='attachment' || /fileDown|download|\.(pdf|hwpx?)(?:[?#]|$)/i.test(candidate.url)){if(cache.attachmentRequests>=cache.maxAttachmentRequests || (discovery && (cache.discoveryAttachments || 0)>=3)){budgetBlocked=true;warnOnce('attachments','첨부 수집 예산 도달: 확보한 자료를 사용합니다.');return null;}cache.attachmentRequests++;if(discovery)cache.discoveryAttachments=(cache.discoveryAttachments || 0)+1;}
          stageDocuments++;if(discovery)cache.discoveryDocuments=(cache.discoveryDocuments || 0)+1;
          cache.documentRequests++;
          contentCache.set(key,(dependencies.fetchCandidate || fetchCandidateContent)(candidate,options,log));
        }
        const cached=await contentCache.get(key);
        const anchors=(options.evidenceRequests || []).filter(r=>canonicalUrl(r.sourceUrl)===key).flatMap(r=>r.anchors || []);
        const result=cached?{...cached,...(candidate.sourcePage?{sourcePage:candidate.sourcePage}:{}),excerpt:cached.fullText?evidenceExcerpt(cached.fullText,(options.searchQueries || []).join(' '),MAX_EXCERPT_CHARS,anchors):cached.excerpt}:null;
        cache.events.push({type:'document',url:candidate.url,readable:Boolean(result?.excerpt),sourcePage:candidate.sourcePage || '',error:result?.extractionError || ''});
        completed += 1;
        if (freshItems.length && completed === items.length) {
          log(`본문 추출 진행: ${completed}/${items.length}`);
        }
        return result;
      }
    );
    const validEnriched = enriched.filter(Boolean);
    const withContent = validEnriched.filter((item) => String(item.excerpt || "").trim().length >= 80);
    if (!withContent.length) return { selected: [], withContent: [] };
    const commonTokens = selectCommonTokens(withContent, options);
    const scoredAll = withContent.map((item) => {
      const relevance = scoreCandidate(item, commonTokens, options, profile);
      return { ...item, relevance };
    });
    const eligible = scoredAll; // Rank retrieval hints without discarding semantic alternatives.
    const sorted = eligible.sort((a, b) => b.relevance.score - a.relevance.score);
    const priorityEvidence = sorted.filter((item) => isPrioritySourceCandidate(item, profile));
    const scored = profile.strictEvidence
      ? mergeCandidateLists(priorityEvidence, sorted, MAX_SELECTED_CONTENT_RESULTS)
      : sorted.slice(0, MAX_SELECTED_CONTENT_RESULTS);

    return { selected: scored, withContent };
  };

  let { selected, withContent } = await enrichAndScore(candidates);
  if (!budgetBlocked && shouldRunFallbackForSparseSelection(selected, attemptedProviders, primary, fallback, profile)) {
    log(`읽을 수 있는 결과가 없어 동일 채널로 대체 검색: ${fallback.toUpperCase()}`);
    const fallbackResults = await collectRawCandidates("", [fallback], { ...providerControl, forceAllProviders: true });
    all = [...all, ...fallbackResults];
    candidates = buildFilteredCandidates(all);
    ({ selected, withContent } = await enrichAndScore(candidates));
  }
  // Follow explicitly cited sources, then their attachments; never silently widen search.
  // Two levels allow blog -> official notice -> HWP/PDF without recursive crawling.
  const followed=new Set(candidates.map(c=>canonicalUrl(c.url)));
  if(profile.strictEvidence)for(let depth=0;depth<2;depth++){
    const links=uniqueCandidates((selected.length?selected:withContent).flatMap(item=>(item.outboundLinks || []).map(link=>({...link,sourcePage:item.url}))))
      .filter(link=>!followed.has(canonicalUrl(link.url)))
      .sort((a,b)=>Number(b.provider==='attachment')-Number(a.provider==='attachment'))
      .slice(0,MAX_AUTHORITY_LINK_CANDIDATES);
    if(!links.length)break;
    for(const link of links)followed.add(canonicalUrl(link.url));
    log('본문에 연결된 출처·첨부 '+links.length+'개 확인 (검색 채널 확장 없음)');
    candidates=mergeCandidateLists(links,candidates,20);
    ({selected,withContent}=await enrichAndScore(candidates));
  }

  if (!withContent.length) {
    log("읽을 수 있는 원문이 없어 근거 없는 재검토를 생략합니다.", "warn");
    return [];
  }
  log(`본문 추출 ${withContent.length}개, 공통 주제 후보 ${selected.length}개를 사용합니다.`);
  return selected.map((item, index) => ({
    sourceId: `${item.provider || "source"}-${index + 1}`,
    provider: item.provider,
    title: item.title,
    url: item.url,
    fetchedUrl: item.fetchedUrl,
    contentLength: item.contentLength,
    excerpt: item.excerpt,
    sourcePage: item.sourcePage || "",
    outboundLinks: Array.isArray(item.outboundLinks) ? item.outboundLinks : [],
    extractionNote:item.extractionNote || "",
    relevance: item.relevance || { score: 0, matchedTerms: [] }
  }));
}

function hasDirectRelevance(item) {
  const relevance = item?.relevance || {};
  const score = Number(relevance.score || 0);
  const matchedCount = [
    ...(Array.isArray(relevance.topicMatchedTerms) ? relevance.topicMatchedTerms : []),
    ...(Array.isArray(relevance.keywordMatchedTerms) ? relevance.keywordMatchedTerms : []),
    ...(Array.isArray(relevance.matchedTerms) ? relevance.matchedTerms : [])
  ].length;
  return score >= 3 && matchedCount > 0;
}

function hasStrongEvidence(item) {
  const relevance = item?.relevance || {};
  const hasDirectKeyword = Array.isArray(relevance.keywordMatchedTerms) && relevance.keywordMatchedTerms.length > 0;
  const hasAuthoritySource = relevance.officialSource === true || relevance.institutionalSource === true;
  const hasIndependentSource = relevance.independentSource === true;
  const hasReliableSource = relevance.authorityEvidence === true
    ? hasAuthoritySource
    : relevance.independentEvidence === true
      ? hasAuthoritySource || hasIndependentSource
      : hasAuthoritySource || relevance.blogTrustedSource === true || relevance.lowTrustSource !== true;
  return relevance.strictEvidence === true
    && hasReliableSource
    && relevance.currentFactSignal === true
    && hasDirectKeyword
    && Number(relevance.score || 0) >= 8;
}

function summarizeSourceQuality(searchResults, _topicMode = "manual", options = {}) {
  const results = Array.isArray(searchResults) ? searchResults : [];
  const withExcerpt = results.filter((item) => String(item?.excerpt || "").trim().length >= 80);
  const usable = results.filter((item) => {
    const excerptLength = String(item?.excerpt || "").trim().length;
    const contentLength = Number(item?.contentLength || 0);
    return excerptLength >= 120 || contentLength >= 300;
  });
  const directlyRelevant = results.filter(hasDirectRelevance);
  const topicMatched = results.filter((item) => Array.isArray(item?.relevance?.topicMatchedTerms) && item.relevance.topicMatchedTerms.length);
  const strongEvidence = results.filter(hasStrongEvidence);
  const authorityEvidence = results.filter((item) => item?.relevance?.officialSource === true || item?.relevance?.institutionalSource === true);
  const independentEvidence = results.filter((item) => item?.relevance?.independentSource === true);
  const trustedBlogDiscovery = results.filter((item) => item?.relevance?.blogTrustedSource === true);
  const strictEvidence = String(options.searchNeed || "").toLowerCase() === "strict"
    && results.some((item) => item?.relevance?.strictEvidence === true);
  const authorityRequired = strictEvidence && results.some((item) => item?.relevance?.authorityEvidence === true);
  const independentRequired = strictEvidence && results.some((item) => item?.relevance?.independentEvidence === true);
  const usableRelevant = usable.filter(hasDirectRelevance);
  const status = usable.length ? "available" : "insufficient";
  const compactSource = (item, index) => ({
    sourceId: String(item?.sourceId || `source-${index + 1}`),
    provider: String(item?.provider || ""),
    title: String(item?.title || ""),
    url: String(item?.url || ""),
    score: Number(item?.relevance?.score || 0),
    officialSource: item?.relevance?.officialSource === true,
    institutionalSource: item?.relevance?.institutionalSource === true,
    independentSource: item?.relevance?.independentSource === true
  });
  return {
    status,
    totalCandidates: results.length,
    extractedCandidates: withExcerpt.length,
    usableExtractedCandidates: usable.length,
    directlyRelevantCandidates: directlyRelevant.length,
    topicMatchedCandidates: topicMatched.length,
    strongEvidenceCandidates: strongEvidence.length,
    authorityEvidenceRequired: authorityRequired,
    authorityEvidenceCandidates: authorityEvidence.length,
    authorityEvidenceSources: authorityEvidence.slice(0, 6).map(compactSource),
    independentEvidenceRequired: independentRequired,
    independentEvidenceCandidates: independentEvidence.length,
    independentEvidenceSources: independentEvidence.slice(0, 6).map(compactSource),
    trustedBlogDiscoveryCandidates: trustedBlogDiscovery.length,
    reason: usable.length ? "발췌 확보. 사실성·현재성·직접 관련성은 원문을 읽은 모델이 판단합니다." : "원문 발췌가 부족합니다. 제목과 URL만으로 사실을 확정하지 마세요."
  };
}

module.exports = {
  collectSearchResults,createRetrievalContext,
  summarizeSourceQuality,
  _private: {
    fetchCandidateContent,extractAttachmentLinks,stripTags,parseLinks,providerSearch,channelAllows,
    naverSearchTemplateFor,
    buildQueryText,
    buildSearchProfile,
    scoreCandidate,
    summarizeSourceQuality,
    isLowValueResult,
    isUnsupportedContentUrl,
    compactTopicForSearch,
    normalizeSearchQueries,
    requiresAuthoritySourceEvidence,
    requiresIndependentSourceEvidence,
    isIndependentEditorialSource,
    freshnessDateHints,
    freshnessSearchSuffix,
    selectAuthorityClues,
    selectEvidenceSearchTerms,
    extractAuthorityLinks,
    mergeCandidateLists,
    buildCandidateFetchList,
    candidateMatchesSearchIntent,
    isStrongCandidate,
    hasDirectRelevance,
    hasStrongEvidence
  }
};
