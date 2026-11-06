// 按 tag 读 mod.hjson / mod.json，解析 version 与 minGameVersion

import { parse as parseHjson } from 'hjson';
import { rawFileUrl } from './releases.js';

// 候选顺序：root hjson → root json → assets hjson → assets json；
// hasJava 时 hjson 优先，否则 json 优先（两种都试）
const CANDIDATES = {
  java: ['mod.hjson', 'mod.json', 'assets/mod.hjson', 'assets/mod.json'],
  other: ['mod.json', 'mod.hjson', 'assets/mod.json', 'assets/mod.hjson'],
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

export function parseModMetadata(text) {
  let parsed;
  try {
    parsed = parseHjson(text);
  } catch {
    // 严格解析失败时先修掉字符串内裸换行再试一次；仍失败就当作解析失败
    parsed = parseHjson(repairQuotedNewlines(text));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mod 元数据不是对象');
  }
  return {
    modVersion: toText(parsed.version),
    minGameVersion: toText(parsed.minGameVersion),
  };
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
  for (const path of candidateMetadataPaths(hasJava)) {
    let response;
    try {
      response = await client.get(rawFileUrl(repo, tag, path));
    } catch {
      // 请求层失败按 unparsed 记，下次更新会重试
      return metadataResult(failedPath ?? null, 'unparsed');
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
    }
  }
  if (failedPath) {
    return metadataResult(failedPath, 'unparsed');
  }
  return metadataResult(null, 'missing');
}
