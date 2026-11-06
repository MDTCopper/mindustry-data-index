// 产出路径与文件名映射：不复用文件名，保证路径可预测且不会写出目标目录

import path from 'node:path';

// repo 只允许 GitHub 的 owner/name 形态；档名与官方图标命名保持一致
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INDEX_FILE = 'index.json';
const RELEASES_DIR = 'releases';

export function assertRepo(repo) {
  if (
    typeof repo !== 'string' ||
    !REPO_PATTERN.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`非法 repo：${JSON.stringify(repo)}（应为 owner/name）`);
  }
  return repo;
}

// repo 里的 `/` 换成 `_`，保留大小写：Anuken/ExampleMod → Anuken_ExampleMod
export function releasesFileStem(repo) {
  return assertRepo(repo).replace('/', '_');
}

export function indexRelPath() {
  return INDEX_FILE;
}

export function releasesRelPath(repo) {
  return `${RELEASES_DIR}/${releasesFileStem(repo)}.json`;
}

// 写/删 releases 文件前的路径检查：必须落在 <out>/releases/ 下面
export function resolveReleaseFile(outDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.startsWith(`${RELEASES_DIR}/`)) {
    throw new Error(`非法 releases 路径：${JSON.stringify(relPath)}`);
  }
  const parts = relPath.split('/');
  if (parts.length !== 2 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`非法 releases 路径：${JSON.stringify(relPath)}`);
  }

  const releasesDir = path.resolve(outDir, RELEASES_DIR);
  const file = path.resolve(outDir, relPath);
  if (!file.startsWith(releasesDir + path.sep) || !file.endsWith('.json')) {
    throw new Error(`releases 路径越界：${JSON.stringify(relPath)}`);
  }
  return file;
}
