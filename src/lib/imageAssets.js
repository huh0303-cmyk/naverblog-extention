const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { normalizeMaxBodyImages } = require("./settings");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function safeTopicName(topic) {
  return String(topic || "blog")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function listImageFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return isImageFile(dir) ? [dir] : [];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile() && isImageFile(filePath);
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function resolveImageSource(jobDir, rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(jobDir, value);
}

function copyIfExists(source, target) {
  if (!source || !fs.existsSync(source)) return "";
  const sourceStat = fs.statSync(source);
  if (sourceStat.isDirectory()) {
    const [firstImage] = listImageFiles(source);
    if (!firstImage) return "";
    return copyIfExists(firstImage, target);
  }
  if (!sourceStat.isFile() || !isImageFile(source)) return "";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  target = target.replace(/\.[^.]+$/, path.extname(source).toLowerCase());
  fs.copyFileSync(source, target);
  return target;
}

function copyImageOrWarn(source, target, warnings, label) {
  try {
    const copied = copyIfExists(source, target);
    if (!copied) {
      warnings.push(`${label} 파일을 찾거나 복사하지 못했습니다: ${source}`);
    }
    return copied;
  } catch (error) {
    warnings.push(`${label} 복사 실패: ${source} (${error.message})`);
    return "";
  }
}

function imageStorageFailureNoteScope(note) {
  const text = String(note || "");
  const isImageNote = /이미지|image|bodyImages|titleImagePath|generated_images/i.test(text);
  const isFailureNote = /(복사|저장|실패|오류|권한|쓰기 가능 루트 밖|EPERM|operation not permitted|unavailable|비워|empty|찾을 수 없|제공하지 못|생성 원본 이미지 경로)/i.test(text);
  if (!isImageNote || !isFailureNote) return "";

  const titleScoped = /titleImagePath|타이틀|제목|title image/i.test(text);
  const bodyScoped = /bodyImages|본문|body image/i.test(text);
  if (titleScoped && !bodyScoped) return "title";
  if (bodyScoped && !titleScoped) return "body";
  return "any";
}

function shouldKeepImageStorageFailureNote(note, titleImagePath, bodyImages) {
  const scope = imageStorageFailureNoteScope(note);
  if (!scope) return true;
  const hasTitleImage = Boolean(titleImagePath);
  const hasBodyImage = Array.isArray(bodyImages) && bodyImages.length > 0;
  if (scope === "title") return !hasTitleImage;
  if (scope === "body") return !hasBodyImage;
  return !(hasTitleImage || hasBodyImage);
}

function normalizeAgentResult({
  runtimeRoot,
  jobDir,
  topic,
  result,
  includeTitleImage = true,
  maxBodyImages = 10,
  currentDateLabel = ""
}) {
  const title = String(result.title || "").trim();
  let article = String(result.article || "").trim();
  const bodyImageLimit = normalizeMaxBodyImages(maxBodyImages);
  if (!title) {
    throw new Error("Codex 결과에 제목이 없습니다.");
  }
  if (!article) {
    throw new Error("Codex 결과에 본문이 없습니다.");
  }

  const imageRoot = path.join(runtimeRoot, "image", path.basename(jobDir));
  const safeTopic = safeTopicName(topic);
  const bodyImages = [];
  const imageWarnings = [];
  const resultNotes = Array.isArray(result.notes) ? result.notes : [];
  const imagesRequested = includeTitleImage || bodyImageLimit > 0;

  if (bodyImageLimit === 0) {
    article = article.replace(/\n?\[IMAGE INSERT\s*-\s*\d+\]\n?/gi, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  for (const item of bodyImageLimit > 0 && Array.isArray(result.bodyImages) ? result.bodyImages.slice(0, bodyImageLimit) : []) {
    const sequence = Number(item.sequence || bodyImages.length + 1);
    const source = resolveImageSource(jobDir, item.path);
    const target = path.join(imageRoot, `${safeTopic}_img_${sequence}.png`);
    const copied = copyImageOrWarn(source, target, imageWarnings, `본문 이미지 ${sequence}`);
    if (copied) {
      bodyImages.push({
        sequence,
        path: copied,
        prompt: String(item.prompt || "")
      });
    }
  }

  let titleImagePath = "";
  if (includeTitleImage && result.titleImagePath) {
    const source = resolveImageSource(jobDir, result.titleImagePath);
    titleImagePath = copyImageOrWarn(source, path.join(imageRoot, `${safeTopic}_img_title.png`), imageWarnings, "타이틀 이미지");
  }

  // Never guess image ownership from unrelated Codex session timestamps.
  if (imagesRequested && bodyImages.length === 0 && !titleImagePath) {
    imageWarnings.push("생성된 이미지 파일이 없습니다.");
  }

  return {
    title,
    article,
    tags: Array.isArray(result.tags) ? result.tags : [],
    bodyImages,
    titleImagePath,
    notes: [
      ...resultNotes.filter((note) => {
        if (!imagesRequested && /이미지|image/i.test(String(note || ""))) {
          return false;
        }
        return shouldKeepImageStorageFailureNote(note, titleImagePath, bodyImages);
      }),
      ...imageWarnings
    ],
    imageWarnings
  };
}

function getPreviewImages(agentResult) {
  const images = [];
  if (agentResult.titleImagePath) {
    images.push({
      role: "title",
      sequence: "title",
      path: agentResult.titleImagePath,
      url: pathToFileURL(agentResult.titleImagePath).toString()
    });
  }
  for (const item of agentResult.bodyImages) {
    images.push({
      role: "body",
      sequence: item.sequence,
      path: item.path,
      url: pathToFileURL(item.path).toString()
    });
  }
  return images;
}

module.exports = {
  normalizeAgentResult,
  getPreviewImages
};
