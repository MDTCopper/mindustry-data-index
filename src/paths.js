// 产出路径与文件名映射：不复用文件名，保证路径可预测且不会写出目标目录

import path from 'node:path';

// repo 只允许 GitHub 的 owner/name 形态；新路径按 owner/repo 保留原大小写
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

// 旧文件名写法（owner_repo）只用于兼容读取历史 flat 文件
export function releasesFileStem(repo) {
  return assertRepo(repo).replace('/', '_');
}

export function indexRelPath() {
  return INDEX_FILE;
}

// 新路径：releases/<owner>/<repo>.json，保留大小写
export function releasesRelPath(repo) {
  const [owner, name] = assertRepo(repo).split('/');
  return `${RELEASES_DIR}/${owner}/${name}.json`;
}

// 旧 flat 路径：releases/<owner>_<repo>.json（仅迁移读取用）
export function releasesLegacyRelPath(repo) {
  return `${RELEASES_DIR}/${releasesFileStem(repo)}.json`;
}

function isSafeReleaseSegments(parts) {
  return parts.every(
    (part) => typeof part === 'string' && part !== '' && part !== '.' && part !== '..',
  );
}

// 写/读 releases 文件前的路径检查：必须是 releases/<owner>/<repo>.json 恰好三段
export function resolveReleaseFile(outDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.startsWith(`${RELEASES_DIR}/`)) {
    throw new Error(`非法 releases 路径：${JSON.stringify(relPath)}`);
  }
  const parts = relPath.split('/');
  if (
    parts.length !== 3 ||
    !isSafeReleaseSegments(parts) ||
    !parts[2].endsWith('.json') ||
    parts[2].length <= '.json'.length
  ) {
    throw new Error(`非法 releases 路径：${JSON.stringify(relPath)}`);
  }

  const releasesDir = path.resolve(outDir, RELEASES_DIR);
  const file = path.resolve(outDir, relPath);
  if (!file.startsWith(releasesDir + path.sep)) {
    throw new Error(`releases 路径越界：${JSON.stringify(relPath)}`);
  }
  return file;
}

// 删除/清理时允许旧 flat 路径（同样是 releases/ 下的安全路径）
export function resolveReleaseFileForDelete(outDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.startsWith(`${RELEASES_DIR}/`)) {
    throw new Error(`非法 releases 路径：${JSON.stringify(relPath)}`);
  }
  const parts = relPath.split('/');
  const validShape =
    (parts.length === 3 &&
      isSafeReleaseSegments(parts) &&
      parts[2].endsWith('.json') &&
      parts[2].length > '.json'.length) ||
    (parts.length === 2 &&
      isSafeReleaseSegments(parts) &&
      parts[1].endsWith('.json') &&
      parts[1].length > '.json'.length);
  if (!validShape) {
    throw new Error(`非法 releases 路径：${JSON.stringify(relPath)}`);
  }

  const releasesDir = path.resolve(outDir, RELEASES_DIR);
  const file = path.resolve(outDir, relPath);
  if (!file.startsWith(releasesDir + path.sep)) {
    throw new Error(`releases 路径越界：${JSON.stringify(relPath)}`);
  }
  return file;
}
