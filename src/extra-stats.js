// 额外统计（不进主列表）：按最新版本源码树统计语言支持与内容数量
// 产物：stats/<owner>/<repo>.json，可直接按 repo 路径额外获取

import path from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from './writer.js';

export const EXTRA_STATS_DIR = 'stats';
export const EXTRA_STATS_INDEX = 'stats/index.json';

const CONTENT_KINDS = ['blocks', 'items', 'liquids', 'units', 'statuses', 'sectors', 'planets'];

function bundleLanguageOf(fileName) {
  const match = /^bundle(?:_([A-Za-z0-9_-]+))?\.properties$/.exec(fileName);
  if (!match) return null;
  return (match[1] ?? 'en').replace('-', '_');
}

function countPropertiesKeys(text) {
  const keys = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const index = trimmed.indexOf('=');
    const key = (index >= 0 ? trimmed.slice(0, index) : trimmed).trim();
    if (key) keys.add(key);
  }
  return keys;
}

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

export function languageStatsFromBundles(bundles) {
  // bundles: [{ language, keys:Set }]
  const base = bundles.find((item) => item.language === 'en') ?? bundles[0] ?? null;
  if (!base) return { base: null, totalKeys: 0, languages: [] };
  const totalKeys = base.keys.size;
  return {
    base: base.language,
    totalKeys,
    languages: bundles
      .map((item) => ({
        language: item.language,
        keys: item.keys.size,
        rate: totalKeys > 0 ? round4(Math.min(1, item.keys.size / totalKeys)) : null,
      }))
      .sort((left, right) => left.language.localeCompare(right.language)),
  };
}

export function contentCountsFromTree(paths) {
  const counts = { blocks: 0, items: 0, liquids: 0, units: 0, statuses: 0, sectors: 0, planets: 0 };
  for (const filePath of Array.isArray(paths) ? paths : []) {
    const normalized = String(filePath ?? '').replace(/\\/g, '/').toLowerCase();
    if (!normalized.endsWith('.json')) continue;
    for (const kind of CONTENT_KINDS) {
      if (normalized.startsWith(`content/${kind}/`) || normalized.includes(`/content/${kind}/`)) {
        counts[kind] += 1;
      }
    }
  }
  return counts;
}

export function statsBodyChanged(previous, next) {
  return (
    JSON.stringify({ ...previous, generatedAt: '' }) !==
    JSON.stringify({ ...next, generatedAt: '' })
  );
}

async function listTree(apiClient, repo, ref) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const response = await apiClient.get(url);
  if (response.status !== 200) {
    throw new Error(`tree HTTP ${response.status}`);
  }
  const data = JSON.parse(response.text);
  return (Array.isArray(data.tree) ? data.tree : [])
    .filter((item) => item?.type === 'blob' && typeof item.path === 'string')
    .map((item) => item.path);
}

async function readRawText(rawClient, repo, ref, filePath) {
  const url =
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/` +
    filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const response = await rawClient.get(url);
  if (response.status !== 200) return null;
  return response.text;
}

export async function collectModStats({
  apiClient,
  rawClient,
  repo,
  ref,
  generatedAt,
}) {
  const tree = await listTree(apiClient, repo, ref);
  const bundlePaths = tree.filter((item) => {
    const name = item.split('/').pop() ?? '';
    return item.includes('bundles/') && bundleLanguageOf(name) !== null;
  });

  const bundles = [];
  for (const bundlePath of bundlePaths) {
    const language = bundleLanguageOf(bundlePath.split('/').pop() ?? '');
    if (!language) continue;
    const text = await readRawText(rawClient, repo, ref, bundlePath);
    if (text === null) continue;
    bundles.push({ language, keys: countPropertiesKeys(text) });
  }

  return {
    formatVersion: 1,
    repo,
    ref,
    generatedAt,
    languages: languageStatsFromBundles(bundles),
    content: contentCountsFromTree(tree),
  };
}

export function statsRelPath(repo) {
  return `${EXTRA_STATS_DIR}/${repo}.json`;
}

export async function writeModStats(outDir, repo, stats) {
  const relPath = statsRelPath(repo);
  const file = path.join(outDir, relPath);
  const previous = await readJsonIfExists(file).catch(() => null);
  if (previous && !statsBodyChanged(previous, stats)) {
    return false;
  }
  await writeJsonAtomic(file, stats);
  return true;
}
