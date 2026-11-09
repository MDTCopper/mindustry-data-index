// 自动生成启动器 setting adapter：从各版本 SettingsMenuDialog.java + 中文 bundle 提取设置项，
// 输出与 launcher remote/setting_adapter 相同的 base + 逐版本 changes 格式。

import path from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from './writer.js';

export const SETTING_ADAPTER_DIR = 'mindustry/setting-adapter';
export const SETTING_ADAPTER_INDEX_REL_PATH =
  'mindustry/setting-adapter/index.json';
export const SETTING_ADAPTER_FILE_REL_PATH =
  'mindustry/setting-adapter/136-999999.json';
export const SETTING_ADAPTER_MIN_BUILD = 136;
export const SETTING_ADAPTER_MAX_BUILD = 999999;

const SOURCE_PATH = 'core/src/mindustry/ui/dialogs/SettingsMenuDialog.java';
const BUNDLE_PATH = 'core/assets/bundles/bundle_zh_CN.properties';

const TABLE_CATEGORY = {
  game: 'game',
  graphics: 'graphics',
  sound: 'sound',
  dev: 'system',
  main: 'common',
};

function parseBundleProperties(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

// 只接受源码里常见的整数常量表达式（数字、+ - * /、括号、空白）
export function evalConstantNumber(expression) {
  const text = String(expression ?? '').trim();
  if (!/^[\d\s+\-*/()]+$/.test(text)) return null;
  try {
    const value = Function(`"use strict"; return (${text});`)();
    return Number.isFinite(value) ? Math.round(value) : null;
  } catch {
    return null;
  }
}

function extractBalancedArguments(source, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex + 1, index);
    }
  }
  return null;
}

function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = '';
  for (const char of text) {
    if (inString) {
      current += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      current += char;
    } else if (char === '(' || char === '{' || char === '[') {
      depth += 1;
      current += char;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      current += char;
    } else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function firstString(argument) {
  const match = /^"([^"]*)"/.exec(argument ?? '');
  return match ? match[1] : null;
}

function stripJavaComments(source) {
  let output = '';
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  const brace = source.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, index);
    }
  }
  return null;
}

export function extractSettingSpecs(source, bundleText) {
  const clean = stripJavaComments(source);
  const scoped = methodBody(clean, 'void addSettings') ?? clean;
  const bundle = parseBundleProperties(bundleText);
  const specs = new Map();
  const pattern = /\b(game|graphics|sound|dev|main)\.(checkPref|sliderPref|textPref|areaTextPref)\s*\(/g;
  let match;
  while ((match = pattern.exec(scoped)) !== null) {
    const table = match[1];
    const method = match[2];
    const argsText = extractBalancedArguments(scoped, match.index + match[0].length - 1);
    if (argsText === null) continue;
    const args = splitArguments(argsText);
    const key = firstString(args[0]);
    if (!key) continue;
    if (method === 'textPref' || method === 'areaTextPref') continue;

    const title = bundle.get(`setting.${key}.name`) ?? key;
    const categories = [TABLE_CATEGORY[table] ?? 'game'];
    const spec = { key, title, type: 'bool', categories };

    if (method === 'sliderPref') {
      spec.type = 'int';
      spec.min = evalConstantNumber(args[2]) ?? 0;
      spec.max = evalConstantNumber(args[3]) ?? 100;
      const step = args.length >= 5 ? evalConstantNumber(args[4]) : 1;
      spec.step = step !== null && step > 0 ? step : 1;
      const format = args[args.length - 1] ?? '';
      if (format.includes('"%"') || format.includes("'%'")) spec.unit = '%';
      else if (/"px"/.test(format)) spec.unit = 'px';
    }
    specs.set(key, spec);
  }
  return [...specs.values()];
}

function specSignature(spec) {
  return JSON.stringify(spec);
}

export function buildAdapterFile({ versions, extractedByBuild, now }) {
  const entries = [...extractedByBuild.entries()].sort((left, right) => left[0] - right[0]);
  if (entries.length === 0) return null;
  const baseBuild = entries[0][0];
  const baseSpecs = entries[0][1];
  const changes = [];
  let previous = new Map(baseSpecs.map((spec) => [spec.key, spec]));
  for (const [build, specs] of entries.slice(1)) {
    const current = new Map(specs.map((spec) => [spec.key, spec]));
    const add = [];
    const remove = [];
    for (const [key, spec] of current) {
      const old = previous.get(key);
      if (!old || specSignature(old) !== specSignature(spec)) add.push(spec);
    }
    for (const key of previous.keys()) {
      if (!current.has(key)) remove.push(key);
    }
    if (add.length > 0 || remove.length > 0) {
      changes.push({ build, ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) });
    }
    previous = current;
  }
  return {
    update_time: now,
    min_build: baseBuild,
    max_build: SETTING_ADAPTER_MAX_BUILD,
    base_build: baseBuild,
    base: baseSpecs,
    changes,
  };
}

function versionsAtLeast136(versions) {
  const byBuild = new Map();
  for (const version of versions) {
    const tag = String(version?.tag_name ?? '');
    const match = /^v(\d+)/.exec(tag);
    if (!match) continue;
    const build = Number(match[1]);
    if (build < SETTING_ADAPTER_MIN_BUILD) continue;
    byBuild.set(build, tag);
  }
  return [...byBuild.entries()].sort((left, right) => left[0] - right[0]);
}

async function fetchText(rawClient, repo, tag, filePath) {
  const response = await rawClient.get(
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/${filePath}`,
  );
  return response.status === 200 ? response.text : null;
}

export async function buildSettingAdapter({
  rawClient,
  versions,
  now,
}) {
  const extractedByBuild = new Map();
  for (const [build, tag] of versionsAtLeast136(versions)) {
    const source = await fetchText(rawClient, 'Anuken/Mindustry', tag, SOURCE_PATH);
    if (source === null) continue;
    const bundle = await fetchText(rawClient, 'Anuken/Mindustry', tag, BUNDLE_PATH);
    const specs = extractSettingSpecs(source, bundle ?? '');
    if (specs.length > 0) extractedByBuild.set(build, specs);
  }
  const file = buildAdapterFile({ versions, extractedByBuild, now });
  if (!file) return null;
  return {
    index: {
      update_time: now,
      rules: [
        {
          min_build: file.min_build,
          max_build: file.max_build,
          file: '136-999999.json',
        },
      ],
    },
    file,
  };
}

export async function writeSettingAdapter(outDir, { index, file }) {
  const indexFile = path.join(outDir, SETTING_ADAPTER_INDEX_REL_PATH);
  const adapterFile = path.join(outDir, SETTING_ADAPTER_FILE_REL_PATH);
  const previousIndex = await readJsonIfExists(indexFile).catch(() => null);
  const previousFile = await readJsonIfExists(adapterFile).catch(() => null);
  let changed = false;
  if (
    !previousIndex ||
    JSON.stringify({ ...previousIndex, update_time: '' }) !==
      JSON.stringify({ ...index, update_time: '' })
  ) {
    await writeJsonAtomic(indexFile, index);
    changed = true;
  }
  if (
    !previousFile ||
    JSON.stringify({ ...previousFile, update_time: '' }) !==
      JSON.stringify({ ...file, update_time: '' })
  ) {
    await writeJsonAtomic(adapterFile, file);
    changed = true;
  }
  return changed;
}
