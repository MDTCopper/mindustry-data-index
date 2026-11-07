// schemaVersion 迁移：formatVersion 1 → 2
//
// v1：没有 compat / meta / commitSha / 删除留档 / 纯文本字段
// v2：per-mod 文件带 compat、meta、commitSha/archiveByCommitUrl，index 带 removedCount 等
//
// 正常情况下每个模组轮到自己时由 processMod 本地迁移（不额外发 API）；--migrate 可以一次性
// 把现有克隆里的全部旧文件、index、summary、status、changes 补到 v2（0 API）。

import path from 'node:path';
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from './writer.js';
import { RELEASES_FORMAT_VERSION, buildReleasesFile, archiveByCommitUrl, isReleaseEntry } from './releases.js';
import { buildCompat, gameVersionsFromFile, latestCompatibleTag } from './compat.js';
import { plainFields } from './plain.js';
import { buildSummary, summaryBodyChanged, summaryCsv } from './summary.js';
import { summarizeVersions } from './model-v3.js';
import { STATUS_REL_PATH, DATASET_KEYS, buildStatus } from './status.js';
import { CHANGES_REL_PATH, MAX_CHANGES, mergeChanges } from './changes.js';
import { normalizeRefreshState } from './refresh-state.js';
import { VERSIONS_REL_PATH } from './versions.js';
import { GATE_REL_PATHS } from './mod-gate.js';
import { REFRESH_STATE_REL_PATH } from './refresh-state.js';

export const CURRENT_FORMAT_VERSION = RELEASES_FORMAT_VERSION;

export function needsMigration(file) {
  if (!file || typeof file !== 'object') {
    return true;
  }
  return (
    file.formatVersion !== CURRENT_FORMAT_VERSION ||
    !Array.isArray(file.versions) ||
    !['java', 'js', 'json'].includes(file.modType)
  );
}

// 键顺序无关的深比较（迁移可能按不同字段顺序重建对象，不能因此判为变化）
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// 用已有缓存数据本地重算 v2 per-mod 文件（不访问网络）
export function migrateReleaseFileData({ repo, previous, compatData, now, hasJava }) {
  const entries = (Array.isArray(previous?.releases) ? previous.releases : []).map((entry) => {
    const sha =
      typeof entry?.commitSha === 'string' && entry.commitSha ? entry.commitSha : null;
    return {
      ...entry,
      commitSha: sha,
      archiveByCommitUrl: archiveByCommitUrl(repo, sha),
    };
  });
  const meta = previous?.meta && typeof previous.meta === 'object' ? previous.meta : null;
  const effectiveHasJava = meta ? meta.hasJava === true : hasJava === true;
  const compat = compatData
    ? buildCompat({
        entries,
        gameVersions: compatData.gameVersions,
        gateFile: effectiveHasJava ? compatData.javaGate : compatData.modGate,
      })
    : [];
  return buildReleasesFile({
    repo,
    releases: entries,
    meta,
    generatedAt: now,
    modType: effectiveHasJava ? 'java' : 'json',
    gameVersions: compatData?.gameVersions ?? [],
    gateFile: effectiveHasJava ? compatData?.javaGate : compatData?.modGate,
  });
}

function plainForEntry(entry) {
  return plainFields({
    name: entry.name,
    author: entry.author,
    description: entry.description,
  });
}

// 把旧 index 条目补到 v2 字段（不改变统计，统计等下一次抓取时校正）
export function migrateIndexEntry(entry, file, { gameVersions = [], community = false } = {}) {
  const meta = file?.meta && typeof file.meta === 'object' ? file.meta : null;
  const modType = file?.modType ?? (meta?.hasJava ? 'java' : 'json');
  const versions = Array.isArray(file?.versions) ? file.versions : [];
  const summary = summarizeVersions(versions);
  const plain = plainForEntry(
    meta
      ? { name: meta.name ?? entry.name, author: meta.author ?? entry.author, description: meta.description ?? '' }
      : entry,
  );
  const latest = versions.find((version) => version.removed !== true) ?? versions[0] ?? null;
  const result = {
    repo: entry.repo,
    ...(entry.internalName ? { internalName: entry.internalName } : {}),
    name: meta?.name ?? entry.name,
    namePlain: plain.namePlain,
    author: meta?.author ?? entry.author,
    authorPlain: plain.authorPlain,
    descriptionPlain: plain.descriptionPlain,
    version: latest?.modVersion ?? meta?.version ?? entry.version ?? null,
    minGameVersion: latest?.minGameVersion ?? meta?.minGameVersion ?? entry.minGameVersion ?? null,
    modType,
    gameVersionRanges: summary.gameVersionRanges,
    stars: entry.stars ?? 0,
    hasIcon: entry.hasIcon,
    iconUrl: entry.iconUrl ?? null,
    iconHash: entry.iconHash ?? null,
    releasesPath: entry.releasesPath,
    releaseCount: summary.releaseCount,
    ...(modType === 'java' ? {} : { tagCount: summary.tagCount }),
    releaseUpdatedAt: summary.releaseUpdatedAt ?? entry.releaseUpdatedAt ?? null,
    commitUpdatedAt: entry.commitUpdatedAt ?? null,
    totalDownloads: entry.totalDownloads ?? 0,
    allAssetsDownloads: entry.allAssetsDownloads ?? 0,
    releaseDataUpdatedAt: file?.generatedAt ?? entry.releaseDataUpdatedAt ?? null,
  };
  if (community) result.source = entry.source ?? 'topic';
  return result;
}

async function migrateGroup({
  outDir,
  indexRelPath,
  releasesBaseDir,
  relPrefix,
  compatData,
  now,
  log,
}) {
  const indexPath = path.join(outDir, indexRelPath);
  let index;
  try {
    index = await readJsonIfExists(indexPath);
  } catch (error) {
    log(`[警告] ${indexRelPath} 不可用，跳过迁移：${error.message}`);
    return { index: null, fileCount: 0, entryCount: 0 };
  }
  if (!index || !Array.isArray(index.mods)) {
    return { index: null, fileCount: 0, entryCount: 0 };
  }
  const community = indexRelPath.startsWith('community/');
  let fileCount = 0;
  let entryCount = 0;
  const nextEntries = [];
  for (const entry of index.mods) {
    if (!entry || typeof entry.repo !== 'string' || typeof entry.releasesPath !== 'string') {
      nextEntries.push(entry);
      continue;
    }
    const relative =
      relPrefix && entry.releasesPath.startsWith(relPrefix)
        ? entry.releasesPath.slice(relPrefix.length)
        : entry.releasesPath;
    const filePath = path.join(releasesBaseDir, relative);
    let file = null;
    try {
      file = await readJsonIfExists(filePath);
    } catch (error) {
      log(`[警告] ${relative} 不可用，跳过迁移：${error.message}`);
    }
    let nextFile = file;
    if (needsMigration(file)) {
      nextFile = migrateReleaseFileData({
        repo: entry.repo,
        previous: file,
        compatData,
        now,
        hasJava: entry.hasJava === true,
      });
      await writeJsonAtomic(filePath, nextFile);
      fileCount += 1;
    }
    const nextEntry = migrateIndexEntry(entry, nextFile, {
      gameVersions: compatData?.gameVersions ?? [],
      community,
    });
    if (canonicalJson(nextEntry) !== canonicalJson(entry)) {
      entryCount += 1;
    }
    nextEntries.push(nextEntry);
  }
  const nextIndex = { ...index, formatVersion: 3, mods: nextEntries };
  if (canonicalJson(nextIndex) !== canonicalJson(index)) {
    await writeJsonAtomic(indexPath, nextIndex);
  }
  return { index: nextIndex, fileCount, entryCount };
}

function summaryRowsFromIndex(index) {
  return (Array.isArray(index?.mods) ? index.mods : []).map((entry) => ({
    repo: entry.repo,
    name: entry.name,
    namePlain: entry.namePlain ?? '',
    author: entry.author,
    stars: entry.stars,
    modType: entry.modType,
    releaseCount: entry.releaseCount,
    ...(entry.modType === 'java' ? {} : { tagCount: entry.tagCount }),
    totalDownloads: entry.totalDownloads,
    allAssetsDownloads: entry.allAssetsDownloads,
    minGameVersion: entry.minGameVersion,
    gameVersionRanges: JSON.stringify(entry.gameVersionRanges ?? []),
    releaseUpdatedAt: entry.releaseUpdatedAt ?? null,
    commitUpdatedAt: entry.commitUpdatedAt ?? null,
    iconUrl: entry.iconUrl,
    releasesPath: entry.releasesPath,
  }));
}

async function migrateSummary({ outDir, index, relDir, now, log }) {
  if (!index) {
    return;
  }
  const previous = await readJsonIfExists(path.join(outDir, relDir, 'summary.json')).catch(
    () => null,
  );
  const rows = summaryRowsFromIndex(index);
  // 保留已有行的 latestModVersion/latestMinGameVersion（旧 summary 有）
  const previousByRepo = new Map(
    (Array.isArray(previous?.mods) ? previous.mods : []).map((row) => [row.repo, row]),
  );
  for (const row of rows) {
    const old = previousByRepo.get(row.repo);
    if (old) {
      row.latestModVersion = old.latestModVersion ?? null;
      row.latestMinGameVersion = old.latestMinGameVersion ?? null;
      row.latestTag = old.latestTag ?? row.latestTag;
      row.latestPrerelease = old.latestPrerelease ?? row.latestPrerelease;
    }
  }
  const summary = buildSummary({ rows, generatedAt: now });
  if (summaryBodyChanged(previous, summary)) {
    await writeJsonAtomic(path.join(outDir, relDir, 'summary.json'), summary);
  }
  const nextCsv = summaryCsv(summary.mods);
  let previousCsv = null;
  try {
    previousCsv = await import('node:fs/promises').then(({ readFile }) =>
      readFile(path.join(outDir, relDir, 'summary.csv'), 'utf8'),
    );
  } catch {
    previousCsv = null;
  }
  if (previousCsv !== nextCsv) {
    await writeTextAtomic(path.join(outDir, relDir, 'summary.csv'), nextCsv);
  }
  log(`[migrate] ${relDir || '.'} summary 行 ${summary.mods.length}`);
}

// 一次性把整个数据目录迁到 v2（官方 + 社区 + index/summary/status/changes），0 API
export async function migrateDataDir({ outDir, log = () => {}, now = new Date().toISOString() }) {
  // v3 已是当前结构：整体 no-op。避免每轮 workflow 的 --migrate 把 heat/ranks/full/summary 重写坏。
  const [mainIndex, fullIndex] = await Promise.all([
    readJsonIfExists(path.join(outDir, 'index.json')).catch(() => null),
    readJsonIfExists(path.join(outDir, 'index-full.json')).catch(() => null),
  ]);
  if (
    mainIndex?.formatVersion === 3 &&
    (!fullIndex || fullIndex.formatVersion === 3)
  ) {
    log('[migrate] 数据已是 v3，跳过迁移');
    return { officialFiles: 0, communityFiles: 0, entries: 0, skipped: true };
  }

  let versionsFile = null;
  let modGate = null;
  let javaGate = null;
  let refreshState = null;
  try {
    versionsFile = await readJsonIfExists(path.join(outDir, VERSIONS_REL_PATH));
  } catch {}
  try {
    modGate = await readJsonIfExists(path.join(outDir, GATE_REL_PATHS.mod));
  } catch {}
  try {
    javaGate = await readJsonIfExists(path.join(outDir, GATE_REL_PATHS.java));
  } catch {}
  try {
    refreshState = await readJsonIfExists(path.join(outDir, REFRESH_STATE_REL_PATH));
  } catch {}
  const compatData = {
    gameVersions: gameVersionsFromFile(versionsFile),
    modGate,
    javaGate,
  };

  const official = await migrateGroup({
    outDir,
    indexRelPath: 'index.json',
    releasesBaseDir: outDir,
    relPrefix: '',
    compatData,
    now,
    log,
  });
  const community = await migrateGroup({
    outDir,
    indexRelPath: 'community/index.json',
    releasesBaseDir: path.join(outDir, 'community'),
    relPrefix: 'community/',
    compatData,
    now,
    log,
  });

  if (official.index) {
    await migrateSummary({ outDir, index: official.index, relDir: '', now, log });
  }
  if (community.index) {
    await migrateSummary({
      outDir,
      index: community.index,
      relDir: 'community',
      now,
      log,
    });
  }

  // changes.json：不存在时写初始快照（mod-added，滚动上限截断）
  const changesPath = path.join(outDir, CHANGES_REL_PATH);
  const existingChanges = await readJsonIfExists(changesPath).catch(() => null);
  if (existingChanges === null) {
    const initial = [];
    for (const [dataset, index] of [
      ['official', official.index],
      ['community', community.index],
    ]) {
      for (const entry of Array.isArray(index?.mods) ? index.mods : []) {
        initial.push({
          at: now,
          dataset,
          repo: entry.repo,
          action: 'mod-added',
          ...(entry.namePlain ? { namePlain: entry.namePlain } : {}),
        });
      }
    }
    await writeJsonAtomic(changesPath, mergeChanges(initial, [], { max: MAX_CHANGES }));
  }

  // status.json：先基于当前数据算一次 validate 摘要，再写入
  const { validateDir } = await import('./validate.js');
  const state = normalizeRefreshState(refreshState);
  const statusFile = path.join(outDir, STATUS_REL_PATH);
  const previousStatus = await readJsonIfExists(statusFile).catch(() => null);
  const statusDatasets = {};
  if (official.index) {
    statusDatasets.official = {
      updatedAt: official.index.generatedAt ?? now,
      modCount: official.index.mods.length,
      releaseCount: official.index.mods.reduce(
        (sum, entry) => sum + (entry.releaseCount ?? 0),
        0,
      ),
      skipped: Array.isArray(official.index.skipped) ? official.index.skipped : [],
    };
  }
  if (community.index) {
    statusDatasets.community = {
      updatedAt: community.index.generatedAt ?? now,
      modCount: community.index.mods.length,
      releaseCount: community.index.mods.reduce(
        (sum, entry) => sum + (entry.releaseCount ?? 0),
        0,
      ),
      skipped: Array.isArray(community.index.skipped) ? community.index.skipped : [],
    };
  }
  if (versionsFile) {
    statusDatasets.versions = {
      updatedAt: now,
      modCount: null,
      releaseCount: Array.isArray(versionsFile.releases) ? versionsFile.releases.length : 0,
      skipped: [],
    };
  }
  if (modGate || javaGate) {
    statusDatasets.gate = {
      updatedAt: modGate?.generatedAt ?? javaGate?.generatedAt ?? now,
      modCount: null,
      releaseCount: null,
      skipped: [],
    };
  }
  let validation = { errors: 0, warnings: 0, presentFiles: [] };
  try {
    const result = await validateDir(outDir);
    validation = {
      errors: result.errors.length,
      warnings: result.warnings.length,
      presentFiles: result.present,
    };
  } catch {}
  const status = buildStatus({
    generatedAt: now,
    previous: previousStatus,
    datasets: statusDatasets,
    api: { requests: 0, remaining: null, resetAt: null },
    validate: validation,
  });
  await writeJsonAtomic(statusFile, status);
  // status 写完后再算一次（避免把“自身缺失”的 warning 记进去）
  try {
    const result = await validateDir(outDir);
    status.validate = {
      errors: result.errors.length,
      warnings: result.warnings.length,
      presentFiles: result.present,
    };
    await writeJsonAtomic(statusFile, status);
  } catch {}

  log(
    `[migrate] 旧文件迁移：官方 ${official.fileCount} 个 / 社区 ${community.fileCount} 个，` +
      `index 条目更新 ${official.entryCount + community.entryCount} 个，refresh 模组 ${Object.keys(state.mods).length}`,
  );
  return {
    officialFiles: official.fileCount,
    communityFiles: community.fileCount,
    entries: official.entryCount + community.entryCount,
  };
}
