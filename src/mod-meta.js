// 按游戏源码顺序读 root 的 mod.json/mod.hjson/plugin.*，解析 v3 元数据
// 解析器按 Arc Jval/Hparser 语义（Hjson 超集），不使用严格 HJSON 库。

import { rawFileUrlVariants } from './releases.js';
import { parseJval } from './jval.js';

// 游戏 Mods.metaFiles 顺序；只查 root（不读 assets/）
const ROOT_METADATA_FILES = ['mod.json', 'mod.hjson', 'plugin.json', 'plugin.hjson'];

// 解析彻底失败时的正则兜底：只捞需要的两个字段（两种扩展名里都可能是 HJSON 语法）
const FALLBACK_PATTERNS = {
  version: /(?:^|[\s,{])version\s*:\s*["']?([^"'\n,}]+)/m,
  minGameVersion: /(?:^|[\s,{])minGameVersion\s*:\s*["']?([^"'\n,}]+)/m,
};

export function candidateMetadataPaths(_hasJava) {
  return [...ROOT_METADATA_FILES];
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
  return fieldsFromParsed(parseJval(text));
}

function scriptsOf(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return typeof value === 'string' && value.trim().length > 0;
}

// 社区模组发现需要完整字段：name/author/description/hideBrowser/main
export function parseModMetadataDocument(text) {
  let parsed;
  try {
    parsed = parseJval(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const hasScripts = parsed.scriptsRoot === true;
  const main = typeof parsed.main === 'string' && parsed.main.trim().length > 0 ? parsed.main.trim() : null;
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  // 游戏：缺 name 直接跳过该 mod
  if (!name) {
    return null;
  }
  const author = typeof parsed.author === 'string' ? parsed.author.trim() : '';
  const description = typeof parsed.description === 'string' ? parsed.description : '';
  return {
    name: name || null,
    author: author || null,
    description,
    modVersion: toText(parsed.version),
    // 数组/对象等游戏不支持的类型视为缺省（Jval 绑定 String 得 null → "0"）
    minGameVersion: toText(parsed.minGameVersion),
    hideBrowser: parsed.hideBrowser === true,
    hidden: parsed.hidden === true,
    legacyCompatible: parsed.legacyCompatible === true,
    main,
    java: parsed.java === true,
    scriptsRoot: hasScripts,
    java: parsed.java === true,
    dependencies:
      parsed.dependencies !== null &&
      typeof parsed.dependencies === 'object' &&
      !Array.isArray(parsed.dependencies)
        ? parsed.dependencies
        : {},
    hasScripts,
    hasJava: parsed.java === true || main !== null,
  };
}

// per-mod 文件里的 meta：保留客户端/索引需要的完整字段（v3 从元数据推导 mod 信息）
export function metaFromDocument(metadata) {
  if (!metadata) {
    return null;
  }
  return {
    name: metadata.name ?? null,
    author: metadata.author ?? null,
    description: metadata.description ?? '',
    version: metadata.modVersion ?? null,
    minGameVersion: metadata.minGameVersion ?? null,
    dependencies: metadata.dependencies ?? {},
    hidden: metadata.hidden === true,
    legacyCompatible: metadata.legacyCompatible === true,
    main: typeof metadata.main === 'string' ? metadata.main : null,
    java: metadata.java === true,
    hasScripts: metadata.hasScripts === true,
    hasJava: metadata.hasJava === true,
  };
}

async function detectRootScripts(client, repo, ref) {
  for (const filePath of ['scripts/main.js']) {
    for (const url of rawFileUrlVariants(repo, ref, filePath)) {
      try {
        const response = await client.get(url);
        if (response.status === 200) return true;
        if (response.status !== 404) break;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

// 社区模组发现候选：游戏同款 root 顺序（不读 assets）
const COMMUNITY_CANDIDATES = [...ROOT_METADATA_FILES];

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
        const scripts = await detectRootScripts(client, repo, ref);
        metadata.hasScripts = scripts;
        metadata.scriptsRoot = scripts;
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
        const document = parseModMetadataDocument(response.text);
        if (!document) throw new Error('元数据缺少 name');
        return metadataResult(path, 'ok', {
          modVersion: document.modVersion,
          minGameVersion: document.minGameVersion,
        });
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

// 读取完整 mod 元数据文档（dependencies/hidden/legacyCompatible/main/scripts），供 per-mod meta 用
export async function fetchModMetadataDocument(client, { repo, tag, hasJava }) {
  let failedPath = null;
  let transportFailed = false;
  for (const path of candidateMetadataPaths(hasJava)) {
    const urls = rawFileUrlVariants(repo, tag, path);
    for (const [variantIndex, url] of urls.entries()) {
      let response;
      try {
        response = await client.get(url);
      } catch {
        if (variantIndex === 0) {
          transportFailed = true;
        }
        continue;
      }
      if (response.status === 404) {
        continue;
      }
      if (response.status !== 200) {
        return { found: false, path: failedPath ?? null, status: 'unparsed', meta: null };
      }
      const metadata = parseModMetadataDocument(response.text);
      if (metadata) {
        metadata.hasScripts = await detectRootScripts(client, repo, tag);
        metadata.scriptsRoot = metadata.hasScripts;
        return {
          found: true,
          path,
          status: 'ok',
          metadata,
          meta: metaFromDocument(metadata),
        };
      }
      failedPath ??= path;
      break;
    }
  }
  if (failedPath || transportFailed) {
    return { found: false, path: failedPath ?? null, status: 'unparsed', meta: null };
  }
  return { found: false, path: null, status: 'missing', meta: null };
}
