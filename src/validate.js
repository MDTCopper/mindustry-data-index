#!/usr/bin/env node
// 产物校验 CLI：检查 index.json 与 releases/*.json 的字段、一致性与路径

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { INDEX_FILE, RELEASES_DIR, listReleaseFiles } from './writer.js';

const USAGE = `用法：node src/validate.js [--dir <目录>]

选项：
  --dir <目录>   要校验的产物目录，默认 .
  --help         显示本帮助`;

const METADATA_STATUSES = new Set(['ok', 'missing', 'unparsed']);
const MOD_REQUIRED_STRINGS = [
  'repo',
  'internalName',
  'name',
  'author',
  'version',
  'minGameVersion',
  'lastUpdated',
];
const RELEASE_REQUIRED_STRINGS = [
  'tag',
  'name',
  'htmlUrl',
  'downloadUrl',
  'sourceArchiveUrl',
];

class UsageError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function validateReleaseFileData(file, { expectedRepo = null, errors }) {
  if (!isPlainObject(file)) {
    errors.push('release 文件顶层不是对象');
    return;
  }
  if (file.formatVersion !== 1) {
    errors.push(`formatVersion 应为 1，实际为 ${JSON.stringify(file.formatVersion)}`);
  }
  if (typeof file.repo !== 'string' || !/^[^/]+\/[^/]+$/.test(file.repo)) {
    errors.push(`repo 字段非法：${JSON.stringify(file.repo)}`);
  } else if (expectedRepo !== null && file.repo !== expectedRepo) {
    errors.push(`repo 与 index 不一致：文件为 ${file.repo}，index 为 ${expectedRepo}`);
  }
  if (!isIsoDate(file.generatedAt)) {
    errors.push('generatedAt 缺失或不是 ISO 时间');
  }
  if (!isPlainObject(file.source)) {
    errors.push('source 缺失');
  } else {
    if (file.source.releasesEtag !== null && typeof file.source.releasesEtag !== 'string') {
      errors.push('source.releasesEtag 应为字符串或 null');
    }
    if (
      file.source.releasesFetchedAt !== null &&
      !isIsoDate(file.source.releasesFetchedAt)
    ) {
      errors.push('source.releasesFetchedAt 应为 ISO 时间或 null');
    }
  }
  if (!Array.isArray(file.releases)) {
    errors.push('releases 不是数组');
    return;
  }

  const tags = new Set();
  const archivePrefix = file.repo
    ? `https://github.com/${file.repo}/archive/refs/tags/`
    : null;
  for (const [index, release] of file.releases.entries()) {
    const where = `releases[${index}]`;
    if (!isPlainObject(release)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    for (const field of RELEASE_REQUIRED_STRINGS) {
      if (typeof release[field] !== 'string' || release[field].length === 0) {
        errors.push(`${where}.${field} 缺失或不是非空字符串`);
      }
    }
    if (typeof release.tag === 'string') {
      if (tags.has(release.tag)) {
        errors.push(`${where}.tag 重复：${release.tag}`);
      }
      tags.add(release.tag);
    }
    if (typeof release.prerelease !== 'boolean') {
      errors.push(`${where}.prerelease 不是布尔值`);
    }
    if (release.publishedAt !== null && !isIsoDate(release.publishedAt)) {
      errors.push(`${where}.publishedAt 应为 ISO 时间或 null`);
    }
    for (const field of ['modVersion', 'minGameVersion']) {
      if (release[field] !== null && typeof release[field] !== 'string') {
        errors.push(`${where}.${field} 应为字符串或 null`);
      }
    }
    if (release.metadataPath !== null && typeof release.metadataPath !== 'string') {
      errors.push(`${where}.metadataPath 应为字符串或 null`);
    }
    if (!METADATA_STATUSES.has(release.metadataStatus)) {
      errors.push(
        `${where}.metadataStatus 非法：${JSON.stringify(release.metadataStatus)}`,
      );
    }
    if (
      typeof release.downloadUrl === 'string' &&
      !release.downloadUrl.startsWith('https://')
    ) {
      errors.push(`${where}.downloadUrl 不是 https 链接`);
    }
    if (archivePrefix && typeof release.sourceArchiveUrl === 'string') {
      if (!release.sourceArchiveUrl.startsWith(archivePrefix)) {
        errors.push(`${where}.sourceArchiveUrl 与 repo 不匹配`);
      }
    }
    if (!Array.isArray(release.assets)) {
      errors.push(`${where}.assets 不是数组`);
      continue;
    }
    for (const [assetIndex, asset] of release.assets.entries()) {
      if (
        !isPlainObject(asset) ||
        typeof asset.name !== 'string' ||
        typeof asset.size !== 'number' ||
        typeof asset.downloadCount !== 'number' ||
        typeof asset.downloadUrl !== 'string'
      ) {
        errors.push(`${where}.assets[${assetIndex}] 字段不完整`);
      }
    }
  }
}

export function validateIndexData(
  index,
  { errors, warnings, releaseFiles = null } = {},
) {
  if (!isPlainObject(index)) {
    errors.push('index.json 顶层不是对象');
    return { mods: [] };
  }
  if (index.formatVersion !== 1) {
    errors.push(`formatVersion 应为 1，实际为 ${JSON.stringify(index.formatVersion)}`);
  }
  if (!isIsoDate(index.generatedAt)) {
    errors.push('index.generatedAt 缺失或不是 ISO 时间');
  }
  if (!isPlainObject(index.source)) {
    errors.push('index.source 缺失');
  } else {
    if (
      typeof index.source.modsUrl !== 'string' ||
      !index.source.modsUrl.startsWith('https://')
    ) {
      errors.push('index.source.modsUrl 非法');
    }
    if (!Number.isInteger(index.source.modCount)) {
      errors.push('index.source.modCount 应为整数');
    }
  }
  if (!Array.isArray(index.mods)) {
    errors.push('index.mods 不是数组');
    return { mods: [] };
  }
  if (isPlainObject(index.source) && index.source.modCount !== index.mods.length) {
    errors.push(
      `index.source.modCount（${index.source.modCount}）与 mods 数量（${index.mods.length}）不一致`,
    );
  }

  const repos = new Set();
  for (const [position, mod] of index.mods.entries()) {
    const where = `mods[${position}]`;
    if (!isPlainObject(mod)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    for (const field of MOD_REQUIRED_STRINGS) {
      if (typeof mod[field] !== 'string') {
        errors.push(`${where}.${field} 应为字符串`);
      }
    }
    if (typeof mod.stars !== 'number') {
      errors.push(`${where}.stars 应为数字`);
    }
    for (const field of ['hasIcon', 'hasScripts', 'hasJava']) {
      if (typeof mod[field] !== 'boolean') {
        errors.push(`${where}.${field} 应为布尔值`);
      }
    }
    if (typeof mod.repo === 'string') {
      const key = mod.repo.toLowerCase();
      if (repos.has(key)) {
        errors.push(`${where}.repo 重复：${mod.repo}`);
      }
      repos.add(key);
    }
    if (mod.releasesPath !== null) {
      if (
        typeof mod.releasesPath !== 'string' ||
        !mod.releasesPath.startsWith(`${RELEASES_DIR}/`) ||
        !mod.releasesPath.endsWith('.json') ||
        mod.releasesPath.split('/').includes('..')
      ) {
        errors.push(`${where}.releasesPath 非法：${JSON.stringify(mod.releasesPath)}`);
      } else if (releaseFiles && !releaseFiles.has(mod.releasesPath)) {
        errors.push(`${where}.releasesPath 指向的文件不存在：${mod.releasesPath}`);
      }
    }
    if (!Number.isInteger(mod.releaseCount) || mod.releaseCount < 0) {
      errors.push(`${where}.releaseCount 应为非负整数`);
    }
    if (mod.latestRelease !== null) {
      if (
        !isPlainObject(mod.latestRelease) ||
        typeof mod.latestRelease.tag !== 'string' ||
        typeof mod.latestRelease.name !== 'string' ||
        typeof mod.latestRelease.prerelease !== 'boolean' ||
        (mod.latestRelease.publishedAt !== null &&
          typeof mod.latestRelease.publishedAt !== 'string')
      ) {
        errors.push(`${where}.latestRelease 字段不完整`);
      }
    }
    if (
      mod.releaseDataUpdatedAt !== null &&
      typeof mod.releaseDataUpdatedAt !== 'string'
    ) {
      errors.push(`${where}.releaseDataUpdatedAt 应为字符串或 null`);
    }
  }

  if (!Array.isArray(index.skipped)) {
    errors.push('index.skipped 不是数组');
  } else {
    for (const [position, skipped] of index.skipped.entries()) {
      if (
        !isPlainObject(skipped) ||
        typeof skipped.repo !== 'string' ||
        typeof skipped.reason !== 'string'
      ) {
        errors.push(`skipped[${position}] 字段不完整`);
        continue;
      }
      if (!repos.has(skipped.repo.toLowerCase())) {
        warnings?.push(`skipped 里的 ${skipped.repo} 不在 mods 列表中`);
      }
    }
  }

  return { mods: index.mods };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function validateDir(dir) {
  const outDir = path.resolve(dir);
  const errors = [];
  const warnings = [];
  const releaseFiles = new Set(await listReleaseFiles(outDir));

  let index;
  try {
    index = await readJson(path.join(outDir, INDEX_FILE));
  } catch (error) {
    errors.push(
      error.code === 'ENOENT'
        ? `找不到 ${INDEX_FILE}`
        : `${INDEX_FILE} 无法解析：${error.message}`,
    );
    return { errors, warnings, modCount: 0, releaseFileCount: releaseFiles.size };
  }

  validateIndexData(index, { errors, warnings, releaseFiles });

  const loaded = new Map();
  for (const relPath of releaseFiles) {
    try {
      loaded.set(relPath, await readJson(path.join(outDir, relPath)));
    } catch (error) {
      errors.push(`${relPath} 无法解析：${error.message}`);
    }
  }

  const usedFiles = new Set();
  const mods = Array.isArray(index.mods) ? index.mods : [];
  for (const mod of mods) {
    if (!isPlainObject(mod) || typeof mod.repo !== 'string') {
      continue;
    }
    if (typeof mod.releasesPath !== 'string' || mod.releasesPath.includes('..')) {
      continue;
    }
    const file = loaded.get(mod.releasesPath);
    if (!file) {
      continue;
    }
    usedFiles.add(mod.releasesPath);
    const fileErrors = [];
    validateReleaseFileData(file, { expectedRepo: mod.repo, errors: fileErrors });
    for (const message of fileErrors) {
      errors.push(`${mod.releasesPath}：${message}`);
    }
    if (!Array.isArray(file.releases)) {
      continue;
    }
    if (mod.releaseCount !== file.releases.length) {
      errors.push(
        `mods ${mod.repo} 的 releaseCount（${mod.releaseCount}）与文件条数（${file.releases.length}）不一致`,
      );
    }
    const firstTag = file.releases[0]?.tag ?? null;
    if ((mod.latestRelease?.tag ?? null) !== firstTag) {
      errors.push(
        `mods ${mod.repo} 的 latestRelease.tag（${mod.latestRelease?.tag ?? null}）与文件首条（${firstTag}）不一致`,
      );
    }
    if (mod.releaseDataUpdatedAt !== file.generatedAt) {
      errors.push(`mods ${mod.repo} 的 releaseDataUpdatedAt 与文件 generatedAt 不一致`);
    }
  }

  for (const relPath of releaseFiles) {
    if (!usedFiles.has(relPath)) {
      warnings.push(`${relPath} 没有被 index 引用`);
    }
  }

  return {
    errors,
    warnings,
    modCount: mods.length,
    releaseFileCount: releaseFiles.size,
  };
}

async function main(argv) {
  let dir = '.';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      console.log(USAGE);
      return 0;
    }
    if (arg === '--dir') {
      index += 1;
      if (index >= argv.length) {
        throw new UsageError('--dir 缺少值');
      }
      dir = argv[index];
      continue;
    }
    if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
      continue;
    }
    throw new UsageError(`未知参数：${arg}`);
  }

  const { errors, warnings, modCount, releaseFileCount } = await validateDir(dir);
  console.log(`校验目录：${path.resolve(dir)}`);
  console.log(`index.json：${modCount} 个模组，${releaseFileCount} 个 releases 文件`);
  for (const warning of warnings) {
    console.warn(`警告：${warning}`);
  }
  for (const error of errors) {
    console.error(`错误：${error}`);
  }
  console.log(`错误 ${errors.length} 个，警告 ${warnings.length} 个`);
  return errors.length === 0 ? 0 : 1;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof UsageError) {
        console.error(`参数错误：${error.message}\n`);
        console.log(USAGE);
        process.exitCode = 2;
        return;
      }
      console.error(`校验失败：${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
