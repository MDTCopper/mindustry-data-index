#!/usr/bin/env node
// CLI 入口：官方 mods.json → 增量抓 release 与 mod 元数据 → 写 index.json 与 releases/*.json

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { HttpClient, HttpError, RateLimitError, createPool } from './github.js';
import { MODS_URL, fetchModsJson } from './mods-source.js';
import {
  fetchReleases,
  normalizeReleases,
  mergeReleaseMetadata,
  buildReleasesFile,
} from './releases.js';
import { fetchModMetadata } from './mod-meta.js';
import { releasesRelPath, resolveReleaseFile, assertRepo } from './paths.js';
import {
  readJsonIfExists,
  writeJsonAtomic,
  releaseFileBodyChanged,
  ensureReleasesDir,
  listReleaseFiles,
  deleteReleaseFile,
  INDEX_FILE,
} from './writer.js';

const USAGE = `用法：node src/main.js [选项]

选项：
  --out <目录>        产物目录，默认 .
  --token <token>     GitHub token，默认读环境变量 GITHUB_TOKEN
  --repos a/b,c/d     只跑指定仓库（本地验证用；此模式不清理其它文件，index 只含这些条目）
  --limit <n>         最多处理 n 个模组（官方列表顺序）
  --threads <n>       同时处理的仓库数，默认 8
  --raw-threads <n>   raw.githubusercontent 并发数，默认 16
  --no-cache          忽略旧产物，全量重抓（不使用 ETag、不复用旧数据）
  --keep-missing-files  不删除官方列表中已消失模组的 releases/*.json
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
    out: '.',
    token: process.env.GITHUB_TOKEN || null,
    repos: null,
    limit: null,
    threads: 8,
    rawThreads: 16,
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
  return options;
}

function buildIndexEntry(mod, file, { relPath, oldEntry = null } = {}) {
  const hasFile = Array.isArray(file?.releases);
  const releases = hasFile ? file.releases : [];
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
    releasesPath: hasFile
      ? relPath
      : (oldEntry?.releasesPath ?? (file ? relPath : null)),
    releaseCount,
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

async function processMod(context) {
  const { mod, options, rawPool, rawClient, apiClient, outDir, now, log, oldEntries } = context;
  const relPath = releasesRelPath(mod.repo);
  const oldEntry = oldEntries.get(mod.repo.toLowerCase()) ?? null;

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

  try {
    const fetched = await fetchReleases(apiClient, mod.repo, {
      etag: previous?.source?.releasesEtag ?? null,
    });

    if (fetched.notModified && previous) {
      log(
        `[${mod.repo}] releases 304，复用 ${previous.releases.length} 条旧数据，不再请求 mod.hjson`,
      );
      return {
        entry: buildIndexEntry(mod, previous, { relPath, oldEntry }),
        skipped: null,
        changed: false,
      };
    }

    const releases = normalizeReleases(fetched.raws, {
      repo: mod.repo,
      hasJava: mod.hasJava === true,
    });
    const merged = await mergeReleaseMetadata({
      previousReleases: previous?.releases ?? [],
      releases,
      fetchMetadata: (tag) =>
        rawPool.run(() =>
          fetchModMetadata(rawClient, {
            repo: mod.repo,
            tag,
            hasJava: mod.hasJava === true,
          }),
        ),
    });
    const nextFile = buildReleasesFile({
      repo: mod.repo,
      releases: merged.releases,
      etag: fetched.etag,
      fetchedAt: now,
    });
    const changed = releaseFileBodyChanged(previous, nextFile);
    if (changed) {
      if (!options.dryRun) {
        await writeJsonAtomic(resolveReleaseFile(outDir, relPath), nextFile);
      }
      log(
        `[${mod.repo}] release ${nextFile.releases.length} 条，元数据新抓 ${merged.metaFetched} 个、复用 ${merged.metaReused} 个${options.dryRun ? '（dry-run 未写入）' : ''}`,
      );
      return {
        entry: buildIndexEntry(mod, nextFile, { relPath, oldEntry }),
        skipped: null,
        changed: true,
      };
    }

    log(`[${mod.repo}] release 内容未变，保留旧文件`);
    return {
      entry: buildIndexEntry(mod, previous, { relPath, oldEntry }),
      skipped: null,
      changed: false,
    };
  } catch (error) {
    // 单个仓库失败不终止整体：旧文件与旧索引字段保留
    console.error(`[跳过] ${mod.repo}：${error.message}`);
    return {
      entry: buildIndexEntry(mod, previous, { relPath, oldEntry }),
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

  const startedAt = Date.now();
  const log = options.verbose ? (message) => console.log(message) : () => {};
  const httpLog = options.verbose ? (message) => console.log(`  [http] ${message}`) : null;
  const outDir = path.resolve(options.out);
  if (!options.dryRun) {
    await ensureReleasesDir(outDir);
  }

  const apiClient = new HttpClient({ token: options.token, logger: httpLog });
  // raw 域名不需要 token，也不该把凭据发过去
  const rawClient = new HttpClient({ token: null, logger: httpLog });

  let mods;
  try {
    mods = await fetchModsJson(rawClient);
  } catch (error) {
    console.error(`无法获取官方模组列表：${error.message}`);
    return 1;
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
      return 1;
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

  const rawPool = createPool(options.rawThreads);
  const apiPool = createPool(options.threads);
  const now = new Date().toISOString();
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
          log,
          oldEntries,
        });
        completed += 1;
        if (!options.verbose && selected.length > 20 && completed % 50 === 0) {
          console.log(`进度：${completed}/${selected.length}`);
        }
      }),
    ),
  );

  const skipped = results.filter((result) => result.skipped).map((result) => result.skipped);
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

  if (!options.dryRun) {
    await writeJsonAtomic(path.join(outDir, INDEX_FILE), index);
  }

  const isSubset = options.repos !== null || options.limit !== null;
  if (!options.dryRun && !options.keepMissingFiles && !isSubset) {
    await cleanupMissing(outDir, selected, log);
  }

  const changed = results.filter((result) => result.changed).length;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `完成：${selected.length} 个模组，${changed} 个 release 文件有变化，${skipped.length} 个抓取失败，用时 ${elapsed} 秒`,
  );
  if (skipped.length > 0) {
    const preview = skipped.slice(0, 5).map((item) => `${item.repo}（${item.reason}）`);
    console.warn(
      `[警告] ${skipped.length} 个仓库抓取失败，已保留旧数据：${preview.join('、')}${skipped.length > 5 ? ' 等' : ''}`,
    );
  }
  if (options.verbose) {
    const api = apiClient.stats;
    const raw = rawClient.stats;
    console.log(
      `请求统计：API ${api.requests} 次（304 ${api.notModified} 次、重试 ${api.retries} 次、限流等待 ${api.rateLimitWaits} 次），` +
        `raw ${raw.requests} 次，合计 ${api.requests + raw.requests} 次`,
    );
  }
  return 0;
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
