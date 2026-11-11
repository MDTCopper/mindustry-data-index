// 依赖跟踪：把官方+社区 index 里的 internalName ↔ 依赖 id 建成一张全局有向图，
// 并列出找不到的依赖，供启动器安装前解析/提示。

import path from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from './writer.js';

export const DEPENDENCIES_REL_PATH = 'dependencies.json';

function normalizeId(value) {
  return String(value ?? '').trim().toLowerCase();
}

function aliasKey(value) {
  return normalizeId(value).replace(/[^a-z0-9]+/g, '');
}

export function buildDependencyIndex({ official, community, now }) {
  const mods = {};
  const aliases = {};
  const entries = [];
  for (const [source, index] of [
    ['official', official],
    ['community', community],
  ]) {
    for (const mod of Array.isArray(index?.mods) ? index.mods : []) {
      const id = normalizeId(mod?.internalName);
      if (!id) continue;
      const node = {
        repo: mod.repo,
        source,
        name: mod.name ?? null,
        version: mod.version ?? null,
        dependencies: Array.isArray(mod.dependencies)
          ? [...new Set(mod.dependencies.map(normalizeId).filter(Boolean))]
          : [],
      };
      mods[id] = node;
      aliases[aliasKey(id)] ??= id;
      entries.push([id, node]);
    }
  }

  const reverse = {};
  const missing = [];
  for (const [id, node] of entries) {
    for (const rawDependency of node.dependencies) {
      const dependency = aliases[aliasKey(rawDependency)] ?? rawDependency;
      if (!reverse[dependency]) reverse[dependency] = [];
      reverse[dependency].push(id);
      if (!mods[dependency] && !aliases[aliasKey(dependency)]) {
        missing.push({ id, repo: node.repo, source: node.source, dependency });
      }
    }
  }

  return {
    formatVersion: 1,
    generatedAt: now,
    mods,
    aliases,
    reverse,
    missing,
  };
}

export async function writeDependencyIndex(outDir, { now, log = () => {} }) {
  const official = await readJsonIfExists(
    path.join(outDir, 'index-full.json'),
  ).catch(() => null);
  const community = await readJsonIfExists(
    path.join(outDir, 'community/index-full.json'),
  ).catch(() => null);
  if (!official && !community) return false;
  const next = buildDependencyIndex({ official, community, now });
  const file = path.join(outDir, DEPENDENCIES_REL_PATH);
  const previous = await readJsonIfExists(file).catch(() => null);
  if (
    previous &&
    JSON.stringify({ ...previous, generatedAt: '' }) ===
      JSON.stringify({ ...next, generatedAt: '' })
  ) {
    return false;
  }
  await writeJsonAtomic(file, next);
  log(
    `[deps] ${Object.keys(next.mods).length} 个模组，${next.missing.length} 条缺失依赖`,
  );
  return true;
}
