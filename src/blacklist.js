// Anuken/MindustryMods 黑名单同步：每天从 ModUpdater.java 抽取三类黑名单，缓存到 state/blacklist.json

import { createHash } from 'node:crypto';
import { readJsonIfExists, writeJsonAtomic } from './writer.js';

export const MOD_UPDATER_URL =
  'https://raw.githubusercontent.com/Anuken/MindustryMods/master/src/modupdater/ModUpdater.java';
export const BLACKLIST_STATE_REL_PATH = 'state/blacklist.json';
const BLACKLIST_REFRESH_MS = 24 * 60 * 60 * 1000;

export function decodeBase64String(text) {
  return Buffer.from(String(text), 'base64').toString('utf8');
}

function extractQuotedStrings(block) {
  const values = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(block)) !== null) {
    const value = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
}

// 从 ModUpdater.java 源码抽取 nameBlacklist / blacklist / globalBlacklist；
// 任一部分缺失或 Base64 解码失败都返回 null（调用方沿用旧缓存并 warning）
export function parseModUpdaterSource(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const nameMatch = /nameBlacklist\s*=\s*Seq\.with\(([\s\S]*?)\)\s*;/.exec(text);
  const repoMatch = /(?<!name)blacklist\s*=\s*ObjectSet\.with\(([\s\S]*?)\)\s*;/.exec(text);
  const globalMatch =
    /globalBlacklist\s*=[\s\S]*?Base64Coder\.decodeString\(\s*"([^"]+)"\s*\)/.exec(text) ??
    /decodeString\(\s*"([^"]+)"\s*\)/.exec(text);
  if (!nameMatch || !repoMatch || !globalMatch) {
    return null;
  }
  const nameBlacklist = extractQuotedStrings(nameMatch[1]).map((value) => value.toLowerCase());
  const blacklist = extractQuotedStrings(repoMatch[1]).map((value) => value.toLowerCase());
  let globalSource;
  try {
    globalSource = decodeBase64String(globalMatch[1]).trim();
  } catch {
    return null;
  }
  if (!globalSource) {
    return null;
  }
  try {
    // 先验证正则可编译，避免坏数据在运行时炸掉
    new RegExp(globalSource, 'i');
  } catch {
    return null;
  }
  return {
    nameBlacklist,
    blacklist,
    globalBlacklist: { source: globalSource, flags: 'i' },
  };
}

export function sourceHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function buildBlacklistState({ parsed, hash, fetchedAt, sourceUrl = MOD_UPDATER_URL }) {
  return {
    formatVersion: 1,
    fetchedAt,
    sourceUrl,
    sourceHash: hash,
    nameBlacklist: parsed.nameBlacklist,
    blacklist: parsed.blacklist,
    globalBlacklist: parsed.globalBlacklist,
  };
}

export function normalizeBlacklistState(raw) {
  if (!raw || typeof raw !== 'object' || raw.formatVersion !== 1) {
    return null;
  }
  const nameBlacklist = Array.isArray(raw.nameBlacklist)
    ? raw.nameBlacklist.filter((item) => typeof item === 'string')
    : [];
  const blacklist = Array.isArray(raw.blacklist)
    ? raw.blacklist.filter((item) => typeof item === 'string')
    : [];
  const source =
    raw.globalBlacklist && typeof raw.globalBlacklist.source === 'string'
      ? raw.globalBlacklist.source
      : null;
  if (!source) {
    return null;
  }
  try {
    new RegExp(source, 'i');
  } catch {
    return null;
  }
  return {
    formatVersion: 1,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : MOD_UPDATER_URL,
    sourceHash: typeof raw.sourceHash === 'string' ? raw.sourceHash : null,
    nameBlacklist,
    blacklist,
    globalBlacklist: { source, flags: 'i' },
  };
}

export function blacklistIsStale(state, now = Date.now()) {
  if (!state?.fetchedAt) {
    return true;
  }
  const time = Date.parse(state.fetchedAt);
  return Number.isNaN(time) || now - time >= BLACKLIST_REFRESH_MS;
}

// repo 的 full_name 前缀匹配 / 精确匹配 / 名称与描述正则
export function isBlacklisted({ repo, name = '', description = '' }, blacklist) {
  if (!blacklist) {
    return false;
  }
  const fullName = String(repo ?? '').toLowerCase();
  if (blacklist.nameBlacklist.some((prefix) => fullName.startsWith(prefix))) {
    return true;
  }
  if (blacklist.blacklist.includes(fullName)) {
    return true;
  }
  const text = `${name ?? ''} ${description ?? ''}`;
  try {
    return new RegExp(blacklist.globalBlacklist.source, 'i').test(text);
  } catch {
    return false;
  }
}

// 每天刷新一次；源不可用/格式变化时沿用缓存 + warning，不阻断运行
export async function loadBlacklist({ rawClient, outDir, log = () => {}, now = Date.now() }) {
  const cacheFile = `${outDir}/${BLACKLIST_STATE_REL_PATH}`;
  let cached = null;
  try {
    cached = normalizeBlacklistState(await readJsonIfExists(cacheFile));
  } catch (error) {
    log(`[警告] ${BLACKLIST_STATE_REL_PATH} 不可用：${error.message}`);
  }
  if (cached && !blacklistIsStale(cached, now)) {
    return { blacklist: cached, changed: false, source: 'cache' };
  }

  try {
    const response = await rawClient.get(MOD_UPDATER_URL);
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = parseModUpdaterSource(response.text);
    if (!parsed) {
      throw new Error('无法从 ModUpdater.java 解析黑名单（源码格式可能变化）');
    }
    const hash = sourceHash(response.text);
    const next = buildBlacklistState({
      parsed,
      hash,
      fetchedAt: new Date(now).toISOString(),
    });
    const changed = !cached || cached.sourceHash !== hash;
    await writeJsonAtomic(cacheFile, next);
    if (changed) {
      log(
        `[blacklist] 已同步 Anuken 黑名单：nameBlacklist ${next.nameBlacklist.length} 条、blacklist ${next.blacklist.length} 条、globalBlacklist /${next.globalBlacklist.source}/`,
      );
    }
    return { blacklist: next, changed, source: 'remote' };
  } catch (error) {
    if (cached) {
      log(`[警告] 黑名单同步失败（${error.message}），沿用 ${cached.fetchedAt} 的缓存`);
      return { blacklist: cached, changed: false, source: 'stale-cache' };
    }
    log(`[警告] 黑名单同步失败且没有缓存（${error.message}），本次不应用黑名单`);
    return {
      blacklist: { formatVersion: 1, nameBlacklist: [], blacklist: [], globalBlacklist: { source: '(?!)', flags: 'i' } },
      changed: false,
      source: 'empty',
    };
  }
}
