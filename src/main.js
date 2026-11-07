#!/usr/bin/env node
// CLI 入口：按 --datasets 更新模组索引、Mindustry 可用版本列表、最小版本门禁

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { HttpClient, HttpError, RateLimitError, createPool } from './github.js';
import { MODS_URL, fetchModsJson, modIconUrl } from './mods-source.js';
import {
  PER_PAGE,
  fetchAllReleasePages,
  fetchReleasePages,
  normalizeReleases,
  mergeReleaseMetadata,
  mergeReleasesByTag,
  mergeWithShaAndRemovals,
  buildTagOnlyRelease,
  isReleaseEntry,
  sortReleases,
  buildReleasesFile,
} from './releases.js';
import { fetchAllTagEntries, fetchTagPages } from './tags.js';
import { buildCompat, gameVersionsFromFile, latestCompatibleTag } from './compat.js';
import {
  MODEL_V3_FORMAT_VERSION,
  buildV3Versions,
  mergeGameVersionRanges,
  modTypeOf,
  releasesFromVersions,
  summarizeVersions,
} from './model-v3.js';
import {
  COMMUNITY_DIR,
  COMMUNITY_SOURCE,
  COMMUNITY_STATE_REL_PATH,
  buildCommunityIndexEntry,
  buildCommunityMod,
  normalizeCommunityCandidates,
  probeAndFilterCandidates,
} from './community.js';
import {
  TOPIC_QUERY_BASE,
  buildSearchWindows,
  discoverCommunityRepos,
} from './community-source.js';
import { loadBlacklist } from './blacklist.js';
import { fetchModMetadata, fetchModMetadataDocument } from './mod-meta.js';
import { plainFields } from './plain.js';
import { CHANGES_REL_PATH, diffModEntry, diffReleaseFiles, mergeChanges, normalizeChanges } from './changes.js';
import { STATUS_REL_PATH, apiStatus, buildStatus } from './status.js';
import { validateDir } from './validate.js';
import { CURRENT_FORMAT_VERSION, migrateDataDir, needsMigration, migrateReleaseFileData } from './migrate.js';
import {
  DOWNLOAD_WINDOW_WEIGHTS,
  HEAT_COMMIT_STATE_REL_PATH,
  HEAT_CREATED_STATE_REL_PATH,
  COMMUNITY_FULL_INDEX_REL_PATH,
  FULL_INDEX_REL_PATH,
  HEAT_FORMAT_VERSION,
  HEAT_HISTORY_DIR,
  HEAT_INDEX_REL_PATH,
  HEAT_RECOMMEND_CSV_REL_PATH,
  HEAT_RECOMMEND_REL_PATH,
  HEAT_SUMMARY_REL_PATH,
  HEAT_WINDOWS,
  UPDATE_WINDOWS,
  RECOMMEND_DEFAULTS,
  HISTORY_LIMITS,
  HEAT_SUMMARY_COLUMNS,
  buildSnapshot,
  commitsInWindow,
  computeHeat,
  daysBetween,
  daysSinceLastCommit,
  earliestReleasePublishedAt,
  findSnapshotAtOrBefore,
  formatDateKey,
  formatMonthKey,
  formatWeekKey,
  heatSummaryRow,
  heatIndexFields,
  heatSummaryFields,
  recommendationFor,
  injectHeatIntoIndex,
  injectHeatIntoSummaryRows,
  latestReleasePublishedAt,
  maintenanceStatus,
  percentileRanks,
  releaseUpdatesInWindow,
  round4,
  selectHistoryFiles,
  snapshotValue,
} from './heat.js';
import { computeModStats } from './stats.js';
import {
  buildSummary,
  summaryBodyChanged,
  summaryCsv,
  csvEscape,
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
  releasesDirRelPath,
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
  readReleasePages,
  writeReleasePages,
  deleteReleaseData,
  pagesForFile,
  needsPageSplit,
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

const DATASETS = ['mods', 'community', 'heat', 'versions', 'gate'];

const USAGE = `用法：node src/main.js [选项]

选项：
  --datasets <列表>   要更新的数据集，逗号分隔：mods,community,heat,versions,gate，默认 mods
  --out <目录>        产物目录，默认 .
  --token <token>     GitHub token，默认读环境变量 GITHUB_TOKEN
  --repos a/b,c/d     只跑指定仓库（仅 mods 数据集，本地验证用）
  --limit <n>         最多处理 n 个模组（仅 mods 数据集）
  --community-limit <n>        社区模组最多处理 n 个（仅 community，本地验证用）
  --community-search-windows <n> 只搜前 n 个时间窗（仅 community，本地验证用）
  --community-max-candidates <n> 最多探测 n 个候选仓库（仅 community，本地验证用）
  --heat-max-api <n>  heat 数据集最多发 n 次 participation/created_at API（0=完全离线，本地验证用）
  --threads <n>       同时处理的仓库数，默认 8
  --raw-threads <n>   raw.githubusercontent 并发数，默认 16
  --versions-pages <n>  只抓 Mindustry 版本列表前 n 页（仅本地验证，正式运行不要用）
  --versions-file <路径> 门禁用本地版本快照当输入（如启动器 remote/mindustry_versions.json）
  --no-cache          忽略旧产物，全量重抓（不使用 ETag、不复用旧数据）
  --keep-missing-files  不删除官方列表中已消失模组的 releases/*.json（仅 mods）
  --migrate           只做 schemaVersion 1→2 本地迁移（0 API），迁移旧文件/index/summary/status/changes
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
    communityLimit: null,
    communitySearchWindows: null,
    communityMaxCandidates: null,
    heatMaxApi: null,
    cache: true,
    keepMissingFiles: false,
    migrate: false,
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
      case '--community-limit':
        options.communityLimit = requirePositiveInt('--community-limit', takeValue());
        break;
      case '--community-search-windows':
        options.communitySearchWindows = requirePositiveInt(
          '--community-search-windows',
          takeValue(),
        );
        break;
      case '--community-max-candidates':
        options.communityMaxCandidates = requirePositiveInt(
          '--community-max-candidates',
          takeValue(),
        );
        break;
      case '--heat-max-api': {
        const value = takeValue();
        if (!/^\d+$/.test(value)) {
          throw new UsageError(`--heat-max-api 需要非负整数，收到：${value}`);
        }
        options.heatMaxApi = Number(value);
        break;
      }
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
      case '--migrate':
        options.migrate = true;
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
  if (
    (options.communityLimit !== null ||
      options.communitySearchWindows !== null ||
      options.communityMaxCandidates !== null) &&
    !options.datasets.includes('community')
  ) {
    throw new UsageError(
      '--community-limit / --community-search-windows / --community-max-candidates 只用于 community 数据集',
    );
  }
  if (options.heatMaxApi !== null && !options.datasets.includes('heat')) {
    throw new UsageError('--heat-max-api 只用于 heat 数据集');
  }
  return options;
}

// ---------- mods 数据集 ----------

export function buildIndexEntry(
  mod,
  file,
  {
    relPath,
    oldEntry = null,
    stats: providedStats = null,
    compat = null,
    gameVersions = [],
    modType = null,
    repoStats = null,
  } = {},
) {
  const hasFile = Array.isArray(file?.releases) || Array.isArray(file?.versions);
  const releases = Array.isArray(file?.releases)
    ? file.releases
    : Array.isArray(file?.versions)
      ? releasesFromVersions(file)
      : [];
  const meta = file?.meta && typeof file.meta === 'object' ? file.meta : null;
  const effectiveModType = modType ?? file?.modType ?? oldEntry?.modType ?? 'json';
  const versions = Array.isArray(file?.versions) ? file.versions : [];
  const summary = summarizeVersions(versions);
  const stats = providedStats ?? computeModStats(releases, effectiveModType === 'java');
  const plain = plainFields({
    name: meta?.name ?? oldEntry?.name ?? mod.name,
    author: meta?.author ?? oldEntry?.author ?? mod.author,
    description: meta?.description ?? oldEntry?.descriptionPlain ?? mod.description,
  });
  const latestRelease = releases.find((entry) => entry.removed !== true) ?? releases[0] ?? null;
  const latestVersion = versions.find((item) => item.removed !== true) ?? versions[0] ?? null;
  const releaseCount = hasFile
    ? summary.releaseCount
    : typeof oldEntry?.releaseCount === 'number'
      ? oldEntry.releaseCount
      : 0;
  const tagCount = hasFile
    ? summary.tagCount
    : typeof oldEntry?.tagCount === 'number'
      ? oldEntry.tagCount
      : releaseCount;
  const releaseUpdatedAt =
    summary.releaseUpdatedAt ??
    latestRelease?.publishedAt ??
    oldEntry?.releaseUpdatedAt ??
    null;
  const commitUpdatedAt =
    repoStats?.pushedAt ?? oldEntry?.commitUpdatedAt ?? null;
  const minGameVersion =
    latestVersion?.minGameVersion ??
    meta?.minGameVersion ??
    oldEntry?.minGameVersion ??
    mod.minGameVersion ??
    null;
  const gameVersionRanges = hasFile
    ? summary.gameVersionRanges
    : (oldEntry?.gameVersionRanges ?? []);
  const pages =
    Array.isArray(file?.pages) && file.pages.length > 0
      ? file.pages
      : Array.isArray(oldEntry?.pages) && oldEntry.pages.length > 0
        ? oldEntry.pages
        : hasFile
          ? [
              {
                page: 1,
                count: summary.totalVersions ?? versions.length,
                gameVersionRanges: summary.gameVersionRanges ?? [],
                path: relPath,
              },
            ]
          : [];
  // 单页文件可能没有 page.gameVersionRanges（旧数据/未处理缓存），用模组级区间补全
  const normalizedPages = pages.map((page) =>
    page.page === 1 &&
    (!Array.isArray(page.gameVersionRanges) || page.gameVersionRanges.length === 0) &&
    Array.isArray(summary.gameVersionRanges) &&
    summary.gameVersionRanges.length > 0
      ? { ...page, gameVersionRanges: summary.gameVersionRanges }
      : page,
  );
  const result = {
    repo: mod.repo,
    internalName: mod.internalName ?? null,
    name: meta?.name ?? mod.name ?? null,
    namePlain: plain.namePlain,
    author: meta?.author ?? mod.author ?? null,
    authorPlain: plain.authorPlain,
    descriptionPlain: plain.descriptionPlain,
    version: latestVersion?.modVersion ?? meta?.version ?? oldEntry?.version ?? mod.version ?? null,
    minGameVersion,
    modType: effectiveModType,
    gameVersionRanges,
    stars: Number(repoStats?.stars ?? mod.stars) || 0,
    hasIcon: mod.hasIcon,
    iconUrl: modIconUrl(mod.repo, mod.hasIcon),
    iconHash: mod.iconHash ?? null,
    releasesPath: normalizedPages[0]?.path ?? (hasFile ? relPath : (oldEntry?.releasesPath ?? (file ? relPath : null))),
    ...(normalizedPages.length > 0 ? { pages: normalizedPages } : {}),
    releaseCount,
    ...(effectiveModType === 'java' ? {} : { tagCount }),
    releaseUpdatedAt,
    commitUpdatedAt,
    totalDownloads: stats.totalDownloads,
    allAssetsDownloads: stats.allAssetsDownloads,
    releaseDataUpdatedAt: file?.generatedAt ?? oldEntry?.releaseDataUpdatedAt ?? null,
  };
  if (result.internalName === null) delete result.internalName;
  return result;
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

function unprocessedModResult({ mod, previous, modState, relPath, oldEntry, reason, buildEntry = buildIndexEntry, repoStats = null }) {
  const oldStats =
    oldEntry && typeof oldEntry.totalDownloads === 'number'
      ? {
          totalDownloads: oldEntry.totalDownloads ?? 0,
          allAssetsDownloads: oldEntry.allAssetsDownloads ?? 0,
        }
      : null;
  return {
    entry: buildEntry(mod, previous, { relPath, oldEntry, repoStats, ...(oldStats ? { stats: oldStats } : {}) }),
    file: previous,
    state: modState ?? null,
    skipped: null,
    changed: false,
    unprocessed: true,
    hasOldEntry: Boolean(oldEntry),
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
    dataset = {},
  } = context;
  // 官方 / 社区共用同一套抓取与合并逻辑，只切换输出目录与 index 条目构造器
  const workDir = dataset.outDir ?? outDir;
  const buildEntry = dataset.buildEntry ?? buildIndexEntry;
  const allowLegacy = dataset.allowLegacy !== false;
  const relPath = releasesRelPath(mod.repo);
  const legacyRelPath = releasesLegacyRelPath(mod.repo);
  const oldEntry = oldEntries.get(mod.repo.toLowerCase()) ?? null;
  const hasJava = mod.hasJava === true;

  let previous = null;
  let legacyToDelete = null;
  if (options.cache) {
    try {
      const paged = await readReleasePages(workDir, mod.repo).catch(() => null);
      if (paged) {
        previous = paged;
      } else {
        const newFile = await readJsonIfExists(resolveReleaseFile(workDir, relPath));
        // v3 文件落盘只有 versions[]（releases 是内存视图），两种形状都要能读回缓存
        if (
          newFile &&
          newFile.repo === mod.repo &&
          (Array.isArray(newFile.releases) || Array.isArray(newFile.versions))
        ) {
          previous = newFile;
        }
      }
    } catch (error) {
      log(`[警告] ${mod.repo} 的新路径数据不可用：${error.message}`);
    }
    if (!previous && allowLegacy) {
      // 兼容旧 flat 路径：读出来当缓存，本轮迁到 releases/<owner>/<repo>.json 后删除旧文件
      try {
        const legacyFile = await readJsonIfExists(
          resolveReleaseFileForDelete(workDir, legacyRelPath),
        );
        if (
          legacyFile &&
          legacyFile.repo === mod.repo &&
          (Array.isArray(legacyFile.releases) || Array.isArray(legacyFile.versions))
        ) {
          previous = legacyFile;
          legacyToDelete = legacyRelPath;
        }
      } catch (error) {
        log(`[警告] ${mod.repo} 的旧 flat 数据不可用：${error.message}`);
      }
    }
  }
  // 已是 v3 的缓存：补一个内部 releases 视图，继续复用刷新/合并逻辑
  if (previous?.versions && !Array.isArray(previous.releases)) {
    Object.defineProperty(previous, 'releases', {
      value: releasesFromVersions(previous),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  // schemaVersion 迁移：旧文件（formatVersion < 3）用已有缓存本地重算新字段并重写，不额外发 API；
  // 即使本次刷新不到期 / 配额不足，也先完成迁移，避免新代码读旧结构一直报错。
  if (previous && needsMigration(previous)) {
    const migrated = migrateReleaseFileData({
      repo: mod.repo,
      previous,
      compatData: context.compatData ?? null,
      now,
      hasJava,
    });
    // v1 用旧缓存直接本地迁移即可；v2→v3 迁移后继续本轮刷新（tags/release 计划照常）
    if (previous.formatVersion < 2 || previous.formatVersion === undefined) {
      if (!options.dryRun) {
        migrated.pages = await writeReleasePages(workDir, mod.repo, migrated);
        if (legacyToDelete !== null) {
          await deleteReleaseFile(workDir, legacyToDelete);
        }
      }
      const migratedHasJava = migrated.meta ? migrated.meta.hasJava === true : hasJava;
      log(`[${mod.repo}] formatVersion ${previous.formatVersion ?? 1} → ${CURRENT_FORMAT_VERSION} 本地迁移（0 API）`);
      return {
        entry: buildEntry(mod, migrated, {
          relPath,
          oldEntry,
          stats: computeModStats(migrated.releases, migratedHasJava),
          compat: [],
          gameVersions: context.compatData?.gameVersions ?? [],
          modType: migrated.modType,
          repoStats: context.repoStats?.get(mod.repo.toLowerCase()) ?? null,
        }),
        file: migrated,
        previousFile: previous,
        state: previousState.mods[mod.repo] ?? null,
        skipped: null,
        changed: true,
        unprocessed: false,
        changes: [],
        migrated: true,
      };
    }
    migrated.source = previous.source ?? null;
    // v2→v3 迁移后先落盘：即使本轮配额不足、刷新被跳过，也不会留下 v2 文件与 v3 index 混用
    if (!options.dryRun) {
      migrated.pages = await writeReleasePages(workDir, mod.repo, migrated);
      if (legacyToDelete !== null) {
        await deleteReleaseFile(workDir, legacyToDelete);
      }
    }
    previous = migrated;
    log(`[${mod.repo}] formatVersion 2 → ${CURRENT_FORMAT_VERSION} 本地迁移后继续刷新`);
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
      buildEntry,
      repoStats: context.repoStats?.get(mod.repo.toLowerCase()) ?? null,
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
    let fullTagEntries = null;
    if (plan.full) {
      releasePageResults = await fetchAllReleasePages(apiClient, mod.repo);
      const tagAll = await fetchAllTagEntries(apiClient, mod.repo);
      fullTagEntries = tagAll.entries;
      tagPageResults = [
        {
          page: 1,
          entries: tagAll.entries,
          names: tagAll.entries.map((entry) => entry.name),
          complete: true,
        },
      ];
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

    // 合并条目：全量时以本次抓到的 release 为准（旧 tag-only 也先放进来保留元数据）；
    // 否则按 tag 合并保留没抓的旧页。旧文件没有 hasRelease 字段 → 统一补成 true（一次性迁移）
    let entries = plan.full
      ? metaMerged.releases.map((release) => ({ ...release, hasRelease: true }))
      : mergeReleasesByTag(previous?.releases ?? [], metaMerged.releases).map(
          (release) => (isReleaseEntry(release) ? { ...release, hasRelease: true } : release),
        );
    if (plan.full) {
      for (const oldEntry of previous?.releases ?? []) {
        if (!isReleaseEntry(oldEntry) && typeof oldEntry.tag === 'string') {
          entries.push({ ...oldEntry });
        }
      }
    }

    // 新 tag-only：上游 tags 里有、当前条目里没有的 tag
    const fetchedTagEntries = plan.full
      ? fullTagEntries
      : tagPageResults.flatMap((page) =>
          Array.isArray(page.entries)
            ? page.entries
            : page.names.map((name) => ({ name, commitSha: null })),
        );
    const presentTags = new Set(entries.map((entry) => entry.tag));
    const newTagNames = [];
    for (const tagEntry of fetchedTagEntries) {
      if (!presentTags.has(tagEntry.name)) {
        presentTags.add(tagEntry.name);
        newTagNames.push(tagEntry.name);
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

    // commit sha + 删除留档（只在本轮确实做了全量刷新时判断“缺失=被删”）
    const tagsFetched = tagPageResults.length > 0;
    const partialTagEntries = plan.full ? [] : fetchedTagEntries;
    entries = mergeWithShaAndRemovals({
      repo: mod.repo,
      entries,
      previousEntries: previous?.releases ?? [],
      fullTagEntries: plan.full ? fullTagEntries : null,
      partialTagEntries,
      fullReleaseTags: plan.full
        ? new Set(metaMerged.releases.map((release) => release.tag))
        : null,
      removedAt: now,
    });

    // v3：缺 minGameVersion 的旧条目先补抓 mod 元数据（raw，不走 API 配额），每轮每 mod 限量
    const MIN_RECRAWL_PER_RUN = 10;
    const missingMetaEntries = entries
      .filter(
        (entry) =>
          entry?.tag &&
          !entry.minGameVersion &&
          entry.metadataStatus !== 'ok',
      )
      .slice(0, MIN_RECRAWL_PER_RUN);
    let metadataRecrawled = 0;
    if (missingMetaEntries.length > 0) {
      await Promise.all(
        missingMetaEntries.map(async (entry) => {
          try {
            const metadata = await rawPool.run(() =>
              fetchModMetadata(rawClient, {
                repo: mod.repo,
                tag: entry.tag,
                hasJava,
              }),
            );
            if (metadata.metadataStatus === 'ok' && metadata.minGameVersion) {
              entry.minGameVersion = metadata.minGameVersion;
              entry.modVersion = metadata.modVersion ?? entry.modVersion;
              entry.metadataPath = metadata.metadataPath;
              entry.metadataStatus = 'ok';
              metadataRecrawled += 1;
            }
          } catch {
            // 单条失败忽略，下次继续
          }
        }),
      );
    }

    // 预计算「游戏版本 → 推荐 tag」兼容区间（官方/社区同构）
    const compatData = context.compatData ?? null;
    const compat = compatData
      ? buildCompat({
          entries,
          gameVersions: compatData.gameVersions,
          gateFile: hasJava ? compatData.javaGate : compatData.modGate,
        })
      : Array.isArray(previous?.compat)
        ? previous.compat
        : [];

    // C8：最新 tag 的完整 mod 元数据 → per-mod meta（拿不到保持 null）
    const latestEntry =
      entries.find((entry) => entry.removed !== true && isReleaseEntry(entry)) ??
      entries.find((entry) => entry.removed !== true) ??
      entries[0] ??
      null;
    let fileMeta = null;
    if (latestEntry) {
      try {
        const metaResult = await fetchModMetadataDocument(rawClient, {
          repo: mod.repo,
          tag: latestEntry.tag,
          hasJava,
        });
        fileMeta = metaResult.found ? metaResult.meta : null;
      } catch (error) {
        log(`[警告] ${mod.repo} 最新 tag 元数据读取失败：${error.message}`);
      }
    }
    const effectiveHasJava = fileMeta ? fileMeta.hasJava === true : hasJava;
    const modelGameVersions = compatData?.gameVersions ?? [];
    const modType = modTypeOf({ meta: fileMeta, releases: entries });
    const gateFile = modType === 'java' ? compatData?.javaGate : compatData?.modGate;

    const nextFile = buildReleasesFile({
      repo: mod.repo,
      releases: entries,
      meta: fileMeta,
      modType,
      gameVersions: modelGameVersions,
      gateFile,
      generatedAt: now,
    });
    if (!releaseFileBodyChanged(previous, nextFile) && previous?.generatedAt) {
      nextFile.generatedAt = previous.generatedAt;
    }
    const changed = releaseFileBodyChanged(previous, nextFile);
    const needsSplit = await needsPageSplit(workDir, mod.repo, nextFile);
    const shouldWrite = changed || legacyToDelete !== null || needsSplit;
    if (shouldWrite && !options.dryRun) {
      nextFile.pages = await writeReleasePages(workDir, mod.repo, nextFile);
      if (legacyToDelete !== null) {
        await deleteReleaseFile(workDir, legacyToDelete);
        log(`[${mod.repo}] 旧 flat 文件已迁移到 ${relPath}`);
      }
    }
    const finalFile = shouldWrite ? nextFile : (previous ?? nextFile);

    // B5：release/tag 级变更（首次建立 changes.json 时只记初始快照，避免一次刷出上千条）
    const datasetName = dataset.name ?? 'official';
    const changes = diffReleaseFiles({
      dataset: datasetName,
      repo: mod.repo,
      previousFile: previous,
      currentFile: finalFile,
      at: now,
      namePlain: plainFields(mod).namePlain,
      initialSnapshot: context.initialChanges === true,
    });

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
    const removedCount = nextFile.releases.filter((entry) => entry.removed === true).length;
    if (changed) {
      log(
        `[${mod.repo}] ${nextFile.releases.length} 个 tag（${releaseEntryCount} 个有 Release，${removedCount} 个已删除留档），compat ${compat.length} 段，元数据新抓 ${metaMerged.metaFetched} 个、复用 ${metaMerged.metaReused} 个${options.dryRun ? '（dry-run 未写入）' : ''}`,
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
      entry: buildEntry(mod, finalFile, {
        relPath,
        oldEntry,
        // 缓存命中且文件未变时复用旧统计，避免从合成 releases 重算导致下载量漂移
        stats:
          !changed && oldEntry && typeof oldEntry.totalDownloads === 'number'
            ? {
                totalDownloads: oldEntry.totalDownloads ?? 0,
                allAssetsDownloads: oldEntry.allAssetsDownloads ?? 0,
              }
            : computeModStats(finalFile?.releases ?? [], effectiveHasJava),
        compat: finalFile?.compat ?? [],
        gameVersions: compatData?.gameVersions ?? [],
        modType: finalFile?.modType ?? modType,
        repoStats: context.repoStats?.get(mod.repo.toLowerCase()) ?? null,
      }),
      file: finalFile,
      previousFile: previous,
      state: nextState,
      skipped: null,
      changed,
      unprocessed: false,
      changes,
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
          meta: previous.meta ?? null,
          modType: previous.modType ?? 'json',
          gameVersions: context.compatData?.gameVersions ?? [],
          gateFile: previous.modType === 'java'
            ? context.compatData?.javaGate
            : context.compatData?.modGate,
          generatedAt: previous.generatedAt ?? now,
        });
        finalFile.pages = await writeReleasePages(workDir, mod.repo, finalFile);
        await deleteReleaseFile(workDir, legacyToDelete);
        log(`[${mod.repo}] 旧 flat 文件已迁移到 ${relPath}（本次抓取失败，保留旧数据）`);
      } catch (migrationError) {
        log(`[警告] ${mod.repo} 迁移旧路径失败：${migrationError.message}`);
        finalFile = previous;
      }
    }
    const catchHasJava = finalFile?.meta ? finalFile.meta.hasJava === true : hasJava;
    return {
      entry: buildEntry(mod, finalFile, {
        relPath,
        oldEntry,
        stats:
          oldEntry && typeof oldEntry.totalDownloads === 'number'
            ? {
                totalDownloads: oldEntry.totalDownloads ?? 0,
                allAssetsDownloads: oldEntry.allAssetsDownloads ?? 0,
              }
            : computeModStats(finalFile?.releases ?? [], catchHasJava),
        compat: finalFile?.compat ?? [],
        gameVersions: context.compatData?.gameVersions ?? [],
        modType: finalFile?.modType ?? oldEntry?.modType ?? 'json',
        repoStats: context.repoStats?.get(mod.repo.toLowerCase()) ?? null,
      }),
      file: finalFile,
      previousFile: previous,
      state: previousState.mods[mod.repo],
      skipped: { repo: mod.repo, reason: skipReason(error) },
      changed: false,
      unprocessed: false,
      hasOldEntry: Boolean(oldEntry),
    };
  }
}

async function readOldIndex(outDir, log) {
  try {
    // 全量列表包含隐藏模组；优先读它，避免未处理/过滤条目被当首次出现
    const full = await readJsonIfExists(path.join(outDir, FULL_INDEX_REL_PATH)).catch(() => null);
    if (full && Array.isArray(full.mods)) {
      return full;
    }
    return await readJsonIfExists(path.join(outDir, INDEX_FILE));
  } catch (error) {
    log(`[警告] 旧 index.json 不可用，按首次运行处理：${error.message}`);
    return null;
  }
}

async function cleanupMissing(outDir, selected, log) {
  const keepSingles = new Set(selected.map((mod) => releasesRelPath(mod.repo)));
  const keepDirs = selected.map((mod) => `${releasesDirRelPath(mod.repo)}/`);
  const existing = await listReleaseFiles(outDir);
  let removed = 0;
  for (const relPath of existing) {
    if (keepSingles.has(relPath)) {
      continue;
    }
    if (keepDirs.some((prefix) => relPath.startsWith(prefix))) {
      continue;
    }
    if (await deleteReleaseFile(outDir, relPath)) {
      removed += 1;
    }
  }
  if (removed > 0) {
    log(`清理 ${removed} 个已不在官方列表中的 releases 文件`);
  }
}

async function loadRefreshState(outDir, log, relPath = REFRESH_STATE_REL_PATH) {
  const file = path.join(outDir, relPath);
  try {
    const raw = await readJsonIfExists(file);
    return { file, exists: raw !== null, state: normalizeRefreshState(raw) };
  } catch (error) {
    log(`[警告] ${relPath} 不可用，按首次运行处理：${error.message}`);
    return { file, exists: false, state: normalizeRefreshState(null) };
  }
}

// B5：读取上一份 changes.json（不存在 = 首次建立，只记初始快照）
async function loadChanges(outDir, log) {
  try {
    const raw = await readJsonIfExists(path.join(outDir, CHANGES_REL_PATH));
    return { exists: raw !== null, changes: normalizeChanges(raw) };
  } catch (error) {
    log(`[警告] ${CHANGES_REL_PATH} 不可用，按首次运行处理：${error.message}`);
    return { exists: false, changes: [] };
  }
}

// 兼容区间需要游戏版本列表 + 两份门禁（官方数据目录下）
async function loadRepoStats(outDir, log) {
  const relPath = 'state/repo-stats.json';
  const map = new Map();
  try {
    const file = await readJsonIfExists(path.join(outDir, relPath));
    for (const [repo, stats] of Object.entries(file?.repos ?? {})) {
      if (stats && typeof stats === 'object') {
        map.set(repo.toLowerCase(), stats);
      }
    }
  } catch (error) {
    log(`[警告] ${relPath} 不可用，repo 统计留空：${error.message}`);
  }
  return map;
}

// state/repo-stats.json：每周刷新 stars/archived/created_at/pushed_at；配额不足优雅停止并保留缓存
async function refreshRepoStats({ outDir, apiClient, repos, log }) {
  const relPath = 'state/repo-stats.json';
  const statePath = path.join(outDir, relPath);
  let previous = null;
  try {
    previous = await readJsonIfExists(statePath);
  } catch {}
  const reposMap = previous?.repos && typeof previous.repos === 'object' ? { ...previous.repos } : {};
  const nowMs = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  let fetched = 0;
  let changed = false;
  const ordered = [...new Set((repos ?? []).filter(Boolean))].sort((left, right) => {
    const a = Date.parse(reposMap[left]?.fetchedAt ?? '') || 0;
    const b = Date.parse(reposMap[right]?.fetchedAt ?? '') || 0;
    return a - b;
  });
  for (const repo of ordered) {
    const old = reposMap[repo];
    if (old?.fetchedAt && nowMs - Date.parse(old.fetchedAt) < weekMs) {
      continue;
    }
    if (apiClient?.hasLowQuota?.(5)) {
      log('[repo-stats] API 配额不足，剩下次继续');
      break;
    }
    try {
      const response = await apiClient.get(`https://api.github.com/repos/${repo}`);
      if (response.status === 404) {
        reposMap[repo] = { ...old, fetchedAt: new Date(nowMs).toISOString(), missing: true };
        changed = true;
        continue;
      }
      if (response.status !== 200) {
        if (response.status === 403 || response.status === 429) {
          log('[repo-stats] 限流，剩下次继续');
          break;
        }
        continue;
      }
      const data = JSON.parse(response.text);
      reposMap[repo] = {
        stars: Number.isInteger(data.stargazers_count) ? data.stargazers_count : 0,
        archived: data.archived === true,
        createdAt: typeof data.created_at === 'string' ? data.created_at : null,
        pushedAt: typeof data.pushed_at === 'string' ? data.pushed_at : null,
        fetchedAt: new Date(nowMs).toISOString(),
      };
      fetched += 1;
      changed = true;
    } catch {
      // 网络失败：下次继续
    }
  }
  if (changed && !apiClient?.dryRun) {
    await writeJsonAtomic(statePath, {
      formatVersion: 1,
      updatedAt: new Date(nowMs).toISOString(),
      repos: reposMap,
    });
  }
  if (fetched > 0) log(`[repo-stats] 刷新 ${fetched} 个仓库（stars/pushed_at/created_at/archived）`);
  const map = new Map();
  for (const [repo, stats] of Object.entries(reposMap)) {
    if (stats && typeof stats === 'object') map.set(repo.toLowerCase(), stats);
  }
  return map;
}

async function loadCompatData(outDir, log) {
  let versionsFile = null;
  let modGate = null;
  let javaGate = null;
  try {
    versionsFile = await readJsonIfExists(path.join(outDir, VERSIONS_REL_PATH));
  } catch (error) {
    log(`[警告] ${VERSIONS_REL_PATH} 不可用，compat 将为空：${error.message}`);
  }
  try {
    modGate = await readJsonIfExists(path.join(outDir, GATE_REL_PATHS.mod));
  } catch (error) {
    log(`[警告] ${GATE_REL_PATHS.mod} 不可用，compat 将为空：${error.message}`);
  }
  try {
    javaGate = await readJsonIfExists(path.join(outDir, GATE_REL_PATHS.java));
  } catch (error) {
    log(`[警告] ${GATE_REL_PATHS.java} 不可用，compat 将为空：${error.message}`);
  }
  return {
    gameVersions: gameVersionsFromFile(versionsFile),
    modGate,
    javaGate,
  };
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
  const compatData = await loadCompatData(outDir, log);
  // 全量运行时刷新 repo 统计（stars/pushed_at 等，每周档）；--repos 子集只读缓存，避免额外 API。
  const repoStats = options.repos === null
    ? await refreshRepoStats({
        outDir,
        apiClient,
        repos: selected.map((mod) => mod.repo),
        log,
      })
    : await loadRepoStats(outDir, log);

  const rawPool = createPool(options.rawThreads);
  const apiPool = createPool(options.threads);
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const resultsByRepo = new Map();
  // API 配额不足时：停止发新请求、保留已抓结果、exit 0；未处理的模组下次按「最久未刷新」优先
  const abortState = context.abortState ?? { aborted: false, reason: null };
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
          compatData,
          repoStats,
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
  // v3：一条版本都不剩的模组从 index 移除并删除 per-mod 文件（缺元数据已在 processMod 先补抓）
  const droppedResults = results.filter(
    (result) =>
      result.entry &&
      (result.entry.releaseCount ?? 0) === 0 &&
      (result.entry.tagCount ?? 0) === 0 &&
      // 未处理/抓取失败但已有旧条目的模组保留（否则低配额会误删），全新且无数据的才丢弃
      !((result.unprocessed === true || result.skipped) && result.hasOldEntry === true),
  );
  const keptResults = results.filter((result) => !droppedResults.includes(result));
  if (droppedResults.length > 0) {
    if (!options.dryRun) {
      for (const result of droppedResults) {
        try {
          await deleteReleaseData(outDir, result.entry.repo);
        } catch {}
      }
    }
    log(`[mods] v3 丢弃 ${droppedResults.length} 个没有任何可用版本的模组`);
  }
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

  // v3：全量写 index-full.json，默认列表（默认=全量，heat 注入时再按 recommendVisible 拆分）
  let indexChanged = false;
  const fullIndex = {
    formatVersion: 3,
    generatedAt: now,
    source: {
      modsUrl: MODS_URL,
      modCount: keptResults.length,
    },
    mods: keptResults.map((result) => result.entry),
    skipped,
  };
  if (!options.dryRun) {
    const fullIndexPath = path.join(outDir, FULL_INDEX_REL_PATH);
    const previousFullIndex = await readJsonIfExists(fullIndexPath).catch(() => null);
    if (indexBodyChanged(previousFullIndex, fullIndex)) {
      await writeJsonAtomic(fullIndexPath, fullIndex);
      indexChanged = true;
    }
    const indexPath = path.join(outDir, INDEX_FILE);
    if (indexBodyChanged(oldIndex, fullIndex)) {
      await writeJsonAtomic(indexPath, fullIndex);
      indexChanged = true;
    }
  }

  if (!options.dryRun && !options.keepMissingFiles && !isSubset) {
    await cleanupMissing(outDir, selected, log);
  }

  // 总表：基于合并后的完整 releases 聚合
  const summaryRows = keptResults.map((result) => ({
    repo: result.entry.repo,
    name: result.entry.name,
    namePlain: result.entry.namePlain ?? '',
    author: result.entry.author,
    stars: result.entry.stars,
    modType: result.entry.modType,
    releaseCount: result.entry.releaseCount,
    ...(result.entry.modType === 'java' ? {} : { tagCount: result.entry.tagCount }),
    totalDownloads: result.entry.totalDownloads,
    allAssetsDownloads: result.entry.allAssetsDownloads,
    minGameVersion: result.entry.minGameVersion,
    gameVersionRanges: JSON.stringify(result.entry.gameVersionRanges ?? []),
    releaseUpdatedAt: result.entry.releaseUpdatedAt,
    commitUpdatedAt: result.entry.commitUpdatedAt,
    iconUrl: result.entry.iconUrl,
    releasesPath: result.entry.releasesPath,
  }));
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
  const modChanges = [];
  for (const [index, mod] of selected.entries()) {
    const result = results[index];
    if (!result) {
      continue;
    }
    const namePlain = result.entry?.namePlain ?? '';
    if (context.initialChanges) {
      // 首次建立 changes.json：只记初始快照（批量 mod-added，最终由滚动上限截断）
      modChanges.push({
        at: now,
        dataset: 'official',
        repo: mod.repo,
        action: 'mod-added',
        ...(namePlain ? { namePlain } : {}),
      });
    } else {
      modChanges.push(
        ...diffModEntry({
          dataset: 'official',
          repo: mod.repo,
          previousEntry: oldEntries.get(mod.repo.toLowerCase()) ?? null,
          currentEntry: result.entry,
          at: now,
          namePlain,
        }),
      );
    }
    modChanges.push(...(result.changes ?? []));
  }
  const stats = {
    updatedAt: now,
    modCount: selected.length,
    releaseCount: results.reduce((sum, result) => sum + (result.entry?.releaseCount ?? 0), 0),
    skipped,
  };
  return {
    code: 0,
    changed,
    indexChanged,
    summaryChanged: summaryChanged || csvChanged,
    stateChanged,
    unprocessed: notProcessedCount,
    changes: modChanges,
    stats,
  };
}

// ---------- community 数据集 ----------

function isCommunityLimited(options) {
  return (
    options.communityLimit !== null ||
    options.communitySearchWindows !== null ||
    options.communityMaxCandidates !== null
  );
}

function communitySummaryRows(results) {
  return results.map((result) => ({
    repo: result.entry.repo,
    name: result.entry.name,
    namePlain: result.entry.namePlain ?? '',
    author: result.entry.author,
    stars: result.entry.stars,
    modType: result.entry.modType,
    releaseCount: result.entry.releaseCount,
    ...(result.entry.modType === 'java' ? {} : { tagCount: result.entry.tagCount }),
    totalDownloads: result.entry.totalDownloads,
    allAssetsDownloads: result.entry.allAssetsDownloads,
    minGameVersion: result.entry.minGameVersion,
    gameVersionRanges: JSON.stringify(result.entry.gameVersionRanges ?? []),
    releaseUpdatedAt: result.entry.releaseUpdatedAt,
    commitUpdatedAt: result.entry.commitUpdatedAt,
    iconUrl: result.entry.iconUrl,
    releasesPath: result.entry.releasesPath,
  }));
}

// 社区模组：topic 搜索发现 → 黑名单/官方去重/收录标准过滤 → 与官方同构的 per-mod 抓取与 2h/周/月刷新
async function runCommunity(options, context) {
  const { apiClient, rawClient, outDir, log } = context;
  const communityDir = path.join(outDir, COMMUNITY_DIR);
  const abortState = context.abortState ?? { aborted: false, reason: null };

  let officialMods;
  try {
    officialMods = await fetchModsJson(rawClient);
  } catch (error) {
    console.error(`无法获取官方模组列表（社区去重用）：${error.message}`);
    return { code: 1, changed: 0 };
  }
  const officialRepos = new Set(officialMods.map((mod) => mod.repo.toLowerCase()));

  const { blacklist } = await loadBlacklist({ rawClient, outDir, log, now: Date.now() });

  if (abortState.aborted || apiClient.hasLowQuota?.(5)) {
    if (!abortState.aborted) {
      abortState.aborted = true;
      abortState.reason = 'quota';
    }
    console.warn('[社区] API 配额不足，本次跳过社区模组，下次继续');
    return { code: 0, changed: 0, unprocessed: 0, community: true };
  }

  const limited = isCommunityLimited(options);
  const allWindows = buildSearchWindows();
  const windows =
    options.communitySearchWindows !== null
      ? allWindows.slice(0, options.communitySearchWindows)
      : allWindows;
  const throttleMs = limited ? 0 : 2000;
  let discovery;
  try {
    discovery = await discoverCommunityRepos(apiClient, {
      windows,
      maxCandidates: options.communityMaxCandidates,
      throttleMs,
      log,
    });
  } catch (error) {
    console.error(`社区模组发现失败：${error.message}`);
    return { code: 1, changed: 0 };
  }
  const candidates = normalizeCommunityCandidates(discovery.candidates);
  console.log(
    `[community] 搜索到 ${candidates.length} 个候选仓库（搜索请求 ${discovery.stats.requests} 次、${discovery.stats.windows} 个时间窗、去重 ${discovery.stats.duplicates} 次）`,
  );

  const { eligible, stats } = await probeAndFilterCandidates({
    candidates,
    rawClient,
    apiClient,
    officialRepos,
    blacklist,
    log,
    maxCandidates: options.communityMaxCandidates,
  });
  console.log(
    `[community] 过滤：官方已有 ${stats.official}、归档 ${stats.archived}、模板 ${stats.template}、` +
      `黑名单 ${stats.blacklisted}、无元数据 ${stats.noMetadata}、minGameVersion<136 ${stats.lowVersion}、` +
      `hideBrowser ${stats.hidden}；收录 ${eligible.length}`,
  );

  let selectedMods = eligible.map((item) =>
    buildCommunityMod({
      candidate: item.candidate,
      metadata: item.metadata,
      iconUrl: item.iconUrl,
    }),
  );
  if (options.communityLimit !== null) {
    selectedMods = selectedMods.slice(0, options.communityLimit);
  }
  selectedMods.sort((left, right) => left.repo.localeCompare(right.repo));

  let oldIndex = null;
  try {
    oldIndex = await readJsonIfExists(path.join(communityDir, 'index.json'));
  } catch (error) {
    log(`[警告] 旧 community/index.json 不可用：${error.message}`);
  }
  const oldEntries = new Map(
    (Array.isArray(oldIndex?.mods) ? oldIndex.mods : [])
      .filter((entry) => typeof entry?.repo === 'string')
      .map((entry) => [entry.repo.toLowerCase(), entry]),
  );
  const stateLoaded = await loadRefreshState(outDir, log, COMMUNITY_STATE_REL_PATH);
  const previousState = stateLoaded.state;
  const compatData = await loadCompatData(outDir, log);
  const repoStats = await refreshRepoStats({
    outDir,
    apiClient,
    repos: selectedMods.map((mod) => mod.repo),
    log,
  });

  const rawPool = createPool(options.rawThreads);
  const apiPool = createPool(options.threads);
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const dataset = {
    outDir: communityDir,
    allowLegacy: false,
    buildEntry: buildCommunityIndexEntry,
  };
  const resultsByRepo = new Map();
  let completed = 0;
  const processingOrder = sortModsForRefresh(selectedMods, previousState);
  await Promise.all(
    processingOrder.map((mod) =>
      apiPool.run(async () => {
        const result = await processMod({
          mod,
          options,
          apiClient,
          rawClient,
          rawPool,
          outDir: communityDir,
          now,
          nowMs,
          log,
          oldEntries,
          previousState,
          abortState,
          dataset,
          compatData,
          repoStats,
        });
        resultsByRepo.set(mod.repo, result);
        completed += 1;
        if (!options.verbose && selectedMods.length > 20 && completed % 25 === 0) {
          console.log(`[community] 进度：${completed}/${selectedMods.length}`);
        }
      }),
    ),
  );
  const results = selectedMods.map((mod) => resultsByRepo.get(mod.repo));
  const droppedResults = results.filter(
    (result) =>
      result.entry &&
      (result.entry.releaseCount ?? 0) === 0 &&
      (result.entry.tagCount ?? 0) === 0 &&
      // 未处理/抓取失败但已有旧条目的模组保留（否则低配额会误删），全新且无数据的才丢弃
      !((result.unprocessed === true || result.skipped) && result.hasOldEntry === true),
  );
  const keptResults = results.filter((result) => !droppedResults.includes(result));
  if (droppedResults.length > 0) {
    if (!options.dryRun) {
      for (const result of droppedResults) {
        try {
          await deleteReleaseData(communityDir, result.entry.repo);
        } catch {}
      }
    }
    log(`[community] v3 丢弃 ${droppedResults.length} 个没有任何可用版本的模组`);
  }
  const unprocessed = results.filter((result) => result.unprocessed).length;
  const rateLimited = results.filter((result) => result.skipped?.reason === 'rate-limit').length;
  const notProcessed = unprocessed + rateLimited;
  if (abortState.aborted && notProcessed > 0) {
    console.warn(
      `[警告] 社区模组：API 配额不足，本次未处理 ${notProcessed}/${selectedMods.length} 个，已保留已抓结果；下次按最久未刷新继续`,
    );
  }
  const skipped = results.filter((result) => result.skipped).map((result) => result.skipped);

  // state：本地验证（限流参数）时保留其它模组状态，正式运行时只保留收录列表
  const stateMods = limited ? { ...previousState.mods } : {};
  for (const [index, result] of results.entries()) {
    const repo = selectedMods[index].repo;
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

  // v3：社区全量写 community/index-full.json，默认列表先写同一份（heat 注入时再拆分）
  let indexChanged = false;
  const communityFullIndex = {
    formatVersion: 3,
    generatedAt: now,
    source: {
      source: COMMUNITY_SOURCE,
      query: TOPIC_QUERY_BASE,
      officialCount: officialRepos.size,
    },
    mods: keptResults.map((result) => result.entry),
    skipped,
  };
  if (!options.dryRun) {
    const communityFullIndexPath = path.join(outDir, COMMUNITY_FULL_INDEX_REL_PATH);
    const previousCommunityFullIndex = await readJsonIfExists(communityFullIndexPath).catch(() => null);
    if (indexBodyChanged(previousCommunityFullIndex, communityFullIndex)) {
      await writeJsonAtomic(communityFullIndexPath, communityFullIndex);
      indexChanged = true;
    }
    const communityIndexPath = path.join(communityDir, 'index.json');
    if (indexBodyChanged(oldIndex, communityFullIndex)) {
      await writeJsonAtomic(communityIndexPath, communityFullIndex);
      indexChanged = true;
    }
  }
  if (!options.dryRun && !limited && !options.keepMissingFiles) {
    await cleanupMissing(communityDir, selectedMods, log);
  }

  const summaryRows = communitySummaryRows(keptResults);
  const summary = buildSummary({ rows: summaryRows, generatedAt: now });
  const summaryFile = path.join(communityDir, 'summary.json');
  const summaryCsvFile = path.join(communityDir, 'summary.csv');
  let previousSummary = null;
  let previousCsv = null;
  if (options.cache) {
    try {
      previousSummary = await readJsonIfExists(summaryFile);
    } catch (error) {
      log(`[警告] 旧 community/summary.json 不可用：${error.message}`);
    }
    try {
      previousCsv = await readTextIfExists(summaryCsvFile);
    } catch (error) {
      log(`[警告] 旧 community/summary.csv 不可用：${error.message}`);
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
    `[community] ${selectedMods.length} 个模组，${changed} 个 release 文件有变化，` +
      `index ${indexChanged ? '已更新' : '未变'}，summary ${summaryChanged || csvChanged ? '已更新' : '未变'}，` +
      `state ${stateChanged ? '已更新' : '未变'}，${skipped.length} 个抓取失败` +
      (notProcessed > 0 ? `，${notProcessed} 个因配额不足未处理` : ''),
  );
  const communityChanges = [];
  for (const [index, mod] of selectedMods.entries()) {
    const result = results[index];
    if (!result) {
      continue;
    }
    const namePlain = result.entry?.namePlain ?? '';
    if (context.initialChanges) {
      communityChanges.push({
        at: now,
        dataset: 'community',
        repo: mod.repo,
        action: 'mod-added',
        ...(namePlain ? { namePlain } : {}),
      });
    } else {
      communityChanges.push(
        ...diffModEntry({
          dataset: 'community',
          repo: mod.repo,
          previousEntry: oldEntries.get(mod.repo.toLowerCase()) ?? null,
          currentEntry: result.entry,
          at: now,
          namePlain,
        }),
      );
    }
    communityChanges.push(...(result.changes ?? []));
  }
  const datasetStats = {
    updatedAt: now,
    modCount: selectedMods.length,
    releaseCount: results.reduce((sum, result) => sum + (result.entry?.releaseCount ?? 0), 0),
    skipped,
  };
  return {
    code: 0,
    changed,
    indexChanged,
    summaryChanged: summaryChanged || csvChanged,
    stateChanged,
    unprocessed: notProcessed,
    community: true,
    candidates: candidates.length,
    eligible: eligible.length,
    stats,
    changes: communityChanges,
    datasetStats,
  };
}

// ---------- heat 数据集（热度表） ----------

const HEAT_CACHE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const HEAT_HISTORY_KINDS = ['daily', 'weekly', 'monthly'];

async function loadHeatSnapshots(outDir, log) {
  const snapshots = [];
  for (const kind of HEAT_HISTORY_KINDS) {
    const dir = path.join(outDir, HEAT_HISTORY_DIR, kind);
    let files;
    try {
      files = await readdir(dir);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log(`[警告] heat/${kind} 历史目录不可用：${error.message}`);
      }
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const data = await readJsonIfExists(path.join(dir, file));
        if (data && data.mods && typeof data.generatedAt === 'string') {
          snapshots.push({ kind, file, generatedAt: data.generatedAt, mods: data.mods });
        }
      } catch (error) {
        log(`[警告] heat 历史 ${kind}/${file} 不可用：${error.message}`);
      }
    }
  }
  return snapshots;
}

async function loadHeatMods(outDir, log) {
  const mods = [];
  for (const [relPath, source] of [
    [FULL_INDEX_REL_PATH, 'official'],
    [COMMUNITY_FULL_INDEX_REL_PATH, 'community'],
  ]) {
    const file = await readJsonIfExists(path.join(outDir, relPath)).catch(() => null);
    const fallbackPath =
      source === 'official'
        ? path.join(outDir, INDEX_FILE)
        : path.join(outDir, COMMUNITY_DIR, 'index.json');
    const index =
      file ??
      (await readJsonIfExists(fallbackPath).catch(() => null));
    for (const entry of Array.isArray(index?.mods) ? index.mods : []) {
      mods.push({
        repo: entry.repo,
        namePlain: entry.namePlain ?? '',
        source,
        // v3 用 modType；兼容旧数据里的 hasJava
        modType: entry.modType ?? (entry.hasJava === true ? 'java' : null),
        hasJava: entry.modType ? entry.modType === 'java' : entry.hasJava === true,
      });
    }
  }
  if (mods.length === 0) {
    log('[heat] 没有可用的 index（先跑 mods/community）');
  }
  return mods;
}

async function loadHeatToolkit(outDir, log) {
  const summary = new Map();
  for (const [relPath, source] of [
    ['summary.json', 'official'],
    [path.join('community', 'summary.json'), 'community'],
  ]) {
    const file = await readJsonIfExists(path.join(outDir, relPath)).catch(() => null);
    for (const row of Array.isArray(file?.mods) ? file.mods : []) {
      summary.set(row.repo, {
        stars: Number(row.stars) || 0,
        totalDownloads: Number(row.totalDownloads) || 0,
        source,
      });
    }
  }
  const releases = new Map();
  const readReleases = async (relPath, workDir, repo) => {
    try {
      const file = await readJsonIfExists(relPath);
      if (Array.isArray(file?.versions)) {
        return releasesFromVersions(file);
      }
      if (Array.isArray(file?.releases)) {
        return file.releases;
      }
      const paged = await readReleasePages(workDir, repo).catch(() => null);
      return paged ? releasesFromVersions(paged) : [];
    } catch {
      return [];
    }
  };
  return { summary, readReleases };
}

function normalizeCommitState(raw) {
  const stats = {};
  if (raw && typeof raw.stats === 'object' && !Array.isArray(raw.stats)) {
    for (const [repo, weeks] of Object.entries(raw.stats)) {
      if (Array.isArray(weeks)) {
        stats[repo] = weeks.map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0));
      }
    }
  }
  return {
    formatVersion: 1,
    fetchedAt: typeof raw?.fetchedAt === 'string' ? raw.fetchedAt : null,
    complete: raw?.complete === true,
    stats,
  };
}

function normalizeCreatedState(raw) {
  const repos = {};
  if (raw && typeof raw.repos === 'object' && !Array.isArray(raw.repos)) {
    for (const [repo, value] of Object.entries(raw.repos)) {
      repos[repo] = typeof value === 'string' ? value : null;
    }
  }
  return {
    formatVersion: 1,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    repos,
  };
}

async function refreshHeatCommitStats({
  apiClient,
  repos,
  outDir,
  state,
  log,
  abortState,
  maxApi,
  threads,
  nowMs,
  now,
}) {
  const stale =
    !state.fetchedAt ||
    !state.complete ||
    nowMs - Date.parse(state.fetchedAt) >= HEAT_CACHE_FRESH_MS;
  if (!stale || repos.length === 0) {
    return state;
  }
  const stats = { ...state.stats };
  let calls = 0;
  let aborted = false;
  const pool = createPool(threads);
  await Promise.all(
    repos.map((repo) =>
      pool.run(async () => {
        if (
          aborted ||
          abortState?.aborted ||
          apiClient.hasLowQuota?.(5) ||
          (maxApi !== null && calls >= maxApi)
        ) {
          return;
        }
        calls += 1;
        try {
          const response = await apiClient.get(
            `https://api.github.com/repos/${repo}/stats/participation`,
          );
          if (response.status === 200) {
            const data = JSON.parse(response.text ?? '{}');
            if (Array.isArray(data.all)) {
              stats[repo] = data.all.map((value) =>
                Number.isFinite(Number(value)) ? Number(value) : 0,
              );
            }
          }
        } catch (error) {
          if (error?.name === 'RateLimitError' || error?.status === 403 || error?.status === 429) {
            aborted = true;
            if (abortState) {
              abortState.aborted = true;
              abortState.reason = 'rate-limit';
            }
          } else {
            log(`[heat] ${repo} participation 不可用：${error.message}`);
          }
        }
      }),
    ),
  );
  const complete =
    !aborted &&
    (maxApi === null || calls < maxApi) &&
    repos.every((repo) => Array.isArray(stats[repo]));
  log(
    `[heat] participation 缓存：${calls} 次请求，${Object.keys(stats).length} 个仓库${complete ? '（最新）' : '（未完成，下次续）'}`,
  );
  return {
    formatVersion: 1,
    fetchedAt: complete ? now : (state.fetchedAt ?? now),
    complete,
    stats,
  };
}

async function refreshRepoCreated({
  apiClient,
  repos,
  state,
  log,
  abortState,
  maxApi,
  threads,
  now,
}) {
  const missing = repos.filter(
    (repo) => !Object.prototype.hasOwnProperty.call(state.repos, repo),
  );
  if (missing.length === 0) {
    return state;
  }
  const reposMap = { ...state.repos };
  let calls = 0;
  let aborted = false;
  const pool = createPool(threads);
  await Promise.all(
    missing.map((repo) =>
      pool.run(async () => {
        if (
          aborted ||
          abortState?.aborted ||
          apiClient.hasLowQuota?.(5) ||
          (maxApi !== null && calls >= maxApi)
        ) {
          return;
        }
        calls += 1;
        try {
          const response = await apiClient.get(`https://api.github.com/repos/${repo}`);
          if (response.status === 200) {
            const data = JSON.parse(response.text ?? '{}');
            reposMap[repo] =
              typeof data.created_at === 'string' ? data.created_at : null;
          } else if (response.status === 404) {
            reposMap[repo] = null;
          }
        } catch (error) {
          if (error?.name === 'RateLimitError' || error?.status === 403 || error?.status === 429) {
            aborted = true;
            if (abortState) {
              abortState.aborted = true;
              abortState.reason = 'rate-limit';
            }
          } else {
            log(`[heat] ${repo} created_at 不可用：${error.message}`);
          }
        }
      }),
    ),
  );
  log(`[heat] repo created_at：${calls} 次请求，已缓存 ${Object.keys(reposMap).length} 个仓库`);
  if (calls === 0 || JSON.stringify(reposMap) === JSON.stringify(state.repos)) {
    return state;
  }
  return { formatVersion: 1, updatedAt: now, repos: reposMap };
}

function heatCsv(entries, { csvEscape }) {
  const lines = [HEAT_SUMMARY_COLUMNS.join(',')];
  for (const entry of entries) {
    const row = heatSummaryRow(entry);
    lines.push(HEAT_SUMMARY_COLUMNS.map((column) => csvEscape(row[column])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

async function writeHeatHistory({ outDir, mods, now, nowMs, log }) {
  const generatedAt = now;
  const snapshot = buildSnapshot(mods, generatedAt);
  const keys = {
    daily: formatDateKey(new Date(nowMs)),
    weekly: formatWeekKey(new Date(nowMs)),
    monthly: formatMonthKey(new Date(nowMs)),
  };
  let written = 0;
  for (const kind of HEAT_HISTORY_KINDS) {
    const dir = path.join(outDir, HEAT_HISTORY_DIR, kind);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${keys[kind]}.json`);
    const previous = await readJsonIfExists(file).catch(() => null);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(snapshot)) {
      await writeJsonAtomic(file, snapshot);
      written += 1;
    }
    let files = [];
    try {
      files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      log(`[heat] 历史目录 ${kind} 读取失败：${error.message}`);
    }
    const keysList = files.map((name) => name.slice(0, -'.json'.length));
    const { remove } = selectHistoryFiles(keysList, kind);
    for (const key of remove) {
      await unlink(path.join(dir, `${key}.json`)).catch(() => {});
    }
  }
  return written;
}

async function runHeat(options, context) {
  const { apiClient, outDir, log } = context;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const dayMs = 86_400_000;
  const mods = await loadHeatMods(outDir, log);
  if (mods.length === 0) {
    return { code: 0, changed: false, modCount: 0, commitsFetched: 0, createdFetched: 0 };
  }
  const { summary, readReleases } = await loadHeatToolkit(outDir, log);
  const previousSnapshots = await loadHeatSnapshots(outDir, log);

  const commitPath = path.join(outDir, HEAT_COMMIT_STATE_REL_PATH);
  let commitState = normalizeCommitState(
    await readJsonIfExists(commitPath).catch(() => null),
  );
  const repoList = mods.map((mod) => mod.repo);
  const commitBefore = JSON.stringify(commitState.stats);
  commitState = await refreshHeatCommitStats({
    apiClient,
    repos: repoList,
    outDir,
    state: commitState,
    log,
    abortState: context.abortState,
    maxApi: options.heatMaxApi,
    threads: options.threads,
    nowMs,
    now,
  });
  const commitChanged = JSON.stringify(commitState.stats) !== commitBefore;
  await writeJsonAtomic(commitPath, commitState);

  const createdPath = path.join(outDir, HEAT_CREATED_STATE_REL_PATH);
  let createdState = normalizeCreatedState(
    await readJsonIfExists(createdPath).catch(() => null),
  );
  const createdBefore = JSON.stringify(createdState.repos);
  createdState = await refreshRepoCreated({
    apiClient,
    repos: repoList,
    state: createdState,
    log,
    abortState: context.abortState,
    maxApi: options.heatMaxApi,
    threads: options.threads,
    now,
  });
  const createdChanged = JSON.stringify(createdState.repos) !== createdBefore;
  await writeJsonAtomic(createdPath, createdState);

  const releaseCache = new Map();
  const releaseFor = async (mod) => {
    if (!releaseCache.has(mod.repo)) {
      const workDir = mod.source === 'community' ? path.join(outDir, COMMUNITY_DIR) : outDir;
      const relPath = path.join(workDir, releasesRelPath(mod.repo));
      releaseCache.set(mod.repo, await readReleases(relPath, workDir, mod.repo));
    }
    return releaseCache.get(mod.repo);
  };

  const heatInputs = [];
  for (const mod of mods) {
    const totals = summary.get(mod.repo);
    const releases = await releaseFor(mod);
    const createdAt = createdState.repos[mod.repo];
    const createdMs = createdAt ? Date.parse(createdAt) : null;
    const earliestRelease = earliestReleasePublishedAt(releases);
    const ageDays =
      createdMs !== null && !Number.isNaN(createdMs)
        ? daysBetween(createdMs, nowMs)
        : earliestRelease !== null
          ? daysBetween(earliestRelease, nowMs)
          : null;
    const lastReleaseMs = latestReleasePublishedAt(releases);
    const daysSinceRelease =
      lastReleaseMs !== null
        ? daysBetween(lastReleaseMs, nowMs)
        : ageDays;
    const commitWeeks = commitState.stats[mod.repo] ?? [];
    const daysSinceCommit = daysSinceLastCommit(
      commitWeeks,
      commitState.fetchedAt,
      nowMs,
    );
    const lastReleaseAt =
      lastReleaseMs !== null ? new Date(lastReleaseMs).toISOString() : null;
    const lastCommitAt =
      daysSinceCommit !== null
        ? new Date(nowMs - daysSinceCommit * dayMs).toISOString()
        : null;
    const maintenance = {
      lastReleaseAt,
      lastCommitAt,
      daysSinceRelease:
        lastReleaseMs !== null ? daysBetween(lastReleaseMs, nowMs) : null,
      daysSinceCommit,
      status: maintenanceStatus({
        daysSinceRelease: lastReleaseMs !== null ? daysBetween(lastReleaseMs, nowMs) : null,
        daysSinceCommit,
        ageDays,
      }),
    };
    const downloadChanges = {};
    const starChanges = {};
    for (const window of HEAT_WINDOWS) {
      const target = nowMs - window * dayMs;
      const snapshot = findSnapshotAtOrBefore(previousSnapshots, target);
      const baseDownloads = snapshotValue(snapshot, mod.repo, 'totalDownloads');
      const baseStars = snapshotValue(snapshot, mod.repo, 'stars');
      downloadChanges[window] = snapshot
        ? (Number(totals?.totalDownloads) || 0) - baseDownloads
        : 0;
      starChanges[window] = snapshot
        ? (Number(totals?.stars) || 0) - baseStars
        : 0;
    }
    heatInputs.push({
      repo: mod.repo,
      namePlain: mod.namePlain,
      source: mod.source,
      totalDownloads: Number(totals?.totalDownloads) || 0,
      totalStars: Number(totals?.stars) || 0,
      hasJava: mod.hasJava === true,
      maintenance,
      downloadChanges,
      starChanges,
      releaseUpdates: Object.fromEntries(
        UPDATE_WINDOWS.map((window) => [
          window,
          releaseUpdatesInWindow(releases, nowMs, window),
        ]),
      ),
      commits: Object.fromEntries(
        UPDATE_WINDOWS.map((window) => [
          window,
          commitsInWindow(commitWeeks, commitState.fetchedAt, nowMs, window),
        ]),
      ),
      ageDays,
      daysSinceRelease,
      daysSinceCommit,
    });
  }

  const { entries } = computeHeat(heatInputs);
  for (const entry of entries) {
    // 只对最终展示分做 4 位小数；占比/柔化/活动原始值保留全精度便于核对（占比和≈1 校验需要）
    entry.downloadsScore = round4(entry.downloadsScore);
    entry.starsScore = round4(entry.starsScore);
    entry.updateScore = round4(entry.updateScore);
    entry.newModMultiplier = round4(entry.newModMultiplier);
    entry.penalty = round4(entry.penalty);
    entry.score = round4(entry.score);
    entry.effectiveWeights.downloads = round4(entry.effectiveWeights.downloads);
    entry.effectiveWeights.stars = round4(entry.effectiveWeights.stars);
    entry.effectiveWeights.update = round4(entry.effectiveWeights.update);
    entry.recommend = recommendationFor(entry);
  }
  // 按 4 位小数后的展示分重新排序并编号，保证 rank 与落盘分数严格一致
  entries.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.repo < right.repo ? -1 : left.repo > right.repo ? 1 : 0;
  });
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
    entry.ranks = { score: entry.rank };
  });
  // 预计算其他排序：updated（最近更新）/ downloads / stars / newest（发布越新越前），客户端直接按 ranks 排
  const timestampOf = (value) => {
    const parsed = Date.parse(value ?? '');
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const rankSorts = [
    [
      'updated',
      (entry) =>
        Math.max(
          timestampOf(entry.maintenance?.lastReleaseAt),
          timestampOf(entry.maintenance?.lastCommitAt),
        ),
      'desc',
    ],
    ['downloads', (entry) => Number(entry.totalDownloads) || 0, 'desc'],
    ['stars', (entry) => Number(entry.totalStars) || 0, 'desc'],
    ['newest', (entry) => (entry.ageDays === null ? Number.POSITIVE_INFINITY : entry.ageDays), 'asc'],
  ];
  for (const [key, valueOf, direction] of rankSorts) {
    const ordered = [...entries].sort((left, right) => {
      const leftValue = valueOf(left);
      const rightValue = valueOf(right);
      const cmp = direction === 'asc' ? leftValue - rightValue : rightValue - leftValue;
      if (cmp !== 0 && !Number.isNaN(cmp)) {
        return cmp;
      }
      return left.repo < right.repo ? -1 : left.repo > right.repo ? 1 : 0;
    });
    ordered.forEach((entry, index) => {
      entry.ranks[key] = index + 1;
    });
  }
  // 热度注入：全量列表写 index-full.json，默认列表 index.json 只留 recommendVisible=true
  const heatByRepo = new Map(entries.map((entry) => [entry.repo.toLowerCase(), entry]));
  let heatChanged = false;
  const injectGroup = async ({ indexRelPath, fullIndexRelPath, summaryRelPath }) => {
    const indexPath = path.join(outDir, indexRelPath);
    const fullIndexPath = path.join(outDir, fullIndexRelPath);
    let source = null;
    try {
      source =
        (await readJsonIfExists(fullIndexPath).catch(() => null)) ??
        (await readJsonIfExists(indexPath));
    } catch (error) {
      log(`[警告] ${indexRelPath} 不可用，无法注入 heat：${error.message}`);
      return;
    }
    if (!source || !Array.isArray(source.mods)) {
      return;
    }
    const fullIndex = injectHeatIntoIndex(source, heatByRepo);
    const visibleMods = fullIndex.mods.filter((mod) => mod.score?.recommendVisible === true);
    const visibleIndex = {
      ...fullIndex,
      source:
        fullIndex.source && typeof fullIndex.source === 'object'
          ? { ...fullIndex.source, modCount: visibleMods.length }
          : fullIndex.source,
      mods: visibleMods,
    };
    if (JSON.stringify(source) !== JSON.stringify(fullIndex) || !(await readJsonIfExists(fullIndexPath).catch(() => null))) {
      await writeJsonAtomic(fullIndexPath, fullIndex);
      heatChanged = true;
    }
    const previousVisible = await readJsonIfExists(indexPath).catch(() => null);
    if (JSON.stringify(previousVisible) !== JSON.stringify(visibleIndex)) {
      await writeJsonAtomic(indexPath, visibleIndex);
      heatChanged = true;
    }

    const summaryPath = path.join(outDir, summaryRelPath);
    const previousSummary = await readJsonIfExists(summaryPath).catch(() => null);
    let rows = injectHeatIntoSummaryRows(
      Array.isArray(previousSummary?.mods) ? previousSummary.mods : [],
      heatByRepo,
    );
    if (rows.length !== fullIndex.mods.length) {
      rows = fullIndex.mods.map((mod) => {
        const heatEntry = heatByRepo.get(mod.repo?.toLowerCase());
        return {
          repo: mod.repo,
          name: mod.name,
          namePlain: mod.namePlain ?? '',
          author: mod.author,
          stars: mod.stars,
          modType: mod.modType,
          releaseCount: mod.releaseCount,
          ...(mod.modType === 'java' ? {} : { tagCount: mod.tagCount }),
          totalDownloads: mod.totalDownloads,
          allAssetsDownloads: mod.allAssetsDownloads,
          minGameVersion: mod.minGameVersion,
          gameVersionRanges: JSON.stringify(mod.gameVersionRanges ?? []),
          releaseUpdatedAt: mod.releaseUpdatedAt,
          commitUpdatedAt: mod.commitUpdatedAt,
          iconUrl: mod.iconUrl,
          releasesPath: mod.releasesPath,
          ...(heatEntry ? heatSummaryFields(heatEntry) : {}),
        };
      });
    }
    const summary = buildSummary({ rows, generatedAt: fullIndex.generatedAt ?? now });
    if (summaryBodyChanged(previousSummary, summary)) {
      await writeJsonAtomic(summaryPath, summary);
      heatChanged = true;
    }
    const nextCsv = summaryCsv(summary.mods);
    let previousCsv = null;
    try {
      previousCsv = await readTextIfExists(summaryPath.replace(/\.json$/, '.csv'));
    } catch {}
    if (previousCsv !== nextCsv) {
      await writeTextAtomic(summaryPath.replace(/\.json$/, '.csv'), nextCsv);
      heatChanged = true;
    }
  };
  await injectGroup({
    indexRelPath: INDEX_FILE,
    fullIndexRelPath: FULL_INDEX_REL_PATH,
    summaryRelPath: 'summary.json',
  });
  await injectGroup({
    indexRelPath: path.join(COMMUNITY_DIR, 'index.json'),
    fullIndexRelPath: COMMUNITY_FULL_INDEX_REL_PATH,
    summaryRelPath: path.join(COMMUNITY_DIR, 'summary.json'),
  });
  // 旧的独立热度表路径不再生成，清理遗留文件
  for (const legacyRel of [
    HEAT_INDEX_REL_PATH,
    HEAT_SUMMARY_REL_PATH,
    HEAT_RECOMMEND_REL_PATH,
    HEAT_RECOMMEND_CSV_REL_PATH,
  ]) {
    const legacyPath = path.join(outDir, legacyRel);
    try {
      await unlink(legacyPath);
      heatChanged = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log(`[警告] 清理旧热度文件 ${legacyRel} 失败：${error.message}`);
      }
    }
  }
  const visibleEntries = entries.filter((entry) => entry.recommend?.visible === true);
  const hiddenCount = entries.length - visibleEntries.length;
  const historyWritten = await writeHeatHistory({
    outDir,
    mods: heatInputs.map((mod) => ({
      repo: mod.repo,
      totalStars: mod.totalStars,
      totalDownloads: mod.totalDownloads,
    })),
    now,
    nowMs,
    log,
  });

  if (commitChanged) {
    log('[heat] participation 缓存已更新');
  }
  if (createdChanged) {
    log('[heat] repo created_at 缓存已更新');
  }
  const officialCount = mods.filter((mod) => mod.source === 'official').length;
  const communityCount = mods.filter((mod) => mod.source === 'community').length;
  console.log(
    `[heat] ${entries.length} 个模组（官方 ${officialCount} / 社区 ${communityCount}），` +
      `只看活跃 ${visibleEntries.length} 个（隐藏 ${hiddenCount} 个），top1 ${entries[0]?.repo ?? '无'}，快照写入 ${historyWritten} 个`,
  );
  return {
    code: 0,
    changed: heatChanged,
    modCount: entries.length,
    recommendCount: visibleEntries.length,
    historyWritten,
    commitsFetched: commitChanged,
    createdFetched: createdChanged,
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
  return {
    code: 0,
    releases,
    changed,
    stats: {
      updatedAt: new Date().toISOString(),
      modCount: null,
      releaseCount: releases.length,
      skipped: [],
    },
  };
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
  return {
    code: 0,
    changed,
    stats: {
      updatedAt: new Date().toISOString(),
      modCount: null,
      releaseCount: null,
      skipped: [],
    },
  };
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
  if (options.migrate) {
    const outDir = path.resolve(options.out);
    const log = options.verbose ? (message) => console.log(message) : () => {};
    const now = new Date().toISOString();
    if (!options.dryRun) {
      const result = await migrateDataDir({ outDir, log, now });
      console.log(
        `[migrate] 完成：官方文件 ${result.officialFiles} 个、社区文件 ${result.communityFiles} 个、index 条目 ${result.entries} 个`,
      );
    } else {
      console.log('[migrate] dry-run：不写文件');
    }
    return 0;
  }

  // 子集模式会写出「只含所选模组」的 index.json，绝不能落在当前目录（正式仓库根）
  if (
    (options.repos !== null ||
      options.limit !== null ||
      options.communityLimit !== null ||
      options.communitySearchWindows !== null ||
      options.communityMaxCandidates !== null) &&
    path.resolve(options.out) === path.resolve(process.cwd())
  ) {
    console.error(
      '参数错误：--repos / --limit / 社区小规模验证参数属于子集模式，必须用 --out 指定临时输出目录（如 --out tmp/live），不能指向当前目录，避免把正式数据裁剪成子集',
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
  const changesLoaded = await loadChanges(outDir, log);
  const context = {
    apiClient,
    rawClient,
    outDir,
    log,
    now: new Date().toISOString(),
    versionsReleases: null,
    // 官方与社区共享同一配额状态：官方先跑，配额不足时社区直接跳过，下次续跑
    abortState: { aborted: false, reason: null },
    previousChanges: changesLoaded.changes,
    initialChanges: !changesLoaded.exists,
  };

  let exitCode = 0;
  let modsChanged = 0;
  let modsIndexChanged = false;
  let modsSummaryChanged = false;
  let modsStateChanged = false;
  let communityChanged = 0;
  let communityIndexChanged = false;
  let communitySummaryChanged = false;
  let communityStateChanged = false;
  let communityUnprocessed = 0;
  let versionsChanged = false;
  let gateChanged = false;
  let modsResult = null;
  let communityResult = null;
  let heatResult = null;
  let versionsResult = null;
  let gateResult = null;

  if (options.datasets.includes('mods')) {
    modsResult = await runMods(options, context);
    const result = modsResult;
    exitCode = Math.max(exitCode, result.code);
    modsChanged = result.changed;
    modsIndexChanged = result.indexChanged;
    modsSummaryChanged = result.summaryChanged;
    modsStateChanged = result.stateChanged;
  }
  if (options.datasets.includes('community')) {
    communityResult = await runCommunity(options, context);
    const result = communityResult;
    exitCode = Math.max(exitCode, result.code);
    communityChanged = result.changed ?? 0;
    communityIndexChanged = result.indexChanged ?? false;
    communitySummaryChanged = result.summaryChanged ?? false;
    communityStateChanged = result.stateChanged ?? false;
    communityUnprocessed = result.unprocessed ?? 0;
  }
  if (options.datasets.includes('heat')) {
    heatResult = await runHeat(options, context);
    exitCode = Math.max(exitCode, heatResult.code);
  }
  if (options.datasets.includes('versions')) {
    versionsResult = await runVersions(options, context);
    const result = versionsResult;
    exitCode = Math.max(exitCode, result.code);
    versionsChanged = result.changed;
    context.versionsReleases = result.releases;
  }
  if (options.datasets.includes('gate')) {
    gateResult = await runGate(options, context);
    const result = gateResult;
    exitCode = Math.max(exitCode, result.code);
    gateChanged = result.changed;
  }

  // B5：滚动变更流（新变更在前，最多 500 条）；首次建立时只有初始快照 mod-added
  let changesWritten = false;
  let statusWritten = false;
  if (!options.dryRun) {
    const newChanges = [
      ...(modsResult?.changes ?? []),
      ...(communityResult?.changes ?? []),
    ];
    const nextChanges = mergeChanges(newChanges, context.previousChanges);
    if (JSON.stringify(context.previousChanges) !== JSON.stringify(nextChanges)) {
      await writeJsonAtomic(path.join(outDir, CHANGES_REL_PATH), nextChanges);
      changesWritten = true;
    }
    // B4：健康状态（运行日志性质，无数据变化也更新；未运行的数据集沿用上一份 status）
    const datasets = {};
    if (modsResult?.stats) {
      datasets.official = modsResult.stats;
    }
    if (communityResult?.datasetStats) {
      datasets.community = communityResult.datasetStats;
    }
    if (versionsResult?.stats) {
      datasets.versions = versionsResult.stats;
    }
    if (gateResult?.stats) {
      datasets.gate = gateResult.stats;
    }
    let previousStatus = null;
    try {
      previousStatus = await readJsonIfExists(path.join(outDir, STATUS_REL_PATH));
    } catch (error) {
      log(`[警告] 旧 ${STATUS_REL_PATH} 不可用：${error.message}`);
    }
    let validation = { errors: 0, warnings: 0, presentFiles: [] };
    try {
      const validationResult = await validateDir(outDir);
      validation = {
        errors: validationResult.errors.length,
        warnings: validationResult.warnings.length,
        presentFiles: validationResult.present,
      };
    } catch (error) {
      log(`[警告] status 的 validate 摘要生成失败：${error.message}`);
    }
    const status = buildStatus({
      generatedAt: new Date().toISOString(),
      previous: previousStatus,
      datasets,
      api: apiStatus(apiClient),
      validate: validation,
    });
    await writeJsonAtomic(path.join(outDir, STATUS_REL_PATH), status);
    // status 写完后重新算一次 validate（避免把“status 自身缺失”的 warning 记进去）
    try {
      const validationResult = await validateDir(outDir);
      status.validate = {
        errors: validationResult.errors.length,
        warnings: validationResult.warnings.length,
        presentFiles: validationResult.present,
      };
      await writeJsonAtomic(path.join(outDir, STATUS_REL_PATH), status);
    } catch (error) {
      log(`[警告] status 的 validate 复核失败：${error.message}`);
    }
    statusWritten = true;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `完成（${options.datasets.join(',')}）：用时 ${elapsed} 秒` +
      (options.datasets.includes('mods')
        ? `，release 文件变化 ${modsChanged} 个、index ${modsIndexChanged ? '已更新' : '未变'}、summary ${modsSummaryChanged ? '已更新' : '未变'}、state ${modsStateChanged ? '已更新' : '未变'}`
        : '') +
      (options.datasets.includes('community')
        ? `，社区 release 文件变化 ${communityChanged} 个、index ${communityIndexChanged ? '已更新' : '未变'}、summary ${communitySummaryChanged ? '已更新' : '未变'}、state ${communityStateChanged ? '已更新' : '未变'}${communityUnprocessed > 0 ? `、${communityUnprocessed} 个未处理` : ''}`
        : '') +
      (options.datasets.includes('versions') ? `，versions ${versionsChanged ? '已更新' : '未变'}` : '') +
      (options.datasets.includes('gate') ? `，gate ${gateChanged ? '已更新' : '未变'}` : '') +
      (options.datasets.includes('heat')
        ? `，heat ${heatResult?.modCount ?? 0} 个模组${heatResult?.historyWritten ? `、快照 ${heatResult.historyWritten} 份` : ''}`
        : '') +
      (statusWritten ? `，status ${statusWritten ? '已更新' : '未变'}` : '') +
      (changesWritten ? '，changes 已更新' : ''),
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
