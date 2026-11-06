#!/usr/bin/env node
// CLI 入口：按 --datasets 更新模组索引、Mindustry 可用版本列表、最小版本门禁

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { HttpClient, HttpError, RateLimitError, createPool } from './github.js';
import { MODS_URL, fetchModsJson, modIconUrl } from './mods-source.js';
import {
  PER_PAGE,
  fetchAllReleasePages,
  fetchReleasePages,
  normalizeReleases,
  mergeReleaseMetadata,
  mergeReleasesByTag,
  buildTagOnlyRelease,
  isReleaseEntry,
  sortReleases,
  buildReleasesFile,
} from './releases.js';
import { fetchAllTags, fetchTagPages } from './tags.js';
import { fetchModMetadata } from './mod-meta.js';
import { computeModStats } from './stats.js';
import {
  buildSummary,
  summaryBodyChanged,
  summaryCsv,
} from './summary.js';
import {
  REFRESH_STATE_REL_PATH,
  bootstrapModState,
  buildRefreshStateFile,
  cloneModState,
  isFullDue,
  isPage1Due,
  isPage2Due,
  lastRefreshedAt,
  normalizeRefreshState,
  stateBodyChanged,
} from './refresh-state.js';
import {
  releasesRelPath,
  releasesLegacyRelPath,
  resolveReleaseFile,
  resolveReleaseFileForDelete,
  assertRepo,
} from './paths.js';
import {
  readJsonIfExists,
  readTextIfExists,
  writeJsonAtomic,
  writeTextAtomic,
  releaseFileBodyChanged,
  indexBodyChanged,
  ensureReleasesDir,
  listReleaseFiles,
  deleteReleaseFile,
  INDEX_FILE,
} from './writer.js';
import {
  VERSIONS_REL_PATH,
  buildVersionsFile,
  versionsBodyChanged,
  fetchAllVersions,
  fetchLatestBe,
  fetchVersionsIncremental,
  trimRelease,
} from './versions.js';
import {
  GATE_REL_PATHS,
  GATE_TYPES,
  GATE_BASELINE_URL,
  GATE_SOURCE_CONSTANT_SINCE,
  BUILTIN_GATE_RULES,
  baselineLookup,
  buildGateFile,
  gateBodyChanged,
  gateStartVersion,
  mergeGateRules,
  normalizeBaselineRules,
  parseBaselineText,
  regularVersions,
  resolveVersionGate,
  splitLegacyGateFile,
} from './mod-gate.js';

const DATASETS = ['mods', 'versions', 'gate'];

const USAGE = `用法：node src/main.js [选项]

选项：
  --datasets <列表>   要更新的数据集，逗号分隔：mods,versions,gate，默认 mods
  --out <目录>        产物目录，默认 .
  --token <token>     GitHub token，默认读环境变量 GITHUB_TOKEN
  --repos a/b,c/d     只跑指定仓库（仅 mods 数据集，本地验证用）
  --limit <n>         最多处理 n 个模组（仅 mods 数据集）
  --threads <n>       同时处理的仓库数，默认 8
  --raw-threads <n>   raw.githubusercontent 并发数，默认 16
  --versions-pages <n>  只抓 Mindustry 版本列表前 n 页（仅本地验证，正式运行不要用）
  --versions-file <路径> 门禁用本地版本快照当输入（如启动器 remote/mindustry_versions.json）
  --no-cache          忽略旧产物，全量重抓（不使用 ETag、不复用旧数据）
  --keep-missing-files  不删除官方列表中已消失模组的 releases/*.json（仅 mods）
  --dry-run           只抓取与计算，不写任何文件
  --verbose           输出增量细节
  --help              显示本帮助`;

class UsageError extends Error {}

function requirePositiveInt(name, value) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`${name} 需要正整数，收到：${value}`);
  }
  return Number(value);
}

export function parseArgs(argv) {
  const options = {
    datasets: ['mods'],
    out: '.',
    token: process.env.GITHUB_TOKEN || null,
    repos: null,
    limit: null,
    threads: 8,
    rawThreads: 16,
    versionsPages: null,
    versionsFile: null,
    cache: true,
    keepMissingFiles: false,
    dryRun: false,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new UsageError(`无法识别的参数：${arg}`);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const takeValue = () => {
      if (inlineValue !== null) {
        return inlineValue;
      }
      index += 1;
      if (index >= argv.length) {
        throw new UsageError(`参数 ${name} 缺少值`);
      }
      return argv[index];
    };

    switch (name) {
      case '--datasets': {
        const list = takeValue()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        if (list.length === 0) {
          throw new UsageError('--datasets 不能为空');
        }
        const invalid = list.filter((item) => !DATASETS.includes(item));
        if (invalid.length > 0) {
          throw new UsageError(
            `--datasets 只支持 ${DATASETS.join(',')}，收到：${invalid.join(',')}`,
          );
        }
        options.datasets = [...new Set(list)];
        break;
      }
      case '--out':
        options.out = takeValue();
        if (!options.out.trim()) {
          throw new UsageError('--out 不能为空');
        }
        break;
      case '--token':
        options.token = takeValue() || null;
        break;
      case '--repos': {
        const repos = takeValue()
          .split(',')
          .map((repo) => repo.trim())
          .filter(Boolean);
        if (repos.length === 0) {
          throw new UsageError('--repos 至少要给一个 owner/name');
        }
        for (const repo of repos) {
          try {
            assertRepo(repo);
          } catch (error) {
            throw new UsageError(error.message);
          }
        }
        options.repos = [...new Set(repos)];
        break;
      }
      case '--limit':
        options.limit = requirePositiveInt('--limit', takeValue());
        break;
      case '--threads':
        options.threads = requirePositiveInt('--threads', takeValue());
        break;
      case '--raw-threads':
        options.rawThreads = requirePositiveInt('--raw-threads', takeValue());
        break;
      case '--versions-pages':
        options.versionsPages = requirePositiveInt('--versions-pages', takeValue());
        break;
      case '--versions-file':
        options.versionsFile = takeValue();
        if (!options.versionsFile.trim()) {
          throw new UsageError('--versions-file 不能为空');
        }
        break;
      case '--no-cache':
        options.cache = false;
        break;
      case '--keep-missing-files':
        options.keepMissingFiles = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new UsageError(`未知选项：${name}`);
    }
  }

  if ((options.repos !== null || options.limit !== null) && !options.datasets.includes('mods')) {
    throw new UsageError('--repos / --limit 只用于 mods 数据集');
  }
  if (options.versionsPages !== null && !options.datasets.includes('versions')) {
    throw new UsageError('--versions-pages 只用于 versions 数据集');
  }
  if (options.versionsFile !== null && !options.datasets.includes('gate')) {
    throw new UsageError('--versions-file 只用于 gate 数据集');
  }
  return options;
}

// ---------- mods 数据集 ----------

function buildIndexEntry(mod, file, { relPath, oldEntry = null } = {}) {
  const hasFile = Array.isArray(file?.releases);
  const releases = hasFile ? file.releases : [];
  const releaseEntries = releases.filter(isReleaseEntry);
  const stats = computeModStats(releases, mod.hasJava === true);
  const first = releaseEntries[0] ?? null;
  const releaseCount = hasFile
    ? releaseEntries.length
    : typeof oldEntry?.releaseCount === 'number'
      ? oldEntry.releaseCount
      : 0;
  const tagCount = hasFile
    ? releases.length
    : typeof oldEntry?.tagCount === 'number'
      ? oldEntry.tagCount
      : releaseCount;
  const latestRelease = first
    ? {
        tag: first.tag,
        name: first.name,
        prerelease: first.prerelease,
        publishedAt: first.publishedAt,
        downloads: stats.latestDownloads,
        sizeBytes: stats.latestSizeBytes,
      }
    : hasFile
      ? null
      : (oldEntry?.latestRelease ?? null);

  return {
    repo: mod.repo,
    internalName: mod.internalName,
    name: mod.name,
    author: mod.author,
    version: mod.version,
    minGameVersion: mod.minGameVersion,
    lastUpdated: mod.lastUpdated,
    stars: mod.stars,
    hasIcon: mod.hasIcon,
    hasScripts: mod.hasScripts,
    hasJava: mod.hasJava,
    // 只记录地址不下载字节；hasIcon === false 才为 null
    iconUrl: modIconUrl(mod.repo, mod.hasIcon),
    iconHash: mod.iconHash ?? null,
    releasesPath: hasFile
      ? relPath
      : (oldEntry?.releasesPath ?? (file ? relPath : null)),
    releaseCount,
    tagCount,
    totalDownloads: stats.totalDownloads,
    allAssetsDownloads: stats.allAssetsDownloads,
    latestDownloads: stats.latestDownloads,
    latestSizeBytes: stats.latestSizeBytes,
    totalSizeBytes: stats.totalSizeBytes,
    latestRelease,
    releaseDataUpdatedAt: file?.generatedAt ?? oldEntry?.releaseDataUpdatedAt ?? null,
  };
}

function skipReason(error) {
  if (error instanceof RateLimitError) {
    return 'rate-limit';
  }
  const status = error instanceof HttpError ? error.status : error?.status;
  return status ? `http-${status}` : 'network';
}

// 旧文件里能推断出的总页数（用于判断是否还有更深页）
function lastKnownPageCount(previousFile) {
  if (!previousFile || !Array.isArray(previousFile.releases)) {
    return 1;
  }
  return Math.max(1, Math.ceil(previousFile.releases.length / PER_PAGE));
}

// 刷新计划：全量（每月）优先；否则第 1 页 2 小时、第 2 页每周
function planModRefresh({ previousFile, modState, forceFull, now }) {
  if (forceFull || !previousFile) {
    return { full: true, reason: 'first-run' };
  }
  if (isFullDue(modState?.fullFetchedAt ?? null, now)) {
    return { full: true, reason: 'monthly' };
  }
  return {
    full: false,
    page1: isPage1Due(modState?.page1FetchedAt ?? null, now),
    page2: isPage2Due(modState?.page2FetchedAt ?? null, now),
    knownPageCount: lastKnownPageCount(previousFile),
  };
}

// API 配额不足时按「最久没刷新」优先排队，上次没跑到的模组下次先处理
export function sortModsForRefresh(mods, previousState) {
  return [...mods].sort((left, right) => {
    const a = lastRefreshedAt(previousState?.mods?.[left.repo]);
    const b = lastRefreshedAt(previousState?.mods?.[right.repo]);
    if (a !== b) {
      return a - b;
    }
    return left.repo.localeCompare(right.repo);
  });
}

function unprocessedModResult({ mod, previous, modState, relPath, oldEntry, reason }) {
  return {
    entry: buildIndexEntry(mod, previous, { relPath, oldEntry }),
    file: previous,
    state: modState ?? null,
    skipped: null,
    changed: false,
    unprocessed: true,
    reason,
  };
}

async function processMod(context) {
  const {
    mod,
    options,
    rawPool,
    rawClient,
    apiClient,
    outDir,
    now,
    nowMs,
    log,
    oldEntries,
    previousState,
    abortState,
  } = context;
  const relPath = releasesRelPath(mod.repo);
  const legacyRelPath = releasesLegacyRelPath(mod.repo);
  const oldEntry = oldEntries.get(mod.repo.toLowerCase()) ?? null;
  const hasJava = mod.hasJava === true;

  let previous = null;
  let legacyToDelete = null;
  if (options.cache) {
    try {
      const newFile = await readJsonIfExists(resolveReleaseFile(outDir, relPath));
      if (newFile && newFile.repo === mod.repo && Array.isArray(newFile.releases)) {
        previous = newFile;
      }
    } catch (error) {
      log(`[警告] ${mod.repo} 的新路径数据不可用：${error.message}`);
    }
    if (!previous) {
      // 兼容旧 flat 路径：读出来当缓存，本轮迁到 releases/<owner>/<repo>.json 后删除旧文件
      try {
        const legacyFile = await readJsonIfExists(
          resolveReleaseFileForDelete(outDir, legacyRelPath),
        );
        if (legacyFile && legacyFile.repo === mod.repo && Array.isArray(legacyFile.releases)) {
          previous = legacyFile;
          legacyToDelete = legacyRelPath;
        }
      } catch (error) {
        log(`[警告] ${mod.repo} 的旧 flat 数据不可用：${error.message}`);
      }
    }
  }

  // 刷新缓存从 state/refresh.json 读取；旧 per-mod 文件里的 source 只用于一次性迁移
  let modState;
  if (options.cache) {
    modState = previousState.mods[mod.repo];
    if (!modState && previous) {
      modState = bootstrapModState({
        legacySource: previous.source ?? null,
        releaseCount: previous.releases.length,
        fallbackFetchedAt: previous.generatedAt ?? null,
      });
    }
  }

  // 配额已不足：不再发请求，保留旧数据（计入「未处理」，下次续跑）
  if (abortState?.aborted || apiClient.hasLowQuota?.(5)) {
    if (abortState && !abortState.aborted) {
      abortState.aborted = true;
      abortState.reason = 'quota';
    }
    return unprocessedModResult({
      mod,
      previous,
      modState,
      relPath,
      oldEntry,
      reason: 'quota',
    });
  }

  try {
    const plan = planModRefresh({
      previousFile: previous,
      modState,
      forceFull: !options.cache,
      now: nowMs,
    });

    let releasePageResults = [];
    let tagPageResults = [];
    let fullTagNames = null;
    if (plan.full) {
      releasePageResults = await fetchAllReleasePages(apiClient, mod.repo);
      const tagAll = await fetchAllTags(apiClient, mod.repo);
      fullTagNames = tagAll.tags;
      tagPageResults = [{ page: 1, names: tagAll.tags, complete: true }];
    } else {
      const pages = [];
      if (plan.page1) {
        pages.push(1);
      }
      if (plan.page2) {
        pages.push(2);
      }
      if (pages.length > 0) {
        const etags = {};
        if (pages.includes(1) && modState?.page1Etag) {
          etags[1] = modState.page1Etag;
        }
        releasePageResults = await fetchReleasePages(apiClient, mod.repo, {
          pages,
          etags,
        });
      }
      const tagPages = [];
      // tag 列表从没抓过时先抓第 1 页（不必等 releases 第 1 页到期）
      if (plan.page1 || !modState?.tagsFetchedAt) {
        tagPages.push(1);
      }
      if (plan.page2) {
        tagPages.push(2);
      }
      if (tagPages.length > 0) {
        tagPageResults = await fetchTagPages(apiClient, mod.repo, tagPages);
      }
    }

    const fetchedReleases = [];
    let firstPageResult = null;
    for (const pageResult of releasePageResults) {
      if (pageResult.page === 1 && !pageResult.notModified) {
        firstPageResult = pageResult;
      }
      if (!pageResult.notModified) {
        fetchedReleases.push(
          ...normalizeReleases(pageResult.items, { repo: mod.repo, hasJava }),
        );
      }
    }

    const metaMerged = fetchedReleases.length > 0
      ? await mergeReleaseMetadata({
          previousReleases: previous?.releases ?? [],
          releases: fetchedReleases,
          fetchMetadata: (tag) =>
            rawPool.run(() =>
              fetchModMetadata(rawClient, {
                repo: mod.repo,
                tag,
                hasJava,
              }),
            ),
        })
      : { releases: [], metaFetched: 0, metaReused: 0 };

    // 合并条目：全量时直接用本次抓到的全部 release；否则按 tag 合并保留没抓的旧页。
    // 旧文件没有 hasRelease 字段 → 统一补成 true（一次性迁移）
    let entries = plan.full
      ? metaMerged.releases.map((release) => ({ ...release, hasRelease: true }))
      : mergeReleasesByTag(previous?.releases ?? [], metaMerged.releases).map(
          (release) => (isReleaseEntry(release) ? { ...release, hasRelease: true } : release),
        );

    // tag-only 条目：全量时按完整 tag 列表重建（删除已不存在的 tag），否则增量补新 tag
    const tagsFetched = tagPageResults.length > 0;
    if (fullTagNames !== null) {
      const present = new Set(entries.map((release) => release.tag));
      const tagOnly = fullTagNames
        .filter((tag) => !present.has(tag))
        .map((tag) => buildTagOnlyRelease({ repo: mod.repo, tag }));
      if (tagOnly.length > 0) {
        const tagMeta = await mergeReleaseMetadata({
          previousReleases: previous?.releases ?? [],
          releases: tagOnly,
          fetchMetadata: (tag) =>
            rawPool.run(() =>
              fetchModMetadata(rawClient, {
                repo: mod.repo,
                tag,
                hasJava,
              }),
            ),
        });
        entries.push(...tagMeta.releases);
        metaMerged.metaFetched += tagMeta.metaFetched;
        metaMerged.metaReused += tagMeta.metaReused;
      }
    } else if (tagsFetched) {
      const present = new Set(entries.map((release) => release.tag));
      const newTagNames = [];
      for (const tagPage of tagPageResults) {
        for (const name of tagPage.names) {
          if (!present.has(name)) {
            present.add(name);
            newTagNames.push(name);
          }
        }
      }
      if (newTagNames.length > 0) {
        const tagOnly = newTagNames.map((tag) =>
          buildTagOnlyRelease({ repo: mod.repo, tag }),
        );
        const tagMeta = await mergeReleaseMetadata({
          previousReleases: previous?.releases ?? [],
          releases: tagOnly,
          fetchMetadata: (tag) =>
            rawPool.run(() =>
              fetchModMetadata(rawClient, {
                repo: mod.repo,
                tag,
                hasJava,
              }),
            ),
        });
        entries.push(...tagMeta.releases);
        metaMerged.metaFetched += tagMeta.metaFetched;
        metaMerged.metaReused += tagMeta.metaReused;
      }
    }
    entries = sortReleases(entries);
    const nextFile = buildReleasesFile({
      repo: mod.repo,
      releases: entries,
      // 数据没变但只是迁移路径时沿用旧 generatedAt，避免 index 的 releaseDataUpdatedAt 抖动
      generatedAt: releaseFileBodyChanged(previous, {
        formatVersion: 1,
        repo: mod.repo,
        releases: entries,
      })
        ? now
        : (previous?.generatedAt ?? now),
    });
    const changed = releaseFileBodyChanged(previous, nextFile);
    const shouldWrite = changed || legacyToDelete !== null;
    if (shouldWrite && !options.dryRun) {
      await writeJsonAtomic(resolveReleaseFile(outDir, relPath), nextFile);
      if (legacyToDelete !== null) {
        await deleteReleaseFile(outDir, legacyToDelete);
        log(`[${mod.repo}] 旧 flat 文件已迁移到 ${relPath}`);
      }
    }
    const finalFile = shouldWrite ? nextFile : (previous ?? nextFile);

    // 更新本模组的刷新调度状态
    const nextState = cloneModState(modState);
    const fetchedReleasePages = new Set(releasePageResults.map((result) => result.page));
    if (plan.full) {
      nextState.page1FetchedAt = now;
      nextState.page2FetchedAt = now;
      nextState.fullFetchedAt = now;
      nextState.tagsFetchedAt = now;
      nextState.page1Etag = firstPageResult?.etag ?? null;
    } else {
      const page1Result = releasePageResults.find((result) => result.page === 1);
      if (plan.page1 && page1Result) {
        nextState.page1FetchedAt = now;
        if (!page1Result.notModified) {
          nextState.page1Etag = page1Result.etag ?? null;
        }
      }
      if (plan.page2 && fetchedReleasePages.has(2)) {
        nextState.page2FetchedAt = now;
      }
      if (tagsFetched) {
        nextState.tagsFetchedAt = now;
      }
      // 数据已经覆盖到最后一页且 tag 列表也完整时，顺带把「全量」时间推进到本轮
      const neededPages = Math.max(
        1,
        Math.ceil(nextFile.releases.filter(isReleaseEntry).length / PER_PAGE),
      );
      const releaseComplete = releasePageResults.some(
        (result) =>
          !result.notModified &&
          result.items.length < PER_PAGE &&
          result.page >= neededPages,
      );
      const tagsComplete = tagPageResults.some((result) => result.complete);
      if (releaseComplete && tagsComplete) {
        nextState.fullFetchedAt = now;
      }
    }

    const releaseEntryCount = nextFile.releases.filter(isReleaseEntry).length;
    if (changed) {
      log(
        `[${mod.repo}] ${nextFile.releases.length} 个 tag（${releaseEntryCount} 个有 Release），元数据新抓 ${metaMerged.metaFetched} 个、复用 ${metaMerged.metaReused} 个${options.dryRun ? '（dry-run 未写入）' : ''}`,
      );
    } else if (fetchedReleasePages.size > 0 || tagsFetched) {
      const parts = [];
      if (fetchedReleasePages.size > 0) {
        parts.push(`release 第 ${[...fetchedReleasePages].sort((a, b) => a - b).join('、')} 页`);
      }
      if (tagsFetched) {
        parts.push(`tag 第 ${tagPageResults.map((result) => result.page).join('、')} 页`);
      }
      log(`[${mod.repo}] 内容未变（${parts.join('、')}已刷新，文件不重写）`);
    }
    return {
      entry: buildIndexEntry(mod, finalFile, { relPath, oldEntry }),
      file: finalFile,
      state: nextState,
      skipped: null,
      changed,
      unprocessed: false,
    };
  } catch (error) {
    const rateLimited =
      error instanceof RateLimitError || error?.status === 403 || error?.status === 429;
    if (rateLimited && abortState) {
      abortState.aborted = true;
      abortState.reason = 'rate-limit';
    }
    // 单页失败：保留旧数据/旧 state，记 skipped，不写坏文件；但旧 flat 文件仍尽量迁移到新路径
    console.error(`[跳过] ${mod.repo}：${error.message}`);
    let finalFile = previous;
    if (previous && legacyToDelete !== null && !options.dryRun) {
      try {
        finalFile = buildReleasesFile({
          repo: mod.repo,
          releases: previous.releases,
          generatedAt: previous.generatedAt ?? now,
        });
        await writeJsonAtomic(resolveReleaseFile(outDir, relPath), finalFile);
        await deleteReleaseFile(outDir, legacyToDelete);
        log(`[${mod.repo}] 旧 flat 文件已迁移到 ${relPath}（本次抓取失败，保留旧数据）`);
      } catch (migrationError) {
        log(`[警告] ${mod.repo} 迁移旧路径失败：${migrationError.message}`);
        finalFile = previous;
      }
    }
    return {
      entry: buildIndexEntry(mod, finalFile, { relPath, oldEntry }),
      file: finalFile,
      state: previousState.mods[mod.repo],
      skipped: { repo: mod.repo, reason: skipReason(error) },
      changed: false,
      unprocessed: false,
    };
  }
}

async function readOldIndex(outDir, log) {
  try {
    return await readJsonIfExists(path.join(outDir, INDEX_FILE));
  } catch (error) {
    log(`[警告] 旧 index.json 不可用，按首次运行处理：${error.message}`);
    return null;
  }
}

async function cleanupMissing(outDir, selected, log) {
  const keep = new Set(selected.map((mod) => releasesRelPath(mod.repo)));
  const existing = await listReleaseFiles(outDir);
  let removed = 0;
  for (const relPath of existing) {
    if (!keep.has(relPath) && (await deleteReleaseFile(outDir, relPath))) {
      removed += 1;
    }
  }
  if (removed > 0) {
    log(`清理 ${removed} 个已不在官方列表中的 releases 文件`);
  }
}

async function loadRefreshState(outDir, log) {
  const file = path.join(outDir, REFRESH_STATE_REL_PATH);
  try {
    const raw = await readJsonIfExists(file);
    return { file, exists: raw !== null, state: normalizeRefreshState(raw) };
  } catch (error) {
    log(`[警告] ${REFRESH_STATE_REL_PATH} 不可用，按首次运行处理：${error.message}`);
    return { file, exists: false, state: normalizeRefreshState(null) };
  }
}

export async function runMods(options, context) {
  const { apiClient, rawClient, outDir, log } = context;

  let mods;
  try {
    mods = await fetchModsJson(rawClient);
  } catch (error) {
    console.error(`无法获取官方模组列表：${error.message}`);
    return { code: 1, changed: 0 };
  }
  console.log(`官方列表：${mods.length} 个模组`);

  if (!options.token && !options.repos) {
    console.warn(
      '[提示] 未提供 GITHUB_TOKEN，匿名配额只有 60 次/小时，全量运行会很快耗尽；本地请用 --repos 跑小子集',
    );
  }

  let selected = mods;
  if (options.repos) {
    const byRepo = new Map(mods.map((mod) => [mod.repo.toLowerCase(), mod]));
    const missing = options.repos.filter((repo) => !byRepo.has(repo.toLowerCase()));
    if (missing.length > 0) {
      console.error(
        `以下仓库不在官方模组列表中，无法按官方字段抓取：${missing.join(', ')}`,
      );
      return { code: 1, changed: 0 };
    }
    const wanted = new Set(options.repos.map((repo) => repo.toLowerCase()));
    // 子集也保持官方列表顺序
    selected = mods.filter((mod) => wanted.has(mod.repo.toLowerCase()));
  }
  if (options.limit !== null) {
    selected = selected.slice(0, options.limit);
  }

  const oldIndex = await readOldIndex(outDir, log);
  const oldEntries = new Map(
    (Array.isArray(oldIndex?.mods) ? oldIndex.mods : [])
      .filter((entry) => typeof entry?.repo === 'string')
      .map((entry) => [entry.repo.toLowerCase(), entry]),
  );
  const stateLoaded = await loadRefreshState(outDir, log);
  const previousState = stateLoaded.state;

  const rawPool = createPool(options.rawThreads);
  const apiPool = createPool(options.threads);
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const resultsByRepo = new Map();
  // API 配额不足时：停止发新请求、保留已抓结果、exit 0；未处理的模组下次按「最久未刷新」优先
  const abortState = { aborted: false, reason: null };
  const processingOrder = sortModsForRefresh(selected, previousState);
  let completed = 0;

  await Promise.all(
    processingOrder.map((mod) =>
      apiPool.run(async () => {
        const result = await processMod({
          mod,
          options,
          apiClient,
          rawClient,
          rawPool,
          outDir,
          now,
          nowMs,
          log,
          oldEntries,
          previousState,
          abortState,
        });
        resultsByRepo.set(mod.repo, result);
        completed += 1;
        if (!options.verbose && selected.length > 20 && completed % 50 === 0) {
          console.log(`进度：${completed}/${selected.length}`);
        }
      }),
    ),
  );

  // index / summary 仍按官方列表顺序输出
  const results = selected.map((mod) => resultsByRepo.get(mod.repo));
  const unprocessed = results.filter((result) => result.unprocessed);
  const rateLimitedCount = results.filter(
    (result) => result.skipped?.reason === 'rate-limit',
  ).length;
  const notProcessedCount = unprocessed.length + rateLimitedCount;
  if (abortState.aborted && notProcessedCount > 0) {
    console.warn(
      `[警告] API 配额不足（${abortState.reason}），本次未处理 ${notProcessedCount}/${selected.length} 个模组，已保留已抓结果；下次运行会从最久未刷新的模组继续`,
    );
  }
  const skipped = results
    .filter((result) => result.skipped)
    .map((result) => result.skipped);
  const isSubset = options.repos !== null || options.limit !== null;

  // 分页调度缓存：子集模式保留其它模组的状态；全量模式只保留官方列表里的模组
  const stateMods = isSubset ? { ...previousState.mods } : {};
  for (const [index, result] of results.entries()) {
    const repo = selected[index].repo;
    if (result.state) {
      stateMods[repo] = result.state;
    } else if (previousState.mods[repo]) {
      stateMods[repo] = previousState.mods[repo];
    }
  }
  const nextState = buildRefreshStateFile({ mods: stateMods, updatedAt: now });
  const stateChanged = stateBodyChanged(previousState, nextState);
  if (!options.dryRun && stateChanged) {
    await writeJsonAtomic(stateLoaded.file, nextState);
  }

  const index = {
    formatVersion: 1,
    generatedAt: now,
    source: {
      modsUrl: MODS_URL,
      modCount: selected.length,
    },
    mods: results.map((result) => result.entry),
    skipped,
  };
  const indexChanged = indexBodyChanged(oldIndex, index);
  if (!options.dryRun && indexChanged) {
    await writeJsonAtomic(path.join(outDir, INDEX_FILE), index);
  } else if (!indexChanged) {
    log('[mods] index 内容未变，保留旧文件');
  }

  if (!options.dryRun && !options.keepMissingFiles && !isSubset) {
    await cleanupMissing(outDir, selected, log);
  }

  // 总表：基于合并后的完整 releases 聚合
  const summaryRows = results.map((result, index) => {
    const mod = selected[index];
    const firstRelease = result.file?.releases?.find(isReleaseEntry) ?? null;
    return {
      repo: mod.repo,
      name: mod.name,
      author: mod.author,
      stars: mod.stars,
      releaseCount: result.entry.releaseCount,
      tagCount: result.entry.tagCount,
      totalDownloads: result.entry.totalDownloads,
      allAssetsDownloads: result.entry.allAssetsDownloads,
      latestDownloads: result.entry.latestDownloads,
      latestSizeBytes: result.entry.latestSizeBytes,
      totalSizeBytes: result.entry.totalSizeBytes,
      latestTag: firstRelease?.tag ?? null,
      latestPrerelease: firstRelease ? firstRelease.prerelease : null,
      latestModVersion: firstRelease?.modVersion ?? null,
      latestMinGameVersion: firstRelease?.minGameVersion ?? null,
      iconUrl: modIconUrl(mod.repo, mod.hasIcon),
      releasesPath: result.entry.releasesPath,
    };
  });
  const summary = buildSummary({ rows: summaryRows, generatedAt: now });
  const summaryFile = path.join(outDir, 'summary.json');
  const summaryCsvFile = path.join(outDir, 'summary.csv');
  let previousSummary = null;
  let previousCsv = null;
  if (options.cache) {
    try {
      previousSummary = await readJsonIfExists(summaryFile);
    } catch (error) {
      log(`[警告] 旧 summary.json 不可用：${error.message}`);
    }
    try {
      previousCsv = await readTextIfExists(summaryCsvFile);
    } catch (error) {
      log(`[警告] 旧 summary.csv 不可用：${error.message}`);
    }
  }
  const summaryChanged = summaryBodyChanged(previousSummary, summary);
  const nextCsv = summaryCsv(summary.mods);
  const csvChanged = previousCsv !== nextCsv;
  if (!options.dryRun) {
    if (summaryChanged) {
      await writeJsonAtomic(summaryFile, summary);
    }
    if (csvChanged) {
      await writeTextAtomic(summaryCsvFile, nextCsv);
    }
  }

  const changed = results.filter((result) => result.changed).length;
  console.log(
    `[mods] ${selected.length} 个模组，${changed} 个 release 文件有变化，` +
      `index ${indexChanged ? '已更新' : '未变'}，` +
      `summary ${summaryChanged || csvChanged ? '已更新' : '未变'}，` +
      `state ${stateChanged ? '已更新' : '未变'}，${skipped.length} 个抓取失败` +
      (notProcessedCount > 0 ? `，${notProcessedCount} 个因配额不足未处理` : ''),
  );
  if (skipped.length > 0) {
    const preview = skipped.slice(0, 5).map((item) => `${item.repo}（${item.reason}）`);
    console.warn(
      `[警告] ${skipped.length} 个仓库抓取失败，已保留旧数据：${preview.join('、')}${skipped.length > 5 ? ' 等' : ''}`,
    );
  }
  return {
    code: 0,
    changed,
    indexChanged,
    summaryChanged: summaryChanged || csvChanged,
    stateChanged,
    unprocessed: notProcessedCount,
  };
}

// ---------- versions 数据集 ----------

function isoSeconds(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function runVersions(options, context) {
  const { apiClient, outDir, log } = context;
  const file = path.join(outDir, VERSIONS_REL_PATH);

  let previous = null;
  if (options.cache) {
    try {
      previous = await readJsonIfExists(file);
    } catch (error) {
      log(`[警告] 旧 versions.json 不可用，按首次运行处理：${error.message}`);
    }
  }
  const previousReleases = Array.isArray(previous?.releases) ? previous.releases : null;

  let releasesResult;
  try {
    releasesResult = await fetchVersionsIncremental(apiClient, {
      etag: previousReleases ? (previous?.etags?.releases ?? null) : null,
      localReleases: previousReleases,
      maxPages: options.versionsPages,
    });
  } catch (error) {
    console.error(`获取 Mindustry 版本列表失败：${error.message}`);
    return { code: 1, releases: null, changed: false };
  }

  const releases = releasesResult.notModified && previousReleases
    ? previousReleases
    : releasesResult.releases;
  if (releasesResult.notModified && previousReleases) {
    log(`[versions] 正式版列表 304，复用 ${previousReleases.length} 条旧数据`);
  } else if (releasesResult.rebuilt) {
    log(
      `[versions] 第一页出现新 release，重建完整列表（${releasesResult.fetchedPages} 页）`,
    );
  } else {
    log(`[versions] 只用第一页增量合并（${releasesResult.fetchedPages} 页）`);
  }

  let beResult;
  try {
    beResult = await fetchLatestBe(apiClient, {
      etag: previous?.latest_be ? (previous?.etags?.latestBe ?? null) : null,
    });
  } catch (error) {
    console.warn(`[警告] 获取最新 BE 失败，沿用旧值：${error.message}`);
    beResult = { notModified: true };
  }
  const latestBe = beResult.notModified
    ? (previous?.latest_be ?? null)
    : beResult.release;
  if (beResult.notModified && previous?.latest_be) {
    log('[versions] 最新 BE 304，复用旧数据');
  }

  const nextFile = buildVersionsFile({
    releases,
    latestBe,
    etags: {
      releases: releasesResult.notModified
        ? (previous?.etags?.releases ?? null)
        : releasesResult.etag,
      latestBe: beResult.notModified
        ? (previous?.etags?.latestBe ?? null)
        : beResult.etag,
    },
    updateTime: isoSeconds(),
  });
  const changed = versionsBodyChanged(previous, nextFile);
  if (changed) {
    if (!options.dryRun) {
      await writeJsonAtomic(file, nextFile);
    }
    log(
      `[versions] 正式版 ${releases.length} 条 + BE ${latestBe?.tag_name ?? '无'}${options.dryRun ? '（dry-run 未写入）' : ''}`,
    );
    console.log(
      `[versions] 更新：正式版 ${releases.length} 条，最新 BE ${latestBe?.tag_name ?? '无'}`,
    );
  } else {
    console.log('[versions] 无变化，保留旧文件');
  }
  return { code: 0, releases, changed };
}

// ---------- gate 数据集 ----------

async function loadVersionsInput(options, context) {
  if (context.versionsReleases) {
    return context.versionsReleases;
  }
  if (options.versionsFile) {
    const file = path.resolve(options.versionsFile);
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(data)) {
      return data;
    }
    if (Array.isArray(data?.releases)) {
      return data.releases;
    }
    throw new Error(`${file} 里没有 releases 数组`);
  }
  try {
    const cached = await readJsonIfExists(
      path.join(context.outDir, VERSIONS_REL_PATH),
    );
    if (Array.isArray(cached?.releases)) {
      context.log(`[gate] 用 ${VERSIONS_REL_PATH} 作版本输入`);
      return cached.releases;
    }
  } catch (error) {
    context.log(`[警告] ${VERSIONS_REL_PATH} 不可用：${error.message}`);
  }
  context.log('[gate] 没有本地版本列表，现抓 Mindustry releases');
  const fetched = await fetchAllVersions(context.apiClient, {});
  return fetched.notModified ? [] : fetched.raws.map(trimRelease);
}

async function loadGateBaseline(context, previousRules) {
  try {
    const response = await context.rawClient.get(GATE_BASELINE_URL);
    if (response.status === 200) {
      const rules = parseBaselineText(response.text);
      if (rules) {
        context.log('[gate] 基线规则来自 mmgvm.hjson');
        return rules;
      }
    }
  } catch (error) {
    context.log(`[警告] 拉取 mmgvm 基线失败：${error.message}`);
  }
  const previous = normalizeBaselineRules(previousRules);
  if (previous) {
    context.log('[gate] 基线规则沿用上一份 mod-gate.json');
    return previous;
  }
  context.log('[gate] 基线规则使用内置兜底表');
  return BUILTIN_GATE_RULES;
}

async function readGateFile(file, log, label) {
  try {
    return await readJsonIfExists(file);
  } catch (error) {
    log(`[警告] 旧 ${label} 不可用，按首次运行处理：${error.message}`);
    return null;
  }
}

async function runGate(options, context) {
  const files = {
    mod: path.join(context.outDir, GATE_REL_PATHS.mod),
    java: path.join(context.outDir, GATE_REL_PATHS.java),
  };
  let previous = { mod: null, java: null };
  if (options.cache) {
    previous.mod = await readGateFile(files.mod, context.log, GATE_REL_PATHS.mod);
    previous.java = await readGateFile(files.java, context.log, GATE_REL_PATHS.java);
  }

  // 迁移：旧 mod-gate.json 是「mod+java 合在一条规则里」的形状，拆成两份缓存
  let legacyRules = null;
  if (previous.mod && previous.mod.gate !== 'mod' && previous.java === null) {
    const split = splitLegacyGateFile(previous.mod);
    if (split) {
      legacyRules = previous.mod.rules;
      previous.mod = split.mod;
      previous.java = split.java;
      context.log('[gate] 检测到旧合并门禁文件，按 mod/java 拆分缓存迁移');
    }
  }

  let versionsInput;
  try {
    versionsInput = await loadVersionsInput(options, context);
  } catch (error) {
    console.error(`获取门禁的版本输入失败：${error.message}`);
    return { code: 1, changed: false };
  }
  const regular = regularVersions(versionsInput).filter(
    (item) => item.version >= gateStartVersion(),
  );
  if (regular.length === 0) {
    console.error('[gate] 版本输入里没有可用的正式版 tag，无法生成门禁');
    return { code: 1, changed: false };
  }

  const baseline = await loadGateBaseline(context, legacyRules);
  const previousByTag = {
    mod: new Map(
      (Array.isArray(previous.mod?.versions) ? previous.mod.versions : [])
        .filter((item) => typeof item?.tag === 'string')
        .map((item) => [item.tag, item]),
    ),
    java: new Map(
      (Array.isArray(previous.java?.versions) ? previous.java.versions : [])
        .filter((item) => typeof item?.tag === 'string')
        .map((item) => [item.tag, item]),
    ),
  };
  const resolvedPaths = new Set([
    ...(Array.isArray(previous.mod?.source?.resolvedPaths)
      ? previous.mod.source.resolvedPaths
      : []),
    ...(Array.isArray(previous.java?.source?.resolvedPaths)
      ? previous.java.source.resolvedPaths
      : []),
  ]);
  const results = [];
  let previousHadConstants = [...previousByTag.mod.values()].some(
    (item) => item.source === 'game-source',
  );

  for (const { tag, version } of regular) {
    const cachedMod = previousByTag.mod.get(tag);
    const cachedJava = previousByTag.java.get(tag);
    if (
      cachedMod?.source === 'game-source' &&
      cachedJava?.source === 'game-source' &&
      Number.isInteger(cachedMod.value) &&
      Number.isInteger(cachedJava.value)
    ) {
      results.push({
        tag,
        version,
        mod: cachedMod.value,
        java: cachedJava.value,
        source: 'game-source',
      });
      previousHadConstants = true;
      continue;
    }
    if (
      cachedMod?.source === 'baseline' &&
      cachedJava?.source === 'baseline' &&
      Number.isInteger(cachedMod.value) &&
      Number.isInteger(cachedJava.value)
    ) {
      // 老版本不再抓源码；基线规则变了就按新基线重算，没变直接复用
      const lookup = baselineLookup(baseline, version);
      if (lookup) {
        results.push({
          tag,
          version,
          mod: lookup.mod,
          java: lookup.java,
          source: 'baseline',
        });
        previousHadConstants = false;
        continue;
      }
    }

    // v147 之前的源码没有门禁常量，直接查基线，省掉每版 4 次候选路径请求
    if (version < GATE_SOURCE_CONSTANT_SINCE) {
      const lookup = baselineLookup(baseline, version);
      if (lookup) {
        results.push({
          tag,
          version,
          mod: lookup.mod,
          java: lookup.java,
          source: 'baseline',
        });
        previousHadConstants = false;
        continue;
      }
    }

    let resolved = null;
    try {
      resolved = await resolveVersionGate({
        tag,
        rawClient: context.rawClient,
        apiClient: context.apiClient,
        allowTree: previousHadConstants,
      });
    } catch (error) {
      context.log(`[警告] ${tag} 源码门禁读取失败，走基线：${error.message}`);
    }
    if (resolved?.found) {
      resolvedPaths.add(resolved.path);
      results.push({
        tag,
        version,
        mod: resolved.mod,
        java: resolved.java,
        source: 'game-source',
      });
      previousHadConstants = true;
      continue;
    }

    const lookup = baselineLookup(baseline, version);
    if (!lookup) {
      context.log(`[警告] ${tag} 既无源码常量也不在基线规则内，跳过`);
      previousHadConstants = false;
      continue;
    }
    results.push({
      tag,
      version,
      mod: lookup.mod,
      java: lookup.java,
      source: 'baseline',
    });
    previousHadConstants = false;
  }

  const outputs = [];
  for (const type of GATE_TYPES) {
    const typeVersions = results.map((item) => ({
      tag: item.tag,
      version: item.version,
      value: item[type.baselineField],
      source: item.source,
    }));
    const rules = mergeGateRules(typeVersions);
    const nextFile = buildGateFile({
      type: type.key,
      versions: typeVersions,
      rules,
      resolvedPaths: [...resolvedPaths],
      generatedAt: context.now,
    });
    const previousFile = previous[type.key];
    const changed = gateBodyChanged(previousFile, nextFile);
    if (changed && !options.dryRun) {
      await writeJsonAtomic(files[type.key], nextFile);
    }
    outputs.push({ type, versions: typeVersions, rules, changed });
  }

  const changed = outputs.some((output) => output.changed);
  if (changed) {
    for (const { type, versions, rules } of outputs) {
      const sourceCount = versions.filter((item) => item.source === 'game-source').length;
      context.log(
        `[gate] ${type.label}（${type.key}）：${versions.length} 个版本，${rules.length} 条规则，源码常量版本 ${sourceCount} 个`,
      );
      console.log(
        `[gate] ${type.key} 更新：${versions.length} 个版本 / ${rules.length} 条规则，源码命中 ${sourceCount} 个`,
      );
    }
    if (options.dryRun) {
      console.log('[gate] dry-run 未写入');
    }
  } else {
    console.log('[gate] mod/java 门禁均无变化，保留旧文件');
  }
  return { code: 0, changed };
}

// ---------- 入口 ----------

export async function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`参数错误：${error.message}\n`);
      printUsage();
      return 2;
    }
    throw error;
  }
  if (options.help) {
    printUsage();
    return 0;
  }

  // 子集模式会写出「只含所选模组」的 index.json，绝不能落在当前目录（正式仓库根）
  if (
    (options.repos !== null || options.limit !== null) &&
    path.resolve(options.out) === path.resolve(process.cwd())
  ) {
    console.error(
      '参数错误：--repos / --limit 是子集模式，必须用 --out 指定临时输出目录（如 --out tmp/live），不能指向当前目录，避免把正式 index.json 裁剪成子集',
    );
    return 2;
  }

  const startedAt = Date.now();
  const log = options.verbose ? (message) => console.log(message) : () => {};
  const httpLog = options.verbose ? (message) => console.log(`  [http] ${message}`) : null;
  const outDir = path.resolve(options.out);

  if (!options.dryRun && options.datasets.includes('mods')) {
    await ensureReleasesDir(outDir);
  }

  const apiClient = new HttpClient({ token: options.token, logger: httpLog });
  // raw 域名不需要 token，也不该把凭据发过去
  const rawClient = new HttpClient({ token: null, logger: httpLog });
  const context = {
    apiClient,
    rawClient,
    outDir,
    log,
    now: new Date().toISOString(),
    versionsReleases: null,
  };

  let exitCode = 0;
  let modsChanged = 0;
  let modsIndexChanged = false;
  let modsSummaryChanged = false;
  let modsStateChanged = false;
  let versionsChanged = false;
  let gateChanged = false;

  if (options.datasets.includes('mods')) {
    const result = await runMods(options, context);
    exitCode = Math.max(exitCode, result.code);
    modsChanged = result.changed;
    modsIndexChanged = result.indexChanged;
    modsSummaryChanged = result.summaryChanged;
    modsStateChanged = result.stateChanged;
  }
  if (options.datasets.includes('versions')) {
    const result = await runVersions(options, context);
    exitCode = Math.max(exitCode, result.code);
    versionsChanged = result.changed;
    context.versionsReleases = result.releases;
  }
  if (options.datasets.includes('gate')) {
    const result = await runGate(options, context);
    exitCode = Math.max(exitCode, result.code);
    gateChanged = result.changed;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `完成（${options.datasets.join(',')}）：用时 ${elapsed} 秒` +
      (options.datasets.includes('mods')
        ? `，release 文件变化 ${modsChanged} 个、index ${modsIndexChanged ? '已更新' : '未变'}、summary ${modsSummaryChanged ? '已更新' : '未变'}、state ${modsStateChanged ? '已更新' : '未变'}`
        : '') +
      (options.datasets.includes('versions') ? `，versions ${versionsChanged ? '已更新' : '未变'}` : '') +
      (options.datasets.includes('gate') ? `，gate ${gateChanged ? '已更新' : '未变'}` : ''),
  );
  if (options.verbose) {
    const api = apiClient.stats;
    const raw = rawClient.stats;
    console.log(
      `请求统计：API ${api.requests} 次（304 ${api.notModified} 次、重试 ${api.retries} 次、限流等待 ${api.rateLimitWaits} 次），` +
        `raw ${raw.requests} 次，合计 ${api.requests + raw.requests} 次`,
    );
  }
  return exitCode;
}

function printUsage() {
  console.log(USAGE);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`运行失败：${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
