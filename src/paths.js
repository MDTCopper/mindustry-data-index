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

// 分页目录：releases/<owner>/<repo>/page-N.json
export function releasesDirRelPath(repo) {
  const [owner, name] = assertRepo(repo).split('/');
  return `${RELEASES_DIR}/${owner}/${name}`;
}

export function releasesPageRelPath(repo, page) {
  const pageNumber = Number(page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error(`非法版本页码：${JSON.stringify(page)}`);
  }
  return `${releasesDirRelPath(repo)}/page-${pageNumber}.json`;
}

const PAGE_FILE_PATTERN = /^page-[1-9]\d*\.json$/;

export function isReleasePageRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.startsWith(`${RELEASES_DIR}/`)) {
    return false;
  }
  const parts = relPath.split('/');
  return parts.length === 4 && PAGE_FILE_PATTERN.test(parts[3]);
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
  const singleShape =
    parts.length === 3 &&
    isSafeReleaseSegments(parts) &&
    parts[2].endsWith('.json') &&
    parts[2].length > '.json'.length;
  const pageShape =
    parts.length === 4 && isSafeReleaseSegments(parts) && PAGE_FILE_PATTERN.test(parts[3]);
  if (!singleShape && !pageShape) {
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
    (parts.length === 4 && isSafeReleaseSegments(parts) && PAGE_FILE_PATTERN.test(parts[3])) ||
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
