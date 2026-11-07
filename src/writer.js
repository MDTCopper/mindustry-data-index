// 产物读写：原子写、内容比较（避免每日无意义重写）、releases 目录清理

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isReleasePageRelPath,
  releasesDirRelPath,
  releasesPageRelPath,
  releasesRelPath,
  resolveReleaseFileForDelete,
} from './paths.js';
import {
  pagesMetadata,
  pageFileBody,
  splitVersionsIntoPages,
} from './release-pages.js';

export const INDEX_FILE = 'index.json';
export const RELEASES_DIR = 'releases';

export async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`读取或解析 ${file} 失败：${error.message}`);
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`读取 ${file} 失败：${error.message}`);
  }
}

export async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

export async function ensureReleasesDir(outDir) {
  const dir = path.join(outDir, RELEASES_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

// per-mod 文件只存数据：source 是旧格式字段（读取时忽略），比较时也不看；
// generatedAt 变化不算内容变化，只有 releases/versions/modType 真的变了才重写。
// 比较前把 null 可选字段规范化掉，避免「往返后多出 null」被误判为变化。
function stripNullDeep(value) {
  if (Array.isArray(value)) {
    return value.map(stripNullDeep);
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) {
        continue;
      }
      result[key] = stripNullDeep(item);
    }
    return result;
  }
  return value;
}

function canonicalReleaseFile(file) {
  return JSON.stringify(
    stripNullDeep({
      formatVersion: file.formatVersion,
      repo: file.repo,
      modType: file.modType ?? null,
      versions: Array.isArray(file.versions) ? file.versions : null,
      releases: Array.isArray(file.releases) ? file.releases : null,
      meta: file.meta ?? null,
    }),
  );
}

export function releaseFileBodyChanged(previous, next) {
  if (!previous) {
    return true;
  }
  return canonicalReleaseFile(previous) !== canonicalReleaseFile(next);
}

// index.json 同理：generatedAt 每次都变，比较其余数据主体，没变化就不写
export function indexBodyChanged(previous, next) {
  if (!previous) {
    return true;
  }
  for (const field of ['formatVersion', 'source', 'mods', 'skipped']) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) {
      return true;
    }
  }
  return false;
}

// 递归枚举 releases/**/*.json（返回 posix 相对路径），兼容旧 flat 文件
export async function listReleaseFiles(outDir) {
  const releasesDir = path.join(outDir, RELEASES_DIR);
  const files = [];

  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' && dir === releasesDir) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const relPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(relPath);
      }
    }
  }

  await walk(releasesDir, RELEASES_DIR);
  return files.sort();
}

export async function deleteReleaseFile(outDir, relPath) {
  const file = resolveReleaseFileForDelete(outDir, relPath);
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// 计算 index 用的 pages 元数据（不写盘）
export function pagesForFile(repo, file) {
  const pages = splitVersionsIntoPages(file?.versions ?? []);
  if (pages.length === 1) {
    return [
      {
        page: 1,
        count: pages[0].count,
        gameVersionRanges: pages[0].gameVersionRanges,
        path: releasesRelPath(repo),
      },
    ];
  }
  return pagesMetadata(pages, (page) => releasesPageRelPath(repo, page));
}

// 文件需要从「单文件」迁移到「分页目录」：>200 个版本但单文件仍存在
export async function needsPageSplit(outDir, repo, file) {
  const pages = splitVersionsIntoPages(file?.versions ?? []);
  if (pages.length <= 1) {
    return false;
  }
  const single = await readJsonIfExists(path.join(outDir, releasesRelPath(repo))).catch(() => null);
  return Boolean(single);
}

// 读取多页版本文件（page-1..page-N）；没有分页目录时返回 null
export async function readReleasePages(outDir, repo) {
  const page1Path = path.join(outDir, releasesPageRelPath(repo, 1));
  const page1 = await readJsonIfExists(page1Path).catch(() => null);
  if (!page1) {
    // 单文件兼容：<=200 版本时仍写 releases/<owner>/<repo>.json
    const single = await readJsonIfExists(path.join(outDir, releasesRelPath(repo))).catch(() => null);
    if (single && Array.isArray(single.versions)) {
      return {
        ...single,
        pages: Array.isArray(single.pages)
          ? single.pages
          : [{ page: 1, count: single.versions.length, gameVersionRanges: [], path: releasesRelPath(repo) }],
      };
    }
    return null;
  }
  const pages = Array.isArray(page1.pages)
    ? page1.pages
    : [{ page: 1, path: releasesPageRelPath(repo, 1) }];
  const files = [page1];
  for (const meta of pages) {
    if (Number(meta.page) === 1) {
      continue;
    }
    const file = await readJsonIfExists(path.join(outDir, meta.path)).catch(() => null);
    if (file) {
      files.push(file);
    }
  }
  files.sort((left, right) => (Number(left.page) || 1) - (Number(right.page) || 1));
  return {
    formatVersion: page1.formatVersion,
    repo: page1.repo,
    generatedAt: page1.generatedAt,
    modType: page1.modType,
    ...(page1.meta ? { meta: page1.meta } : {}),
    versions: files.flatMap((file) => (Array.isArray(file.versions) ? file.versions : [])),
    pages,
  };
}

async function removeStalePageFiles(outDir, repo, keepCount) {
  const dir = path.join(outDir, releasesDirRelPath(repo));
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const name of entries) {
    const match = /^page-(\d+)\.json$/.exec(name);
    if (match && Number(match[1]) > keepCount) {
      await unlink(path.join(dir, name)).catch(() => {});
    }
  }
}

// 写版本列表：<=200 写单文件；>200 写 releases/<owner>/<repo>/page-N.json。
// 返回 index 用的 pages 元数据（含每页 gameVersionRanges 与 path）。
export async function writeReleasePages(outDir, repo, file) {
  const pages = splitVersionsIntoPages(file.versions ?? []);
  const singleRelPath = releasesRelPath(repo);
  const singlePath = path.join(outDir, singleRelPath);

  if (pages.length === 1) {
    const body = {
      formatVersion: file.formatVersion,
      repo: file.repo,
      generatedAt: file.generatedAt,
      modType: file.modType,
      ...(file.meta ? { meta: file.meta } : {}),
      versions: pages[0].versions,
    };
    const previous = await readJsonIfExists(singlePath).catch(() => null);
    if (releaseFileBodyChanged(previous, body)) {
      await writeJsonAtomic(singlePath, body);
    }
    await removeStalePageFiles(outDir, repo, 0);
    return [
      {
        page: 1,
        count: pages[0].count,
        gameVersionRanges: pages[0].gameVersionRanges,
        path: singleRelPath,
      },
    ];
  }

  const meta = pagesMetadata(pages, (page) => releasesPageRelPath(repo, page));
  for (const page of pages) {
    const relPath = releasesPageRelPath(repo, page.page);
    const body = {
      ...pageFileBody({ file, page }),
      ...(page.page === 1 ? { pages: meta } : {}),
    };
    const filePath = path.join(outDir, relPath);
    const previous = await readJsonIfExists(filePath).catch(() => null);
    if (JSON.stringify(previous) !== JSON.stringify(body)) {
      await writeJsonAtomic(filePath, body);
    }
  }
  await deleteReleaseFile(outDir, singleRelPath).catch(() => {});
  await removeStalePageFiles(outDir, repo, pages.length);
  return meta;
}

// 删除一个模组的分页目录与单文件（0 版本丢弃 / 清理时用）
export async function deleteReleaseData(outDir, repo) {
  await deleteReleaseFile(outDir, releasesRelPath(repo)).catch(() => {});
  const dir = path.join(outDir, releasesDirRelPath(repo));
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const { rmdir } = await import('node:fs/promises');
  for (const name of entries) {
    if (/^page-\d+\.json$/.test(name)) {
      await unlink(path.join(dir, name)).catch(() => {});
    }
  }
  await rmdir(dir).catch(() => {});
}

export { isReleasePageRelPath };
