// 按 tag 读 mod.hjson / mod.json，解析 version 与 minGameVersion

import { parse as parseHjson } from 'hjson';
import { rawFileUrlVariants } from './releases.js';

// 候选顺序：root hjson → root json → assets hjson → assets json；
// hasJava 时 hjson 优先，否则 json 优先（两种都试）
const CANDIDATES = {
  java: ['mod.hjson', 'mod.json', 'assets/mod.hjson', 'assets/mod.json'],
  other: ['mod.json', 'mod.hjson', 'assets/mod.json', 'assets/mod.hjson'],
};

// 解析彻底失败时的正则兜底：只捞需要的两个字段（两种扩展名里都可能是 HJSON 语法）
const FALLBACK_PATTERNS = {
  version: /(?:^|[\s,{])version\s*:\s*["']?([^"'\n,}]+)/m,
  minGameVersion: /(?:^|[\s,{])minGameVersion\s*:\s*["']?([^"'\n,}]+)/m,
};

export function candidateMetadataPaths(hasJava) {
  return [...(hasJava ? CANDIDATES.java : CANDIDATES.other)];
}

// 数字转字符串（146 → "146"），字符串原样保留（含 "157.1，" 这类脏值），缺失为 null
function toText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

// 修复字符串内未转义的换行。
// 实际 mod.hjson 里有 description 用普通引号却直接换行，严格 HJSON 会拒绝；
// 这里只把引号字符串里的裸换行转成 \n，其余内容原样保留。
export function repairQuotedNewlines(text) {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === "'" && text.startsWith("'''", index)) {
      const end = text.indexOf("'''", index + 3);
      const stop = end === -1 ? text.length : end + 3;
      output += text.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '"') {
      output += char;
      index += 1;
      while (index < text.length) {
        const inner = text[index];
        if (inner === '\\') {
          output += text.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (inner === '"') {
          output += inner;
          index += 1;
          break;
        }
        if (inner === '\n') {
          output += '\\n';
          index += 1;
          continue;
        }
        if (inner === '\r') {
          output += '\\r';
          index += 1;
          continue;
        }
        output += inner;
        index += 1;
      }
      continue;
    }

    if (char === '#' || (char === '/' && text[index + 1] === '/')) {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      output += text.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      output += text.slice(index, stop);
      index = stop;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

// 只捞 version / minGameVersion；两个都捞不到返回 null
export function extractModMetadataFields(text) {
  const result = {};
  for (const [field, pattern] of Object.entries(FALLBACK_PATTERNS)) {
    const match = text.match(pattern);
    const value = match ? match[1].trim() : '';
    if (value) {
      result[field] = value;
    }
  }
  if (result.version === undefined && result.minGameVersion === undefined) {
    return null;
  }
  return {
    modVersion: result.version ?? null,
    minGameVersion: result.minGameVersion ?? null,
  };
}

function fieldsFromParsed(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mod 元数据不是对象');
  }
  return {
    modVersion: toText(parsed.version),
    minGameVersion: toText(parsed.minGameVersion),
  };
}

export function parseModMetadata(text) {
  let lastError = null;
  try {
    return fieldsFromParsed(parseHjson(text));
  } catch (error) {
    lastError = error;
  }
  try {
    return fieldsFromParsed(parseHjson(repairQuotedNewlines(text)));
  } catch (error) {
    lastError = error;
  }
  // 严格解析与宽松修复都失败：正则兜底只取两个关键字段
  const fallback = extractModMetadataFields(text);
  if (fallback) {
    return fallback;
  }
  throw lastError ?? new Error('mod 元数据解析失败');
}

function scriptsOf(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return typeof value === 'string' && value.trim().length > 0;
}

// 社区模组发现需要完整字段：name/author/description/hideBrowser/scripts/main
export function parseModMetadataDocument(text) {
  let parsed;
  try {
    parsed = parseHjson(text);
  } catch {
    try {
      parsed = parseHjson(repairQuotedNewlines(text));
    } catch {
      parsed = null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const hasScripts = scriptsOf(parsed.scripts);
  const hasMain = typeof parsed.main === 'string' && parsed.main.trim().length > 0;
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  const author = typeof parsed.author === 'string' ? parsed.author.trim() : '';
  const description = typeof parsed.description === 'string' ? parsed.description : '';
  return {
    name: name || null,
    author: author || null,
    description,
    modVersion: toText(parsed.version),
    minGameVersion: toText(parsed.minGameVersion),
    hideBrowser: parsed.hideBrowser === true,
    hasScripts,
    // 与官方列表口径近似：有 main 且没有 scripts 视为 Java 模组
    hasJava: hasMain && !hasScripts,
  };
}

// 用默认分支读社区仓库的 mod 元数据（root 或 assets/ 的 mod.json / mod.hjson）
const COMMUNITY_CANDIDATES = ['mod.json', 'mod.hjson', 'assets/mod.json', 'assets/mod.hjson'];

export async function fetchCommunityModMetadata(client, { repo, ref }) {
  for (const filePath of COMMUNITY_CANDIDATES) {
    for (const url of rawFileUrlVariants(repo, ref, filePath)) {
      let response;
      try {
        response = await client.get(url);
      } catch {
        continue;
      }
      if (response.status === 404) {
        continue;
      }
      if (response.status !== 200) {
        return { found: false, reason: `http-${response.status}` };
      }
      const metadata = parseModMetadataDocument(response.text);
      if (metadata) {
        return { found: true, path: filePath, metadata };
      }
    }
  }
  return { found: false, reason: 'missing' };
}

function metadataResult(path, status, parsed = null) {
  return {
    metadataPath: path,
    metadataStatus: status,
    modVersion: parsed?.modVersion ?? null,
    minGameVersion: parsed?.minGameVersion ?? null,
  };
}

export async function fetchModMetadata(client, { repo, tag, hasJava }) {
  let failedPath = null;
  let transportFailed = false;
  for (const path of candidateMetadataPaths(hasJava)) {
    const urls = rawFileUrlVariants(repo, tag, path);
    for (const [variantIndex, url] of urls.entries()) {
      let response;
      try {
        response = await client.get(url);
      } catch {
        // 首选变形都失败才算网络问题；回退变形可能本身不是合法 URL（如原样 tag 带空格）
        if (variantIndex === 0) {
          transportFailed = true;
        }
        continue;
      }
      if (response.status === 404) {
        continue;
      }
      if (response.status !== 200) {
        return metadataResult(failedPath ?? null, 'unparsed');
      }
      try {
        return metadataResult(path, 'ok', parseModMetadata(response.text));
      } catch {
        // 命中的文件解析失败：记下路径继续试其它候选
        failedPath ??= path;
        break;
      }
    }
  }
  if (failedPath || transportFailed) {
    return metadataResult(failedPath ?? null, 'unparsed');
  }
  return metadataResult(null, 'missing');
}
