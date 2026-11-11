// 一次性/按需回填：重新读每个模组最新 tag 的元数据，修正 per-mod meta 与 index 的依赖字段。
// 用于历史数据在解析器升级前的旧 meta（dependencies 被丢成 {}）。

import path from 'node:path';

import { writeDependencyIndex } from './dependencies.js';
import {
  dependencyInfo,
  fetchModMetadataDocument,
  metaFromDocument,
} from './mod-meta.js';
import { readJsonIfExists, writeJsonAtomic } from './writer.js';

const INDEX_FILES = [
  { full: 'index-full.json', defaults: ['index.json'] },
  { full: 'community/index-full.json', defaults: ['community/index.json'] },
];

function latestTagOf(file) {
  const versions = Array.isArray(file?.versions) ? file.versions : [];
  return versions.find((item) => item?.removed !== true)?.tag ?? null;
}

function applyDependencies(entry, meta) {
  const dependency = dependencyInfo(meta?.dependencies);
  if (dependency.ids.length > 0) {
    entry.dependencies = dependency.ids;
  } else {
    delete entry.dependencies;
  }
  if (dependency.mindustry) {
    entry.mindustryDependency = dependency.mindustry;
  } else {
    delete entry.mindustryDependency;
  }
}

export async function backfillMeta({
  rawClient,
  outDir,
  log = () => {},
  limit = null,
  concurrency = 12,
}) {
  const tasks = [];
  const indexes = [];
  for (const spec of INDEX_FILES) {
    const full = await readJsonIfExists(path.join(outDir, spec.full)).catch(() => null);
    if (!full) continue;
    indexes.push({ spec, full });
    for (const mod of Array.isArray(full.mods) ? full.mods : []) {
      if (typeof mod?.repo === 'string' && typeof mod.releasesPath === 'string') {
        tasks.push({ mod, spec });
      }
    }
  }
  const selected = limit === null ? tasks : tasks.slice(0, limit);
  const byRepo = new Map();
  for (const { full } of indexes) {
    for (const mod of full.mods ?? []) {
      byRepo.set(mod.repo, mod);
    }
  }
  const metaByRepo = new Map();

  let updated = 0;
  let withDeps = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < selected.length) {
      const task = selected[cursor];
      cursor += 1;
      const { mod } = task;
      try {
        const filePath = path.join(outDir, mod.releasesPath);
        const file = await readJsonIfExists(filePath);
        const tag = latestTagOf(file);
        if (!tag) continue;
        const result = await fetchModMetadataDocument(rawClient, {
          repo: mod.repo,
          tag,
          hasJava: mod.modType === 'java',
        });
        if (!result.found || !result.meta) {
          failed += 1;
          continue;
        }
        file.meta = metaFromDocument(result.meta);
        await writeJsonAtomic(filePath, file);
        metaByRepo.set(mod.repo, result.meta);
        const entry = byRepo.get(mod.repo);
        if (entry) applyDependencies(entry, result.meta);
        applyDependencies(mod, result.meta);
        updated += 1;
        if (dependencyInfo(result.meta.dependencies).ids.length > 0) withDeps += 1;
      } catch (error) {
        failed += 1;
        log(`[meta] ${mod.repo} 回填失败：${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // 同步回 index（full 与默认列表里同一 repo 的条目）
  for (const { spec, full } of indexes) {
    const entries = Array.isArray(full.mods) ? full.mods : [];
    for (const mod of entries) {
      const meta = metaByRepo.get(mod.repo);
      if (meta) applyDependencies(mod, meta);
    }
    await writeJsonAtomic(path.join(outDir, spec.full), full);
    for (const defaultRel of spec.defaults) {
      const defaults = await readJsonIfExists(path.join(outDir, defaultRel)).catch(() => null);
      if (!defaults || !Array.isArray(defaults.mods)) continue;
      for (const mod of defaults.mods) {
        const meta = metaByRepo.get(mod.repo);
        if (meta) applyDependencies(mod, meta);
      }
      await writeJsonAtomic(path.join(outDir, defaultRel), defaults);
    }
  }
  const now = new Date().toISOString();
  await writeDependencyIndex(outDir, { now, log });
  log(`[meta] 更新 ${updated} 个模组元数据，${withDeps} 个有依赖，失败 ${failed} 个`);
  return { code: 0, stats: { updated, withDeps, failed } };
}
