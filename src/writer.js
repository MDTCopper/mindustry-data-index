// 产物读写：原子写、内容比较（避免每日无意义重写）、releases 目录清理

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveReleaseFileForDelete } from './paths.js';

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

// per-mod 文件只存统计数据：source 是旧格式字段（读取时忽略），比较时也不看；
// generatedAt 变化不算内容变化，只有 releases（含下载量/体积/元数据）真的变了才重写
export function releaseFileBodyChanged(previous, next) {
  if (!previous) {
    return true;
  }
  if (previous.formatVersion !== next.formatVersion) {
    return true;
  }
  if (previous.repo !== next.repo) {
    return true;
  }
  return JSON.stringify(previous.releases) !== JSON.stringify(next.releases);
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
