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
  buildReleasesFile,
} from './releases.js';
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
  isPageDue,
  normalizeRefreshState,
  stateBodyChanged,
} from './refresh-state.js';
import { releasesRelPath, resolveReleaseFile, assertRepo } from './paths.js';
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
  GATE_REL_PATH,
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
  const stats = computeModStats(releases, mod.hasJava === true);
  const first = releases[0] ?? null;
  const releaseCount = hasFile
    ? releases.length
    : typeof oldEntry?.releaseCount === 'number'
      ? oldEntry.releaseCount
      : 0;
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

function maxPageInState(modState) {
  const pages = Object.keys(modState?.pages ?? {})
    .map((page) => Number(page))
    .filter((page) => Number.isInteger(page) && page >= 2);
  return pages.length > 0 ? Math.max(...pages) : 1;
}

// 本轮要抓哪些页：无缓存/--no-cache 全量；否则第 1 页每天、深层页按 7/30/90 天到期
function planModPages({ previousFile, modState, forceFull, now }) {
  if (forceFull || !previousFile) {
    return { mode: 'full' };
  }
  const knownPageCount = Math.max(
    1,
    Math.ceil(previousFile.releases.length / PER_PAGE),
    maxPageInState(modState),
  );
  const pages = [];
  if (isPageDue(modState?.page1FetchedAt ?? null, 1, now)) {
    pages.push(1);
  }
  for (let page = 2; page <= knownPageCount; page += 1) {
    if (isPageDue(modState?.pages?.[String(page)] ?? null, page, now)) {
      pages.push(page);
    }
  }
  return { mode: 'tiered', pages };
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
  } = context;
  const relPath = releasesRelPath(mod.repo);
  const oldEntry = oldEntries.get(mod.repo.toLowerCase()) ?? null;
  const hasJava = mod.hasJava === true;

  let previous = null;
  if (options.cache) {
    try {
      const oldFile = await readJsonIfExists(resolveReleaseFile(outDir, relPath));
      if (oldFile && oldFile.repo === mod.repo && Array.isArray(oldFile.releases)) {
        previous = oldFile;
      }
    } catch (error) {
      log(`[警告] ${mod.repo} 的旧数据不可用：${error.message}`);
    }
  }

  // 分页缓存从 state/refresh.json 读取；旧 per-mod 文件里的 source 只用于一次性迁移
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

  try {
    const plan = planModPages({
      previousFile: previous,
      modState,
      forceFull: !options.cache,
      now: nowMs,
    });

    let fetchedPages = [];
    if (plan.mode === 'full') {
      fetchedPages = await fetchAllReleasePages(apiClient, mod.repo);
    } else if (plan.pages.length > 0) {
      const etags = {};
      if (plan.pages.includes(1) && modState?.page1Etag) {
        etags[1] = modState.page1Etag;
      }
      fetchedPages = await fetchReleasePages(apiClient, mod.repo, {
        pages: plan.pages,
        etags,
      });
    }

    const fetchedReleases = [];
    let firstPageCount = null;
    for (const pageResult of fetchedPages) {
      if (pageResult.page === 1 && !pageResult.notModified) {
        firstPageCount = pageResult.items.length;
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

    // 按 tag 合并：抓到的页覆盖缓存同 tag（下载量更新），没抓到的旧条目保留
    const mergedReleases = mergeReleasesByTag(
      previous?.releases ?? [],
      metaMerged.releases,
    );
    const nextFile = buildReleasesFile({
      repo: mod.repo,
      releases: mergedReleases,
      generatedAt: now,
    });
    const changed = releaseFileBodyChanged(previous, nextFile);
    if (changed && !options.dryRun) {
      await writeJsonAtomic(resolveReleaseFile(outDir, relPath), nextFile);
    }
    const finalFile = changed ? nextFile : (previous ?? nextFile);

    // 更新本模组的分页调度状态
    const nextState = cloneModState(modState);
    for (const pageResult of fetchedPages) {
      const page = pageResult.page;
      if (page === 1) {
        nextState.page1FetchedAt = now;
        if (!pageResult.notModified) {
          nextState.page1Etag = pageResult.etag ?? null;
        }
      } else {
        nextState.pages[String(page)] = now;
      }
    }
    const neededPages = Math.max(
      1,
      Math.ceil(finalFile.releases.length / PER_PAGE),
    );
    for (const key of Object.keys(nextState.pages)) {
      if (Number(key) > neededPages) {
        delete nextState.pages[key];
      }
    }
    if (firstPageCount !== null && firstPageCount < PER_PAGE) {
      // 第 1 页不足 100 条：该模组没有更深页
      nextState.pages = {};
    }

    if (changed) {
      log(
        `[${mod.repo}] release ${nextFile.releases.length} 条，元数据新抓 ${metaMerged.metaFetched} 个、复用 ${metaMerged.metaReused} 个${options.dryRun ? '（dry-run 未写入）' : ''}`,
      );
    } else if (fetchedPages.length > 0) {
      log(
        `[${mod.repo}] release 内容未变（第 ${fetchedPages.map((page) => page.page).join('、')} 页已刷新，文件不重写）`,
      );
    }
    return {
      entry: buildIndexEntry(mod, finalFile, { relPath, oldEntry }),
      file: finalFile,
      state: nextState,
      skipped: null,
      changed,
    };
  } catch (error) {
    // 单页失败：保留旧数据/旧 state，记 skipped，不写坏文件
    console.error(`[跳过] ${mod.repo}：${error.message}`);
    return {
      entry: buildIndexEntry(mod, previous, { relPath, oldEntry }),
      file: previous,
      state: previousState.mods[mod.repo],
      skipped: { repo: mod.repo, reason: skipReason(error) },
      changed: false,
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

async function runMods(options, context) {
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
  const results = new Array(selected.length);
  let completed = 0;

  await Promise.all(
    selected.map((mod, index) =>
      apiPool.run(async () => {
        results[index] = await processMod({
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
        });
        completed += 1;
        if (!options.verbose && selected.length > 20 && completed % 50 === 0) {
          console.log(`进度：${completed}/${selected.length}`);
        }
      }),
    ),
  );

  const skipped = results.filter((result) => result.skipped).map((result) => result.skipped);
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
    const first = result.file?.releases?.[0] ?? null;
    return {
      repo: mod.repo,
      name: mod.name,
      author: mod.author,
      stars: mod.stars,
      releaseCount: result.entry.releaseCount,
      totalDownloads: result.entry.totalDownloads,
      allAssetsDownloads: result.entry.allAssetsDownloads,
      latestDownloads: result.entry.latestDownloads,
      latestSizeBytes: result.entry.latestSizeBytes,
      totalSizeBytes: result.entry.totalSizeBytes,
      latestTag: first?.tag ?? null,
      latestPrerelease: first ? first.prerelease : null,
      latestModVersion: first?.modVersion ?? null,
      latestMinGameVersion: first?.minGameVersion ?? null,
      iconUrl: modIconUrl(mod.repo, mod.hasIcon),
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
      `state ${stateChanged ? '已更新' : '未变'}，${skipped.length} 个抓取失败`,
  );
  if (skipped.length > 0) {
    const preview = skipped.slice(0, 5).map((item) => `${item.repo}（${item.reason}）`);
    console.warn(
      `[警告] ${skipped.length} 个仓库抓取失败，已保留旧数据：${preview.join('、')}${skipped.length > 5 ? ' 等' : ''}`,
    );
  }
  return { code: 0, changed, indexChanged, summaryChanged: summaryChanged || csvChanged, stateChanged };
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

async function runGate(options, context) {
  const file = path.join(context.outDir, GATE_REL_PATH);
  let previous = null;
  if (options.cache) {
    try {
      previous = await readJsonIfExists(file);
    } catch (error) {
      context.log(`[警告] 旧 mod-gate.json 不可用，按首次运行处理：${error.message}`);
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

  const baseline = await loadGateBaseline(context, previous?.rules);
  const previousByTag = new Map(
    (Array.isArray(previous?.versions) ? previous.versions : [])
      .filter((item) => typeof item?.tag === 'string')
      .map((item) => [item.tag, item]),
  );
  const resolvedPaths = new Set(
    Array.isArray(previous?.source?.resolvedPaths) ? previous.source.resolvedPaths : [],
  );
  const results = [];
  let previousHadConstants = false;

  for (const { tag, version } of regular) {
    const cached = previousByTag.get(tag);
    if (
      cached &&
      cached.source === 'game-source' &&
      Number.isInteger(cached.mod) &&
      Number.isInteger(cached.java)
    ) {
      results.push({ tag, version, mod: cached.mod, java: cached.java, source: 'game-source' });
      previousHadConstants = true;
      continue;
    }
    if (
      cached &&
      cached.source === 'baseline' &&
      Number.isInteger(cached.mod) &&
      Number.isInteger(cached.java)
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
        results.push({ tag, version, mod: lookup.mod, java: lookup.java, source: 'baseline' });
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
    results.push({ tag, version, mod: lookup.mod, java: lookup.java, source: 'baseline' });
    previousHadConstants = false;
  }

  const rules = mergeGateRules(results);
  const nextFile = buildGateFile({
    versions: results,
    rules,
    resolvedPaths: [...resolvedPaths],
    generatedAt: context.now,
  });
  const changed = gateBodyChanged(previous, nextFile);
  if (changed) {
    if (!options.dryRun) {
      await writeJsonAtomic(file, nextFile);
    }
    context.log(
      `[gate] ${results.length} 个版本，${rules.length} 条规则，源码常量版本 ${results.filter((item) => item.source === 'game-source').length} 个${options.dryRun ? '（dry-run 未写入）' : ''}`,
    );
    console.log(
      `[gate] 更新：${results.length} 个版本 / ${rules.length} 条规则，源码命中 ${results.filter((item) => item.source === 'game-source').length} 个`,
    );
  } else {
    console.log('[gate] 无变化，保留旧文件');
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
