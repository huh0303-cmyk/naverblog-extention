const fs = require("node:fs");
const { defaultCodexCommand, isDefaultCodexCommand, resolveCodexCmdPath } = require("./codexPlatform");
const path = require("node:path");

const LEGACY_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?where=web&query={query}";
const DEFAULT_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1", "3:4"]);

const DEFAULT_SETTINGS = {
  blogId: "",
  topic: "",
  keyword: "",
  category: "",
  codexCmdPath: defaultCodexCommand(),
  codexModel: "",
  primarySearchProvider: "naver",
  fallbackSearchProvider: "google",
  naverSearchUrl: DEFAULT_NAVER_SEARCH_URL,
  googleSearchUrl: "https://www.google.com/search?q={query}&num=20&hl=ko",
  naverEditorDomNotes: "",
  publishAfterGenerate: true,
  publishPrivate: true,
  topicMode: "auto",
  repeatTermMinutes: 60,
  crossPublish: false,
  publishVisibility: "private",
  publishScheduleMode: "now",
  reserveAfterHours: 3,
  publishToTistoryAfterNaver: false,
  tistoryBlogId: "",
  tistorySessionStatus: "unknown",
  tistorySessionCheckedAt: "",
  includeTitleImage: true,
  imageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  titleImageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  bodyImageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  maxBodyImages: 10,
  breakSentencesInBody: true,
  agentModels: {
    main: "high",
    research: "high",
    writer: "high",
    image: "medium"
  },
  codexRateLimits: null,
  agentHarnessMode: "lean"
};

function getSettingsPath(runtimeRoot) {
  return path.join(runtimeRoot, "user-settings.json");
}

function ensureSettingsFile(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const settingsPath = getSettingsPath(runtimeRoot);
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, "utf8");
  }
}

function normalizeSettings(settings) {
  const normalized = { ...settings, topicMode: "auto", topic: "", publishAfterGenerate: true, breakSentencesInBody: true };
  if (!String(normalized.blogId || "").trim() && String(normalized.naverId || "").trim()) {
    normalized.blogId = String(normalized.naverId).trim();
  }
  delete normalized.naverId;
  delete normalized.naverPassword;
  delete normalized.password;
  if (!normalized.naverSearchUrl || normalized.naverSearchUrl === LEGACY_NAVER_SEARCH_URL) {
    normalized.naverSearchUrl = DEFAULT_NAVER_SEARCH_URL;
  }
  normalized.imageAspectRatio = normalizeImageAspectRatio(normalized.imageAspectRatio);
  normalized.titleImageAspectRatio = normalizeImageAspectRatio(normalized.titleImageAspectRatio || normalized.imageAspectRatio);
  normalized.bodyImageAspectRatio = normalizeImageAspectRatio(normalized.bodyImageAspectRatio || normalized.imageAspectRatio);
  normalized.maxBodyImages = normalizeMaxBodyImages(normalized.maxBodyImages);
  normalized.codexModel = normalizeCodexModel(normalized.codexModel);
  if (isDefaultCodexCommand(normalized.codexCmdPath)) normalized.codexCmdPath = defaultCodexCommand();
  return normalized;
}

function normalizeMaxBodyImages(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 10;
  return Number(value) > 0 ? 10 : 0;
}

function normalizeCodexModel(value) {
  const normalized = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(normalized) ? normalized : "";
}

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function readSettings(runtimeRoot) {
  ensureSettingsFile(runtimeRoot);
  try {
    const raw = fs.readFileSync(getSettingsPath(runtimeRoot), "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      agentModels: {
        ...DEFAULT_SETTINGS.agentModels,
        ...(parsed.agentModels || {})
      }
    };
    if (!Object.prototype.hasOwnProperty.call(parsed, "titleImageAspectRatio")) {
      merged.titleImageAspectRatio = parsed.imageAspectRatio;
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "bodyImageAspectRatio")) {
      merged.bodyImageAspectRatio = parsed.imageAspectRatio;
    }
    const normalized = normalizeSettings(merged);
    if (
      Object.prototype.hasOwnProperty.call(parsed, "naverId")
      || Object.prototype.hasOwnProperty.call(parsed, "naverPassword")
      || Object.prototype.hasOwnProperty.call(parsed, "password")
    ) {
      try {
        fs.writeFileSync(getSettingsPath(runtimeRoot), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      } catch {
        // A read-only legacy file must not prevent the already sanitized settings from loading.
      }
    }
    return normalized;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(runtimeRoot, nextSettings) {
  ensureSettingsFile(runtimeRoot);
  const current = readSettings(runtimeRoot);
  const merged = {
    ...current,
    ...Object.fromEntries(Object.entries(nextSettings || {}).filter(([, value]) => value !== undefined))
  };
  const normalized = normalizeSettings(merged);
  // A stopped app must retain either the previous complete checkpoint or the
  // new one, never a truncated settings file that reads as default settings.
  const destination=getSettingsPath(runtimeRoot);
  const temporary=destination+'.'+process.pid+'.tmp';
  try{
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {encoding:'utf8',flush:true});
    fs.renameSync(temporary,destination);
  }catch(error){
    try{fs.unlinkSync(temporary);}catch{}
    throw error;
  }
  return normalized;
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_NAVER_SEARCH_URL,
  DEFAULT_IMAGE_ASPECT_RATIO,
  normalizeCodexModel,
  resolveCodexCmdPath,
  ensureSettingsFile,
  normalizeImageAspectRatio,
  normalizeMaxBodyImages,
  readSettings,
  writeSettings,
  getSettingsPath
};
