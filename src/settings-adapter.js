// 自动生成启动器 setting adapter：跟随最新 Mindustry 版本，输出完整设置表 + 名称/描述译文。
// 不再按 build 区间做 base/changes；表就是最新版本本身，版本更新时再生成一次 diff。

import fs from 'node:fs/promises';
import path from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from './writer.js';

export const SETTING_ADAPTER_DIR = 'mindustry/setting-adapter';
export const SETTING_ADAPTER_INDEX_REL_PATH = 'mindustry/setting-adapter/index.json';
export const SETTING_ADAPTER_CURRENT_REL_PATH = 'mindustry/setting-adapter/current.json';
export const SETTING_ADAPTER_CHANGES_REL_PATH = 'mindustry/setting-adapter/changes.json';
export const SETTING_ADAPTER_LEGACY_REL_PATH = 'mindustry/setting-adapter/136-999999.json';

const SOURCE_PATH = 'core/src/mindustry/ui/dialogs/SettingsMenuDialog.java';
const BUNDLE_EN_PATH = 'core/assets/bundles/bundle.properties';
const BUNDLE_ZH_PATH = 'core/assets/bundles/bundle_zh_CN.properties';

const TABLE_CATEGORY = {
  game: 'game',
  graphics: 'graphics',
  sound: 'sound',
  dev: 'system',
  main: 'common',
};

function unescapeProperties(text) {
  return String(text ?? '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseBundleProperties(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    map.set(trimmed.slice(0, eq).trim(), unescapeProperties(trimmed.slice(eq + 1).trim()));
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

// 从最新版本源码提取完整表；name/description 同时带 en 与 zh_CN 译文
export function extractSettingTable(source, { bundleEn = '', bundleZh = '' } = {}) {
  const clean = stripJavaComments(source);
  const scoped = methodBody(clean, 'void addSettings') ?? clean;
  const en = parseBundleProperties(bundleEn);
  const zh = parseBundleProperties(bundleZh);
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

    const spec = {
      key,
      name: {
        en: en.get(`setting.${key}.name`) ?? key,
        zh_CN: zh.get(`setting.${key}.name`) ?? null,
      },
      description: {
        en: en.get(`setting.${key}.description`) ?? '',
        zh_CN: zh.get(`setting.${key}.description`) ?? '',
      },
      type: 'bool',
      categories: [TABLE_CATEGORY[table] ?? 'game'],
    };

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

export function buildSettingTable({ version, build, specs, now }) {
  return {
    formatVersion: 1,
    update_time: now,
    version,
    build,
    settings: specs,
  };
}

export function diffSettingTables(previous, next, { fromVersion, toVersion, build, now }) {
  const previousByKey = new Map((previous?.settings ?? []).map((spec) => [spec.key, spec]));
  const nextByKey = new Map((next?.settings ?? []).map((spec) => [spec.key, spec]));
  const add = [];
  const changed = [];
  const remove = [];
  for (const [key, spec] of nextByKey) {
    const old = previousByKey.get(key);
    if (!old) add.push(spec);
    else if (JSON.stringify(old) !== JSON.stringify(spec)) changed.push(spec);
  }
  for (const key of previousByKey.keys()) {
    if (!nextByKey.has(key)) remove.push(key);
  }
  return {
    formatVersion: 1,
    update_time: now,
    from_version: fromVersion ?? null,
    to_version: toVersion,
    build,
    add,
    changed,
    remove,
  };
}

function latestVersionInfo(versions) {
  for (const release of Array.isArray(versions) ? versions : []) {
    const tag = String(release?.tag_name ?? '');
    const match = /^v(\d+)/.exec(tag);
    if (!match) continue;
    return { tag, build: Number(match[1]) };
  }
  return null;
}

async function fetchText(rawClient, repo, tag, filePath) {
  const response = await rawClient.get(
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/${filePath}`,
  );
  return response.status === 200 ? response.text : null;
}

export async function buildLatestSettingAdapter({ rawClient, versions, now }) {
  const latest = latestVersionInfo(versions);
  if (!latest) return null;
  const source = await fetchText(rawClient, 'Anuken/Mindustry', latest.tag, SOURCE_PATH);
  if (source === null) return null;
  const bundleEn = await fetchText(rawClient, 'Anuken/Mindustry', latest.tag, BUNDLE_EN_PATH);
  const bundleZh = await fetchText(rawClient, 'Anuken/Mindustry', latest.tag, BUNDLE_ZH_PATH);
  const specs = extractSettingTable(source, {
    bundleEn: bundleEn ?? '',
    bundleZh: bundleZh ?? '',
  });
  if (specs.length === 0) return null;
  return {
    version: latest.tag,
    build: latest.build,
    table: buildSettingTable({
      version: latest.tag,
      build: latest.build,
      specs,
      now,
    }),
  };
}

function bodyChanged(previous, next) {
  return (
    JSON.stringify({ ...previous, update_time: '' }) !==
    JSON.stringify({ ...next, update_time: '' })
  );
}

export async function writeLatestSettingAdapter(outDir, { table, now }) {
  const currentPath = path.join(outDir, SETTING_ADAPTER_CURRENT_REL_PATH);
  const indexPath = path.join(outDir, SETTING_ADAPTER_INDEX_REL_PATH);
  const changesPath = path.join(outDir, SETTING_ADAPTER_CHANGES_REL_PATH);
  const previousTable = await readJsonIfExists(currentPath).catch(() => null);
  let changed = false;

  if (!previousTable || bodyChanged(previousTable, table)) {
    await writeJsonAtomic(currentPath, table);
    changed = true;
  }

  const index = {
    formatVersion: 1,
    update_time: now,
    version: table.version,
    build: table.build,
    file: 'current.json',
    changes: 'changes.json',
    setting_count: table.settings.length,
  };
  const previousIndex = await readJsonIfExists(indexPath).catch(() => null);
  if (!previousIndex || bodyChanged(previousIndex, index)) {
    await writeJsonAtomic(indexPath, index);
    changed = true;
  }

  const previousChanges = await readJsonIfExists(changesPath).catch(() => null);
  const entries = Array.isArray(previousChanges?.entries) ? [...previousChanges.entries] : [];
  if (previousTable && bodyChanged(previousTable, table)) {
    entries.unshift(
      diffSettingTables(previousTable, table, {
        fromVersion: previousTable.version,
        toVersion: table.version,
        build: table.build,
        now,
      }),
    );
  }
  const changesFile = {
    formatVersion: 1,
    update_time: now,
    entries: entries.slice(0, 50),
  };
  if (
    !previousChanges ||
    JSON.stringify({ ...previousChanges, update_time: '' }) !==
      JSON.stringify({ ...changesFile, update_time: '' })
  ) {
    await writeJsonAtomic(changesPath, changesFile);
    changed = true;
  }

  // 不再保留旧的按 build 区间文件
  await fs.rm(path.join(outDir, SETTING_ADAPTER_LEGACY_REL_PATH), { force: true }).catch(() => {});
  return changed;
}
