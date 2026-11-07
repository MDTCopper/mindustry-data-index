#!/usr/bin/env node
// 产物校验 CLI：检查 index.json / releases/*.json / mindustry/versions.json / mindustry/mod-gate.json

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { INDEX_FILE, RELEASES_DIR, listReleaseFiles } from './writer.js';
import { MOD_ICON_BASE } from './mods-source.js';
import { computeModStats } from './stats.js';
import {
  SUMMARY_COLUMNS,
  parseCsv,
} from './summary.js';
import { REFRESH_STATE_REL_PATH } from './refresh-state.js';
import { COMMUNITY_DIR, COMMUNITY_STATE_REL_PATH } from './community.js';
import { latestCompatibleTag, parseGameVersion, gameVersionsFromFile } from './compat.js';
import { STATUS_REL_PATH, DATASET_KEYS } from './status.js';
import { CHANGES_REL_PATH, CHANGE_ACTIONS, MAX_CHANGES } from './changes.js';
import { VERSIONS_REL_PATH, VERSIONS_API } from './versions.js';
import {
  GATE_REL_PATHS,
  GATE_REPO,
  GATE_BASELINE_URL,
  gateStartVersion,
  gateTypeConfig,
  mergeGateRules,
} from './mod-gate.js';
import {
  HEAT_COMMIT_STATE_REL_PATH,
  HEAT_CREATED_STATE_REL_PATH,
  HEAT_HISTORY_DIR,
  HEAT_INDEX_REL_PATH,
  HEAT_SUMMARY_REL_PATH,
  HEAT_WINDOWS,
  UPDATE_WINDOWS,
  HISTORY_LIMITS,
  RECOMMEND_HIDDEN_REASONS,
  MIN_SCORE,
  FULL_INDEX_REL_PATH,
  COMMUNITY_FULL_INDEX_REL_PATH,
  SORT_KEYS,
  SORT_OPTIONS,
  DEFAULT_SORT,
} from './heat.js';

const HEARTBEAT_REL_PATH = 'mindustry/heartbeat.json';

const USAGE = `用法：node src/validate.js [--dir <目录>]

选项：
  --dir <目录>   要校验的产物目录，默认 .
  --help         显示本帮助`;

const METADATA_STATUSES = new Set(['ok', 'missing', 'unparsed']);
const GATE_SOURCES = new Set(['game-source', 'baseline', 'mixed']);
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

function isStringOrNull(value) {
  return value === null || typeof value === 'string';
}

function isNumberOrNull(value) {
  return value === null || typeof value === 'number';
}

// releases/<文件名>.json 的路径保护：按路径段判断，不能只看子串 `..`。
// 官方列表里确有 repo 名以点结尾（如 maksimk792/some-music.），文件名中间会出现合法的 `..`
// （releases/maksimk792_some-music..json），不能当成路径穿越。
// 口径与 paths.js 的 resolveReleaseFile 一致：只允许 releases/ 下的单层 .json。
// 新路径：releases/<owner>/<repo>.json 恰好三段；旧 flat 路径单独识别用于迁移 warning
export function isValidReleasesPath(relPath) {
  if (
    typeof relPath !== 'string' ||
    !relPath.startsWith(`${RELEASES_DIR}/`) ||
    !relPath.endsWith('.json')
  ) {
    return false;
  }
  const segments = relPath.split('/');
  if (segments.length === 4) {
    // 分页路径：releases/<owner>/<repo>/page-N.json
    const [dir, owner, repo, fileName] = segments;
    return (
      dir === RELEASES_DIR &&
      owner !== '' &&
      owner !== '.' &&
      owner !== '..' &&
      repo !== '' &&
      repo !== '.' &&
      repo !== '..' &&
      /^page-[1-9]\d*\.json$/.test(fileName)
    );
  }
  if (segments.length !== 3) {
    return false;
  }
  const [dir, owner, fileName] = segments;
  return (
    dir === RELEASES_DIR &&
    owner !== '' &&
    owner !== '.' &&
    owner !== '..' &&
    fileName !== '' &&
    fileName !== '.' &&
    fileName !== '..' &&
    fileName.length > '.json'.length
  );
}

export function isLegacyReleasesPath(relPath) {
  if (
    typeof relPath !== 'string' ||
    !relPath.startsWith(`${RELEASES_DIR}/`) ||
    !relPath.endsWith('.json')
  ) {
    return false;
  }
  const segments = relPath.split('/');
  if (segments.length !== 2) {
    return false;
  }
  const fileName = segments[1];
  return fileName !== '' && fileName !== '.' && fileName !== '..';
}

function validateV3VersionEntry(entry, { where, errors }) {
  if (!isPlainObject(entry)) {
    errors.push(`${where} 不是对象`);
    return;
  }
  for (const field of ['tag', 'kind', 'minGameVersion', 'downloadUrl']) {
    if (typeof entry[field] !== 'string' || !entry[field]) {
      errors.push(`${where}.${field} 应为非空字符串`);
    }
  }
  if (!['release', 'tag'].includes(entry.kind)) {
    errors.push(`${where}.kind 应为 release 或 tag`);
  }
  if (!Array.isArray(entry.gameVersionRanges)) {
    errors.push(`${where}.gameVersionRanges 不是数组`);
  } else {
    for (const [index, range] of entry.gameVersionRanges.entries()) {
      if (
        !isPlainObject(range) ||
        typeof range.from !== 'string' ||
        typeof range.to !== 'string'
      ) {
        errors.push(`${where}.gameVersionRanges[${index}] 应为 {from,to} 字符串`);
      }
    }
  }
  for (const field of ['modVersion', 'releasedAt', 'committedAt']) {
    if (field in entry && (entry[field] === null || typeof entry[field] !== 'string')) {
      errors.push(`${where}.${field} 若存在应为字符串（null 不应写出）`);
    }
  }
  for (const field of ['releasedAt', 'committedAt']) {
    if (field in entry && !isIsoDate(entry[field])) {
      errors.push(`${where}.${field} 不是 ISO 时间`);
    }
  }
  for (const field of ['sizeBytes', 'downloadCount']) {
    if (field in entry && (!Number.isInteger(entry[field]) || entry[field] < 0)) {
      errors.push(`${where}.${field} 应为非负整数`);
    }
  }
  for (const field of ['prerelease', 'removed']) {
    if (field in entry && typeof entry[field] !== 'boolean') {
      errors.push(`${where}.${field} 应为布尔值`);
    }
  }
  const allowed = new Set([
    'tag', 'kind', 'modVersion', 'minGameVersion', 'gameVersionRanges',
    'releasedAt', 'committedAt', 'downloadUrl', 'sizeBytes', 'downloadCount',
    'prerelease', 'removed', 'removedAt',
  ]);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) errors.push(`${where}.${key} 不是 v3 字段`);
  }
}

export function validateReleaseFileData(file, { expectedRepo = null, errors }) {
  if (!isPlainObject(file)) {
    errors.push('release 文件顶层不是对象');
    return;
  }
  if (file.formatVersion === 3) {
    if (typeof file.repo !== 'string' || !/^[^/]+\/[^/]+$/.test(file.repo)) {
      errors.push(`repo 字段非法：${JSON.stringify(file.repo)}`);
    } else if (expectedRepo !== null && file.repo !== expectedRepo) {
      errors.push(`repo 与 index 不一致：文件为 ${file.repo}，index 为 ${expectedRepo}`);
    }
    if (!isIsoDate(file.generatedAt)) errors.push('generatedAt 缺失或不是 ISO 时间');
    if (!['java', 'js', 'json'].includes(file.modType)) {
      errors.push(`modType 应为 java/js/json，实际 ${JSON.stringify(file.modType)}`);
    }
    if (!Array.isArray(file.versions)) {
      errors.push('versions 不是数组');
      return;
    }
    const tags = new Set();
    for (const [index, entry] of file.versions.entries()) {
      const where = `versions[${index}]`;
      validateV3VersionEntry(entry, { where, errors });
      if (entry?.tag) {
        if (tags.has(entry.tag)) errors.push(`${where}.tag 重复：${entry.tag}`);
        tags.add(entry.tag);
      }
    }
    return;
  }
  if (file.formatVersion !== 2) {
    errors.push(
      `formatVersion 应为 2（当前 schemaVersion），实际为 ${JSON.stringify(file.formatVersion)}；旧文件请运行 --migrate 或等下一次刷新迁移`,
    );
  }
  if (typeof file.repo !== 'string' || !/^[^/]+\/[^/]+$/.test(file.repo)) {
    errors.push(`repo 字段非法：${JSON.stringify(file.repo)}`);
  } else if (expectedRepo !== null && file.repo !== expectedRepo) {
    errors.push(`repo 与 index 不一致：文件为 ${file.repo}，index 为 ${expectedRepo}`);
  }
  if (!isIsoDate(file.generatedAt)) {
    errors.push('generatedAt 缺失或不是 ISO 时间');
  }
  // 新格式不再写 source（分页调度已挪到 state/refresh.json）；旧文件里的 source 兼容忽略
  if (!Array.isArray(file.releases)) {
    errors.push('releases 不是数组');
    return;
  }
  validateFileMeta(file, { errors });

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
    const tagOnly = release.hasRelease === false;
    if (typeof release.hasRelease !== 'boolean') {
      errors.push(`${where}.hasRelease 应为布尔值`);
    }
    if (tagOnly) {
      // 没有 GitHub Release 的 tag：无法判定 prerelease/发布时间，下载地址必须是源码归档
      if (release.prerelease !== null) {
        errors.push(`${where}.prerelease 在 hasRelease=false 时应为 null`);
      }
      if (release.publishedAt !== null) {
        errors.push(`${where}.publishedAt 在 hasRelease=false 时应为 null`);
      }
      if (Array.isArray(release.assets) && release.assets.length > 0) {
        errors.push(`${where}.assets 在 hasRelease=false 时应为空数组`);
      }
      if (release.downloadUrl !== release.sourceArchiveUrl) {
        errors.push(`${where}.downloadUrl 在 hasRelease=false 时应等于 sourceArchiveUrl`);
      }
    } else {
      if (typeof release.prerelease !== 'boolean') {
        errors.push(`${where}.prerelease 不是布尔值`);
      }
      if (release.publishedAt !== null && !isIsoDate(release.publishedAt)) {
        errors.push(`${where}.publishedAt 应为 ISO 时间或 null`);
      }
    }
    for (const field of ['modVersion', 'minGameVersion']) {
      if (release[field] !== null && typeof release[field] !== 'string') {
        errors.push(`${where}.${field} 应为字符串或 null`);
      }
    }
    if (release.metadataPath !== null && typeof release.metadataPath !== 'string') {
      errors.push(`${where}.metadataPath 应为字符串或 null`);
    }
    // commit sha：tag 被删后 archive/<sha>.zip 的兜底（旧数据可没有该字段）
    if (release.commitSha !== undefined && release.commitSha !== null) {
      if (
        typeof release.commitSha !== 'string' ||
        !/^[0-9a-f]{40}$/.test(release.commitSha)
      ) {
        errors.push(`${where}.commitSha 不是 40 位小写 SHA`);
      } else {
        const expectedArchive = `https://github.com/${file.repo}/archive/${release.commitSha}.zip`;
        if (release.archiveByCommitUrl !== expectedArchive) {
          errors.push(
            `${where}.archiveByCommitUrl 与 repo/sha 不一致：${JSON.stringify(release.archiveByCommitUrl)}`,
          );
        }
      }
    } else if (
      release.archiveByCommitUrl !== undefined &&
      release.archiveByCommitUrl !== null
    ) {
      errors.push(`${where}.archiveByCommitUrl 在没有 commitSha 时应为 null`);
    }
    // 上游删除留档
    if (release.removed !== undefined && typeof release.removed !== 'boolean') {
      errors.push(`${where}.removed 应为布尔值`);
    }
    if (release.removed === true) {
      if (!isIsoDate(release.removedAt)) {
        errors.push(`${where}.removedAt 在 removed=true 时应为 ISO 时间`);
      }
    } else if (release.removedAt !== undefined && release.removedAt !== null) {
      errors.push(`${where}.removedAt 应只在 removed=true 时存在`);
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

  validateCompatData(file, { tags, errors });
}

// C8：per-mod 最新 tag 元数据（拿不到为 null）
function validateFileMeta(file, { errors }) {
  if (file.meta === undefined) {
    errors.push('meta 缺失（新格式应为对象或 null）');
    return;
  }
  if (file.meta === null) {
    return;
  }
  const meta = file.meta;
  if (!isPlainObject(meta)) {
    errors.push('meta 不是对象或 null');
    return;
  }
  if (!isPlainObject(meta.dependencies)) {
    errors.push('meta.dependencies 应为对象');
  }
  for (const field of ['hidden', 'legacyCompatible', 'hasScripts', 'hasJava']) {
    if (typeof meta[field] !== 'boolean') {
      errors.push(`meta.${field} 应为布尔值`);
    }
  }
  if (meta.main !== null && meta.main !== undefined && typeof meta.main !== 'string') {
    errors.push('meta.main 应为字符串或 null');
  }
}

// compat：游戏版本 → 推荐 tag 的区间；必须引用存在的、未被删除的 tag，区间升序且不重叠
function validateCompatData(file, { tags, errors }) {
  if (!Array.isArray(file.compat)) {
    errors.push('compat 不是数组');
    return;
  }
  const releaseByTag = new Map();
  for (const release of file.releases) {
    if (release && typeof release.tag === 'string') {
      releaseByTag.set(release.tag, release);
    }
  }
  let previous = null;
  for (const [index, item] of file.compat.entries()) {
    const where = `compat[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    if (typeof item.tag !== 'string' || !releaseByTag.has(item.tag)) {
      errors.push(`${where}.tag 不存在于 releases：${JSON.stringify(item.tag)}`);
    } else if (releaseByTag.get(item.tag).removed === true) {
      errors.push(`${where}.tag 指向已删除留档的条目：${item.tag}`);
    }
    if (item.modVersion !== null && typeof item.modVersion !== 'string') {
      errors.push(`${where}.modVersion 应为字符串或 null`);
    }
    if (typeof item.minGameVersion !== 'string') {
      errors.push(`${where}.minGameVersion 应为字符串`);
    }
    const min = parseGameVersion(item.minGameVersion);
    if (min === null) {
      errors.push(`${where}.minGameVersion 无法解析为数字`);
    }
    if (item.maxGameVersion !== null && !Number.isFinite(item.maxGameVersion)) {
      errors.push(`${where}.maxGameVersion 应为数字或 null`);
    }
    if (
      min !== null &&
      Number.isFinite(item.maxGameVersion) &&
      item.maxGameVersion <= min
    ) {
      errors.push(`${where}.maxGameVersion 必须大于 minGameVersion`);
    }
    if (typeof item.hasRelease !== 'boolean') {
      errors.push(`${where}.hasRelease 应为布尔值`);
    } else if (releaseByTag.has(item.tag) && releaseByTag.get(item.tag).hasRelease !== item.hasRelease) {
      errors.push(`${where}.hasRelease 与 releases 条目不一致`);
    }
    if (previous) {
      const prevMin = parseGameVersion(previous.minGameVersion);
      if (prevMin !== null && min !== null && prevMin > min) {
        errors.push(`${where} 没有按 minGameVersion 升序排列`);
      }
      if (previous.maxGameVersion !== null && min !== null && previous.maxGameVersion > min) {
        errors.push(`${where} 与上一段区间重叠`);
      }
      if (previous.maxGameVersion === null) {
        errors.push(`${where} 在上一段无上界区间之后仍然存在`);
      }
    }
    previous = item;
  }
}

// 模组列表里的 score 对象：只含组件分与 recommendVisible；总分与排名由客户端/ranks 提供
export function validateIndexHeat(mod, { where, errors }) {
  const score = mod.score;
  if (!isPlainObject(score)) {
    errors.push(`${where}.score 缺失或不是对象`);
    return;
  }
  const expected = [
    'downloadsScore',
    'starsScore',
    'updateScore',
    'penaltyScore',
    'newModMultiplier',
    'recommendVisible',
  ];
  for (const key of Object.keys(score)) {
    if (!expected.includes(key)) {
      errors.push(`${where}.score 含多余字段 ${key}（只允许 6 个字段）`);
    }
  }
  for (const field of ['downloadsScore', 'starsScore', 'updateScore', 'penaltyScore', 'newModMultiplier']) {
    if (!isFiniteNumberOrNull(score[field])) {
      errors.push(`${where}.score.${field} 应为有限数字`);
    }
  }
  if (typeof score.recommendVisible !== 'boolean') {
    errors.push(`${where}.score.recommendVisible 应为布尔值`);
  }
  if (expected.some((field) => !(field in score))) {
    errors.push(`${where}.score 缺少 6 个字段之一：${expected.join(', ')}`);
  }
  const ranks = mod.ranks;
  if (ranks !== undefined) {
    if (!isPlainObject(ranks)) {
      errors.push(`${where}.ranks 应为对象`);
      return;
    }
    for (const key of SORT_KEYS) {
      if (!Number.isInteger(ranks[key]) || ranks[key] < 1) {
        errors.push(`${where}.ranks.${key} 应为正整数`);
      }
    }
    for (const key of Object.keys(ranks)) {
      if (!SORT_KEYS.includes(key)) {
        errors.push(`${where}.ranks 含未知排序键：${key}`);
      }
    }
  }
}

// 默认列表必须严格等于全量列表按 recommendVisible 过滤（保持顺序/heat 一致）
export function validateDefaultListConsistency(defaultIndex, fullIndex, { label, errors }) {
  if (!isPlainObject(defaultIndex) || !Array.isArray(defaultIndex.mods)) {
    errors.push(`${label} 默认列表缺失或 mods 不是数组`);
    return;
  }
  if (!isPlainObject(fullIndex) || !Array.isArray(fullIndex.mods)) {
    errors.push(`${label} 全量列表缺失或 mods 不是数组`);
    return;
  }
  const expected = fullIndex.mods.filter((mod) => mod?.score?.recommendVisible === true);
  const defaultRepos = defaultIndex.mods.map((mod) => mod?.repo);
  const expectedRepos = expected.map((mod) => mod?.repo);
  if (JSON.stringify(defaultRepos) !== JSON.stringify(expectedRepos)) {
    errors.push(`${label} 默认列表必须等于全量列表按 recommendVisible 过滤的结果`);
    return;
  }
  for (const [position, mod] of defaultIndex.mods.entries()) {
    if (JSON.stringify(mod.score) !== JSON.stringify(expected[position].score)) {
      errors.push(`${label} 默认列表 ${mod.repo} 的 heat 与全量列表不一致`);
    }
  }
  // 全量列表里隐藏项必须 recommendVisible=false，可见项 true（按定义即可，额外校验字段存在）
  for (const mod of fullIndex.mods) {
    if (typeof mod?.score?.recommendVisible !== 'boolean') {
      errors.push(`${label} 全量列表 ${mod?.repo} 缺少 heat.recommendVisible`);
    }
  }
}

function validateIndexDataV3(index, { errors, warnings, releaseFiles = null, mode = 'official', officialRepos = null }) {
  const label = mode === 'community' ? 'community/index.json' : 'index.json';
  if (mode === 'official' && !Number.isInteger(index.source?.modCount)) {
    errors.push(`${label}.source.modCount 应为整数`);
  }
  if (!Array.isArray(index.mods)) {
    errors.push(`${label}.mods 不是数组`);
    return;
  }
  const removedFields = [
    'iosCompatible', 'legacyCompatible', 'removedCount', 'latestDownloads',
    'totalSizeBytes', 'latestRelease', 'latestSizeBytes', 'lastUpdated',
    'hasJava', 'hasScripts', 'latestCompatible', 'compatRanges',
  ];
  const repos = new Set();
  for (const [position, mod] of index.mods.entries()) {
    const where = `${label} mods[${position}]`;
    if (!isPlainObject(mod)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    if (typeof mod.repo !== 'string') errors.push(`${where}.repo 缺失`);
    else if (repos.has(mod.repo.toLowerCase())) errors.push(`${where}.repo 重复`);
    else if (officialRepos?.has(mod.repo.toLowerCase())) {
      errors.push(`${where}.repo 与官方列表重复：${mod.repo}`);
    } else repos.add(mod.repo.toLowerCase());
    for (const field of removedFields) {
      if (field in mod) errors.push(`${where}.${field} 是 v2 字段，v3 已删除`);
    }
    for (const field of ['name', 'author', 'minGameVersion', 'releasesPath']) {
      if (typeof mod[field] !== 'string' || !mod[field]) {
        errors.push(`${where}.${field} 应为非空字符串`);
      }
    }
    if (typeof mod.releasesPath === 'string' && !isValidReleasesPath(mod.releasesPath) && !mod.releasesPath.startsWith('community/')) {
      errors.push(`${where}.releasesPath 非法`);
    }
    for (const field of ['namePlain', 'authorPlain', 'descriptionPlain']) {
      if (typeof mod[field] !== 'string') errors.push(`${where}.${field} 应为字符串`);
    }
    if (!['java', 'js', 'json'].includes(mod.modType)) {
      errors.push(`${where}.modType 应为 java/js/json`);
    }
    if (!Array.isArray(mod.gameVersionRanges)) {
      errors.push(`${where}.gameVersionRanges 不是数组`);
    }
    for (const field of ['releaseUpdatedAt', 'commitUpdatedAt']) {
      if (field in mod && mod[field] !== null && !isIsoDate(mod[field])) {
        errors.push(`${where}.${field} 应为 ISO 时间或 null`);
      }
    }
    if (!Number.isInteger(mod.releaseCount) || mod.releaseCount < 0) {
      errors.push(`${where}.releaseCount 应为非负整数`);
    }
    if (mod.modType !== 'java') {
      if (!Number.isInteger(mod.tagCount) || mod.tagCount < 0) {
        errors.push(`${where}.tagCount 应为非负整数（非 Java）`);
      }
    } else if ('tagCount' in mod) {
      errors.push(`${where}.tagCount 不应写给 Java 模组`);
    }
    for (const field of ['stars', 'totalDownloads', 'allAssetsDownloads']) {
      if (!Number.isInteger(mod[field]) || mod[field] < 0) {
        errors.push(`${where}.${field} 应为非负整数`);
      }
    }
    if (mode === 'official') {
      if (mod.hasIcon === false && mod.iconUrl !== null) {
        errors.push(`${where}.iconUrl 与 repo/hasIcon 不一致（hasIcon=false 应为 null）`);
      }
      if (mod.iconUrl !== null && typeof mod.iconUrl === 'string') {
        const expected = `https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/${mod.repo?.replace('/', '_')}`;
        if (mod.iconUrl !== expected) {
          errors.push(`${where}.iconUrl 与 repo/hasIcon 不一致`);
        }
      }
    }
    if (mod.iconHash !== null && typeof mod.iconHash !== 'string') {
      errors.push(`${where}.iconHash 应为字符串或 null`);
    }
    if (!mod.score) {
      errors.push(`${where}.score 缺失或不是对象（热度已合并进 index.json）`);
    } else {
      validateIndexHeat(mod, { where, errors });
    }
    if (mode === 'community' && mod.source !== 'topic') {
      errors.push(`${where}.source 应为 "topic"`);
    }
  }
  if (releaseFiles) {
    const referenced = new Set();
    for (const mod of index.mods ?? []) {
      if (typeof mod?.releasesPath === 'string') {
        referenced.add(mod.releasesPath);
      }
      for (const page of Array.isArray(mod?.pages) ? mod.pages : []) {
        if (typeof page?.path === 'string') {
          referenced.add(page.path);
        }
      }
    }
    for (const relPath of releaseFiles) {
      if (!referenced.has(relPath)) {
        warnings.push(`${relPath} 没有被 index 引用`);
      }
    }
  }
}

export function validateIndexData(
  index,
  { errors, warnings, releaseFiles = null, mode = 'official', officialRepos = null } = {},
) {
  const community = mode === 'community';
  const label = community ? 'community/index.json' : 'index.json';
  if (!isPlainObject(index)) {
    errors.push(`${label} 顶层不是对象`);
    return { mods: [] };
  }
  if (index.formatVersion === 3) {
    if (mode === 'community' && index.source?.source !== 'topic') {
      errors.push(`${label}.source.source 应为 "topic"`);
    }
    validateIndexDataV3(index, { errors, warnings, releaseFiles, mode, officialRepos });
    return { mods: index.mods ?? [] };
  }
  if (index.formatVersion !== 1) {
    errors.push(`${label}.formatVersion 应为 1，实际为 ${JSON.stringify(index.formatVersion)}`);
  }
  if (!isIsoDate(index.generatedAt)) {
    errors.push(`${label}.generatedAt 缺失或不是 ISO 时间`);
  }
  if (!isPlainObject(index.source)) {
    errors.push(`${label}.source 缺失`);
  } else if (community) {
    // 社区来源固定为 topic；query 供追踪发现方式
    if (index.source.source !== 'topic') {
      errors.push(`${label}.source.source 应为 "topic"`);
    }
    if (typeof index.source.query !== 'string' || index.source.query.length === 0) {
      errors.push(`${label}.source.query 应为非空字符串`);
    }
    if (index.source.officialCount !== undefined && !Number.isInteger(index.source.officialCount)) {
      errors.push(`${label}.source.officialCount 应为整数`);
    }
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
    errors.push(`${label}.mods 不是数组`);
    return { mods: [] };
  }
  if (!community && isPlainObject(index.source) && index.source.modCount !== index.mods.length) {
    errors.push(
      `index.source.modCount（${index.source.modCount}）与 mods 数量（${index.mods.length}）不一致`,
    );
  }

  const repos = new Set();
  for (const [position, mod] of index.mods.entries()) {
    const where = `${label} mods[${position}]`;
    if (!isPlainObject(mod)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    if (community) {
      if (typeof mod.repo !== 'string') {
        errors.push(`${where}.repo 应为字符串`);
      }
      if (mod.source !== 'topic') {
        errors.push(`${where}.source 应为 "topic"`);
      }
      for (const field of ['name', 'author']) {
        if (typeof mod[field] !== 'string') {
          errors.push(`${where}.${field} 应为字符串`);
        }
      }
      for (const field of ['version', 'minGameVersion', 'lastUpdated', 'iconUrl', 'description']) {
        if (mod[field] !== undefined && mod[field] !== null && typeof mod[field] !== 'string') {
          errors.push(`${where}.${field} 应为字符串或 null`);
        }
      }
      if (mod.internalName !== null && mod.internalName !== undefined) {
        errors.push(`${where}.internalName 应为 null（社区模组无官方内部名）`);
      }
      if (mod.iconUrl !== null && typeof mod.iconUrl !== 'string') {
        errors.push(`${where}.iconUrl 应为字符串或 null`);
      } else if (typeof mod.iconUrl === 'string' && !mod.iconUrl.startsWith('https://')) {
        errors.push(`${where}.iconUrl 不是 https 链接`);
      }
      if (typeof mod.repo === 'string' && officialRepos?.has(mod.repo.toLowerCase())) {
        errors.push(`${where}.repo 与官方列表重复：${mod.repo}`);
      }
    } else {
      for (const field of MOD_REQUIRED_STRINGS) {
        if (typeof mod[field] !== 'string') {
          errors.push(`${where}.${field} 应为字符串`);
        }
      }
    }
    // C10：纯文本搜索字段；C8：iOS / legacy 兼容标记（官方列表透传，社区无来源为 null）
    for (const field of ['namePlain', 'authorPlain', 'descriptionPlain']) {
      if (typeof mod[field] !== 'string') {
        errors.push(`${where}.${field} 应为字符串`);
      }
    }
    for (const field of ['iosCompatible', 'legacyCompatible']) {
      if (mod[field] !== null && mod[field] !== undefined && typeof mod[field] !== 'boolean') {
        errors.push(`${where}.${field} 应为布尔值或 null`);
      }
    }
    validateIndexHeat(mod, { where, errors });
    if (typeof mod.stars !== 'number') {
      errors.push(`${where}.stars 应为数字`);
    }
    if (mod.hasIcon !== null && typeof mod.hasIcon !== 'boolean') {
      errors.push(`${where}.hasIcon 应为布尔值或 null`);
    }
    for (const field of ['hasScripts', 'hasJava']) {
      if (typeof mod[field] !== 'boolean') {
        errors.push(`${where}.${field} 应为布尔值`);
      }
    }
    // iconUrl 与 repo / hasIcon 必须一致；社区模组用仓库内真实图标地址，只要求 https/null
    if (mod.iconUrl !== null && typeof mod.iconUrl !== 'string') {
      errors.push(`${where}.iconUrl 应为字符串或 null`);
    } else if (!community && typeof mod.repo === 'string' && /^[^/]+\/[^/]+$/.test(mod.repo)) {
      const expected =
        mod.hasIcon === false
          ? null
          : `${MOD_ICON_BASE}/${mod.repo.replace('/', '_')}`;
      if (mod.iconUrl !== expected) {
        errors.push(`${where}.iconUrl 与 repo/hasIcon 不一致：${JSON.stringify(mod.iconUrl)}`);
      }
    }
    if (mod.iconHash !== null && (typeof mod.iconHash !== 'string' || mod.iconHash.length === 0)) {
      errors.push(`${where}.iconHash 应为非空字符串或 null`);
    }
    if (typeof mod.repo === 'string') {
      const key = mod.repo.toLowerCase();
      if (repos.has(key)) {
        errors.push(`${where}.repo 重复：${mod.repo}`);
      }
      repos.add(key);
    }
    if (mod.releasesPath !== null) {
      if (community) {
        const prefix = `${COMMUNITY_DIR}/`;
        const relative = mod.releasesPath.startsWith(prefix)
          ? mod.releasesPath.slice(prefix.length)
          : null;
        if (!relative || !isValidReleasesPath(relative)) {
          errors.push(`${where}.releasesPath 非法：${JSON.stringify(mod.releasesPath)}`);
        } else if (releaseFiles && !releaseFiles.has(mod.releasesPath)) {
          errors.push(`${where}.releasesPath 指向的文件不存在：${mod.releasesPath}`);
        }
      } else if (!isValidReleasesPath(mod.releasesPath)) {
        errors.push(`${where}.releasesPath 非法：${JSON.stringify(mod.releasesPath)}`);
      } else if (releaseFiles && !releaseFiles.has(mod.releasesPath)) {
        errors.push(`${where}.releasesPath 指向的文件不存在：${mod.releasesPath}`);
      }
    }
    if (!Number.isInteger(mod.releaseCount) || mod.releaseCount < 0) {
      errors.push(`${where}.releaseCount 应为非负整数`);
    }
    if (!Number.isInteger(mod.tagCount) || mod.tagCount < 0) {
      errors.push(`${where}.tagCount 应为非负整数`);
    }
    if (
      Number.isInteger(mod.releaseCount) &&
      Number.isInteger(mod.tagCount) &&
      mod.releaseCount > mod.tagCount
    ) {
      errors.push(`${where}.releaseCount 不能大于 tagCount`);
    }
    if (!Number.isInteger(mod.removedCount) || mod.removedCount < 0) {
      errors.push(`${where}.removedCount 应为非负整数`);
    } else if (Number.isInteger(mod.tagCount) && mod.removedCount > mod.tagCount) {
      errors.push(`${where}.removedCount 不能大于 tagCount`);
    }
    if (!Number.isInteger(mod.compatRanges) || mod.compatRanges < 0) {
      errors.push(`${where}.compatRanges 应为非负整数`);
    }
    if (
      mod.latestCompatible !== null &&
      mod.latestCompatible !== undefined &&
      typeof mod.latestCompatible !== 'string'
    ) {
      errors.push(`${where}.latestCompatible 应为字符串或 null`);
    }
    for (const field of ['totalDownloads', 'allAssetsDownloads', 'latestDownloads']) {
      if (!Number.isInteger(mod[field]) || mod[field] < 0) {
        errors.push(`${where}.${field} 应为非负整数`);
      }
    }
    for (const field of ['latestSizeBytes', 'totalSizeBytes']) {
      if (mod[field] !== null && (!Number.isInteger(mod[field]) || mod[field] < 0)) {
        errors.push(`${where}.${field} 应为非负整数或 null`);
      }
    }
    if (mod.latestRelease !== null) {
      if (
        !isPlainObject(mod.latestRelease) ||
        typeof mod.latestRelease.tag !== 'string' ||
        typeof mod.latestRelease.name !== 'string' ||
        typeof mod.latestRelease.prerelease !== 'boolean' ||
        (mod.latestRelease.publishedAt !== null &&
          typeof mod.latestRelease.publishedAt !== 'string') ||
        !Number.isInteger(mod.latestRelease.downloads) ||
        (mod.latestRelease.sizeBytes !== null &&
          (!Number.isInteger(mod.latestRelease.sizeBytes) ||
            mod.latestRelease.sizeBytes < 0))
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

// 启动器快照形状的单条 release（versions.json 的 releases / latest_be）
function validateTrimmedRelease(release, where, { errors, requireReactions }) {
  if (!isPlainObject(release)) {
    errors.push(`${where} 不是对象`);
    return;
  }
  if (!isStringOrNull(release.name)) {
    errors.push(`${where}.name 应为字符串或 null`);
  }
  if (typeof release.tag_name !== 'string' || release.tag_name.length === 0) {
    errors.push(`${where}.tag_name 缺失或不是非空字符串`);
  }
  if (!isStringOrNull(release.published_at)) {
    errors.push(`${where}.published_at 应为字符串或 null`);
  }
  if (release.body !== '') {
    errors.push(`${where}.body 应为空串`);
  }
  if (requireReactions) {
    if (
      !isPlainObject(release.reactions) ||
      typeof release.reactions.total_count !== 'number'
    ) {
      errors.push(`${where}.reactions.total_count 缺失或不是数字`);
    }
  } else if (Object.prototype.hasOwnProperty.call(release, 'reactions')) {
    errors.push(`${where} 不应带 reactions（BE 用 reactions == null 识别）`);
  }
  if (!Array.isArray(release.assets)) {
    errors.push(`${where}.assets 不是数组`);
    return;
  }
  for (const [index, asset] of release.assets.entries()) {
    if (
      !isPlainObject(asset) ||
      typeof asset.name !== 'string' ||
      typeof asset.size !== 'number' ||
      typeof asset.download_count !== 'number' ||
      typeof asset.browser_download_url !== 'string'
    ) {
      errors.push(`${where}.assets[${index}] 字段不完整`);
    }
  }
}

export function validateVersionsData(file, { errors, warnings } = {}) {
  if (!isPlainObject(file)) {
    errors.push('versions.json 顶层不是对象');
    return { releaseCount: 0, latestBe: null };
  }
  if (!isIsoDate(file.update_time)) {
    errors.push('versions.update_time 缺失或不是 ISO 时间');
  }
  if (file.source !== VERSIONS_API) {
    errors.push(`versions.source 应为 ${VERSIONS_API}`);
  }
  const tags = new Set();
  if (!Array.isArray(file.releases)) {
    errors.push('versions.releases 不是数组');
    return { releaseCount: 0, latestBe: null };
  }
  for (const [index, release] of file.releases.entries()) {
    const where = `releases[${index}]`;
    validateTrimmedRelease(release, where, { errors, requireReactions: true });
    if (typeof release?.tag_name === 'string') {
      if (tags.has(release.tag_name)) {
        errors.push(`${where}.tag_name 重复：${release.tag_name}`);
      }
      tags.add(release.tag_name);
    }
  }

  if (file.latest_be !== null) {
    validateTrimmedRelease(file.latest_be, 'latest_be', {
      errors,
      requireReactions: false,
    });
  }

  if (file.etags !== undefined) {
    if (!isPlainObject(file.etags)) {
      errors.push('versions.etags 应为对象');
    } else {
      for (const field of ['releases', 'latestBe']) {
        if (!isStringOrNull(file.etags[field] ?? null)) {
          errors.push(`versions.etags.${field} 应为字符串或 null`);
        }
      }
    }
  }

  if (tags.size === 0) {
    warnings?.push('versions.releases 是空的');
  }
  return {
    releaseCount: file.releases.length,
    latestBe: isPlainObject(file.latest_be) ? file.latest_be.tag_name : null,
  };
}

export function validateGateData(file, { type, errors } = {}) {
  const config = gateTypeConfig(type);
  const label = `${config.gate}-gate`;
  if (!isPlainObject(file)) {
    errors.push(`${label}.json 顶层不是对象`);
    return { versionCount: 0, ruleCount: 0 };
  }
  if (file.formatVersion !== 1) {
    errors.push(`${label}.formatVersion 应为 1，实际为 ${JSON.stringify(file.formatVersion)}`);
  }
  if (file.gate !== config.gate) {
    errors.push(`${label}.gate 应为 ${config.gate}，实际为 ${JSON.stringify(file.gate)}`);
  }
  if (!isIsoDate(file.generatedAt)) {
    errors.push(`${label}.generatedAt 缺失或不是 ISO 时间`);
  }
  if (!isPlainObject(file.source)) {
    errors.push(`${label}.source 缺失`);
  } else {
    if (file.source.repo !== GATE_REPO) {
      errors.push(`${label}.source.repo 应为 ${GATE_REPO}`);
    }
    if (
      typeof file.source.baseline !== 'string' ||
      !file.source.baseline.startsWith('https://')
    ) {
      errors.push(`${label}.source.baseline 应为 https 地址`);
    }
    if (file.source.baseline !== GATE_BASELINE_URL) {
      errors.push(`${label}.source.baseline 应为 ${GATE_BASELINE_URL}`);
    }
    if (
      !Array.isArray(file.source.constants) ||
      file.source.constants.length !== 1 ||
      file.source.constants[0] !== config.constant
    ) {
      errors.push(`${label}.source.constants 应只包含 ${config.constant}`);
    }
    if (
      !Array.isArray(file.source.resolvedPaths) ||
      file.source.resolvedPaths.some((item) => typeof item !== 'string')
    ) {
      errors.push(`${label}.source.resolvedPaths 应为字符串数组`);
    }
  }

  if (!Array.isArray(file.rules) || file.rules.length === 0) {
    errors.push(`${label}.rules 不是非空数组`);
    return { versionCount: 0, ruleCount: 0 };
  }
  const rules = file.rules;
  for (const [index, rule] of rules.entries()) {
    const where = `rules[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    if (typeof rule.min !== 'number' || !Number.isFinite(rule.min)) {
      errors.push(`${where}.min 不是数字`);
    }
    if (!isNumberOrNull(rule.max)) {
      errors.push(`${where}.max 应为数字或 null`);
    }
    if (!Number.isInteger(rule.value)) {
      errors.push(`${where}.value 应为整数`);
    }
    if (!GATE_SOURCES.has(rule.source)) {
      errors.push(`${where}.source 非法：${JSON.stringify(rule.source)}`);
    }
  }
  if (rules[0]?.min !== gateStartVersion()) {
    errors.push(`rules[0].min 应为 ${gateStartVersion()}（与 mmgvm 口径一致）`);
  }
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const next = rules[index + 1];
    if (rule?.max === null && next !== undefined) {
      errors.push(`rules[${index}].max 只有最后一条可以为 null`);
    }
    if (typeof rule?.max === 'number' && typeof rule?.min === 'number') {
      if (!(rule.max > rule.min)) {
        errors.push(`rules[${index}] 的 max 必须大于 min`);
      }
      if (next !== undefined && next.min !== rule.max) {
        errors.push(`rules[${index}] 与下一条不连续：max=${rule.max}，next.min=${next.min}`);
      }
    }
    if (next !== undefined && rule?.value === next?.value) {
      errors.push(`rules[${index}] 与下一条门禁值相同，未合并`);
    }
  }
  const lastRule = rules[rules.length - 1];
  if (isPlainObject(lastRule) && lastRule.max !== null) {
    errors.push('最后一条规则的 max 应为 null');
  }

  if (!Array.isArray(file.versions) || file.versions.length === 0) {
    errors.push(`${label}.versions 不是非空数组`);
    return { versionCount: 0, ruleCount: rules.length };
  }
  const versions = file.versions;
  const seenTags = new Set();
  let lastVersion = -Infinity;
  for (const [index, item] of versions.entries()) {
    const where = `versions[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    if (typeof item.tag !== 'string' || !/^v\d+(\.\d+)?$/.test(item.tag)) {
      errors.push(`${where}.tag 应为 v<数字>[.<数字>] 形态：${JSON.stringify(item.tag)}`);
    }
    if (seenTags.has(item.tag)) {
      errors.push(`${where}.tag 重复：${item.tag}`);
    }
    seenTags.add(item.tag);
    if (typeof item.version !== 'number' || !Number.isFinite(item.version)) {
      errors.push(`${where}.version 不是数字`);
    } else {
      if (item.version <= lastVersion) {
        errors.push(`${where}.version 没有严格升序`);
      }
      if (item.version < gateStartVersion()) {
        errors.push(`${where}.version 小于起始版本 ${gateStartVersion()}`);
      }
      lastVersion = item.version;
    }
    if (!Number.isInteger(item.value)) {
      errors.push(`${where}.value 应为整数`);
    }
    if (!GATE_SOURCES.has(item.source)) {
      errors.push(`${where}.source 非法：${JSON.stringify(item.source)}`);
    }
  }

  // 交叉检查：rules 必须能由 versions 合并得到
  try {
    const expected = mergeGateRules(versions);
    if (JSON.stringify(expected) !== JSON.stringify(rules)) {
      errors.push('rules 与 versions 合并结果不一致');
    }
  } catch {
    errors.push('rules 无法由 versions 合并校验');
  }

  return { versionCount: versions.length, ruleCount: rules.length };
}

export function validateHeartbeatData(file, { errors } = {}) {
  if (!isPlainObject(file)) {
    errors.push('heartbeat.json 顶层不是对象');
    return;
  }
  if (!isIsoDate(file.lastCheck)) {
    errors.push('heartbeat.lastCheck 缺失或不是 ISO 时间');
  }
}

function summaryCell(value) {
  return value === null || value === undefined ? '' : String(value);
}

// summary.json：与 index、各 per-mod 文件的一致性 + 排序/合计
function validateSummaryDataV3(summary, { index, errors }) {
  const indexByRepo = new Map(
    (Array.isArray(index?.mods) ? index.mods : [])
      .filter((mod) => typeof mod?.repo === 'string')
      .map((mod) => [mod.repo, mod]),
  );
  const seen = new Set();
  for (const [position, row] of summary.mods.entries()) {
    const where = `summary.mods[${position}]`;
    if (!isPlainObject(row)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    const repo = row.repo;
    if (typeof repo !== 'string') {
      errors.push(`${where}.repo 缺失`);
      continue;
    }
    if (seen.has(repo)) errors.push(`${where}.repo 重复`);
    seen.add(repo);
    const mod = indexByRepo.get(repo);
    if (!mod) {
      errors.push(`${where}.repo 不在全量 index 里：${repo}`);
      continue;
    }
    for (const field of ['name', 'namePlain', 'author', 'modType', 'minGameVersion', 'releaseUpdatedAt', 'commitUpdatedAt', 'iconUrl', 'releasesPath']) {
      if (JSON.stringify(row[field] ?? null) !== JSON.stringify(mod[field] ?? null)) {
        errors.push(`${where}.${field} 与 index 不一致`);
      }
    }
    for (const field of ['stars', 'releaseCount', 'totalDownloads', 'allAssetsDownloads']) {
      if (row[field] !== mod[field]) errors.push(`${where}.${field} 与 index 不一致`);
    }
    if (mod.modType === 'java') {
      if ('tagCount' in row) errors.push(`${where}.tagCount 不应写给 Java`);
    } else if (row.tagCount !== mod.tagCount) {
      errors.push(`${where}.tagCount 与 index 不一致`);
    }
    let rowRanges = null;
    try {
      rowRanges = typeof row.gameVersionRanges === 'string' ? JSON.parse(row.gameVersionRanges) : row.gameVersionRanges;
    } catch {
      errors.push(`${where}.gameVersionRanges 不是合法 JSON`);
    }
    if (JSON.stringify(rowRanges) !== JSON.stringify(mod.gameVersionRanges)) {
      errors.push(`${where}.gameVersionRanges 与 index 不一致`);
    }
    if (mod.score) {
      if ('score' in row) errors.push(`${where}.score 已移除（总分由客户端按权重计算）`);
      if (row.rank !== (mod.ranks?.heat ?? null)) {
        errors.push(`${where}.rank 与 index.ranks.heat 不一致`);
      }
      if (row.recommendVisible !== mod.score.recommendVisible) {
        errors.push(`${where}.recommendVisible 与 index.score 不一致`);
      }
    }
  }
  for (const repo of indexByRepo.keys()) {
    if (!seen.has(repo)) errors.push(`全量 index 里的 ${repo} 不在 summary 里`);
  }
  if (summary.totals) {
    for (const field of ['mods', 'releases', 'downloads']) {
      if (!Number.isInteger(summary.totals[field]) || summary.totals[field] < 0) {
        errors.push(`summary.totals.${field} 应为非负整数`);
      }
    }
    const expectedMods = indexByRepo.size;
    const expectedReleases = summary.mods.reduce(
      (sum, row) => sum + (Number(row.releaseCount) || 0),
      0,
    );
    const expectedDownloads = summary.mods.reduce(
      (sum, row) => sum + (Number(row.totalDownloads) || 0),
      0,
    );
    if (summary.totals.mods !== expectedMods) errors.push('summary.totals.mods 与行数不一致');
    if (summary.totals.releases !== expectedReleases) {
      errors.push('summary.totals.releases 与行合计不一致');
    }
    if (summary.totals.downloads !== expectedDownloads) {
      errors.push('summary.totals.downloads 与行合计不一致');
    }
  }
}

export function validateSummaryData(summary, { index, errors, warnings } = {}) {
  if (!isPlainObject(summary)) {
    errors.push('summary.json 顶层不是对象');
    return { rowCount: 0 };
  }
  if (summary.formatVersion !== 1) {
    errors.push(
      `summary.formatVersion 应为 1，实际为 ${JSON.stringify(summary.formatVersion)}`,
    );
  }
  if (!isIsoDate(summary.generatedAt)) {
    errors.push('summary.generatedAt 缺失或不是 ISO 时间');
  }
  if (!isPlainObject(summary.totals)) {
    errors.push('summary.totals 缺失');
  }
  if (!Array.isArray(summary.mods)) {
    errors.push('summary.mods 不是数组');
    return { rowCount: 0 };
  }
  if (summary.mods.some((row) => row && typeof row.modType === 'string')) {
    validateSummaryDataV3(summary, { index, errors });
    return { rowCount: summary.mods.length };
  }

  const indexMods = Array.isArray(index?.mods) ? index.mods : [];
  const indexByRepo = new Map(
    indexMods
      .filter((mod) => isPlainObject(mod) && typeof mod.repo === 'string')
      .map((mod) => [mod.repo, mod]),
  );
  let lastRow = null;
  const seenRepos = new Set();
  const required = [
    'repo',
    'name',
    'author',
    'latestTag',
    'latestModVersion',
    'latestMinGameVersion',
    'iconUrl',
    'releasesPath',
  ];
  for (const [position, row] of summary.mods.entries()) {
    const where = `summary.mods[${position}]`;
    if (!isPlainObject(row)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    for (const field of required) {
      if (row[field] !== null && typeof row[field] !== 'string') {
        errors.push(`${where}.${field} 应为字符串或 null`);
      }
    }
    if (row.latestPrerelease !== null && typeof row.latestPrerelease !== 'boolean') {
      errors.push(`${where}.latestPrerelease 应为布尔值或 null`);
    }
    if (!Number.isInteger(row.stars) || row.stars < 0) {
      errors.push(`${where}.stars 应为非负整数`);
    }
    for (const field of ['releaseCount', 'tagCount', 'totalDownloads', 'allAssetsDownloads', 'latestDownloads']) {
      if (!Number.isInteger(row[field]) || row[field] < 0) {
        errors.push(`${where}.${field} 应为非负整数`);
      }
    }
    for (const field of ['latestSizeBytes', 'totalSizeBytes']) {
      if (row[field] !== null && (!Number.isInteger(row[field]) || row[field] < 0)) {
        errors.push(`${where}.${field} 应为非负整数或 null`);
      }
    }
    if (typeof row.repo === 'string') {
      if (seenRepos.has(row.repo)) {
        errors.push(`${where}.repo 重复：${row.repo}`);
      }
      seenRepos.add(row.repo);
    }
    // 排序：totalDownloads 降序、stars 降序、repo 升序
    if (lastRow) {
      const okOrder =
        lastRow.totalDownloads > row.totalDownloads ||
        (lastRow.totalDownloads === row.totalDownloads &&
          (lastRow.stars > row.stars ||
            (lastRow.stars === row.stars && lastRow.repo < row.repo)));
      if (!okOrder) {
        errors.push(`${where} 排序错误（应为 totalDownloads 降序、stars 降序、repo 升序）`);
      }
    }
    lastRow = row;
    const indexEntry = indexByRepo.get(row.repo);
    if (!indexEntry) {
      errors.push(`${where}.repo 不在 index.mods 里：${row.repo}`);
      continue;
    }
    for (const field of ['releaseCount', 'tagCount', 'totalDownloads', 'allAssetsDownloads', 'latestDownloads', 'latestSizeBytes', 'totalSizeBytes']) {
      if (row[field] !== indexEntry[field]) {
        errors.push(`${where}.${field} 与 index 不一致`);
      }
    }
    if (row.latestTag !== (indexEntry.latestRelease?.tag ?? null)) {
      errors.push(`${where}.latestTag 与 index 不一致`);
    }
    if (row.iconUrl !== indexEntry.iconUrl) {
      errors.push(`${where}.iconUrl 与 index 不一致`);
    }
    if (row.releasesPath !== (indexEntry.releasesPath ?? null)) {
      errors.push(`${where}.releasesPath 与 index 不一致`);
    }
    if (!isFiniteNumberOrNull(row.score)) {
      errors.push(`${where}.score 应为有限数字`);
    } else if (indexEntry.score && row.score !== indexEntry.score.score) {
      errors.push(`${where}.score 与 index.score.score 不一致`);
    }
    if (!Number.isInteger(row.rank) || row.rank < 1) {
      errors.push(`${where}.rank 应为正整数`);
    } else if (indexEntry.score && row.rank !== indexEntry.score.rank) {
      errors.push(`${where}.rank 与 index.score.rank 不一致`);
    }
    if (typeof row.recommendVisible !== 'boolean') {
      errors.push(`${where}.recommendVisible 应为布尔值`);
    } else if (indexEntry.score && row.recommendVisible !== indexEntry.score.recommendVisible) {
      errors.push(`${where}.recommendVisible 与 index.score 不一致`);
    }
  }
  for (const mod of indexMods) {
    if (isPlainObject(mod) && typeof mod.repo === 'string' && !seenRepos.has(mod.repo)) {
      errors.push(`index 里的 ${mod.repo} 不在 summary.mods 里`);
    }
  }

  if (isPlainObject(summary.totals)) {
    const totals = summary.totals;
    for (const field of ['mods', 'releases', 'downloads', 'sizeBytes']) {
      if (!Number.isInteger(totals[field]) || totals[field] < 0) {
        errors.push(`summary.totals.${field} 应为非负整数`);
      }
    }
    const expectedReleases = indexMods.reduce(
      (sum, mod) => sum + (Number.isInteger(mod.releaseCount) ? mod.releaseCount : 0),
      0,
    );
    const expectedDownloads = indexMods.reduce(
      (sum, mod) => sum + (Number.isInteger(mod.totalDownloads) ? mod.totalDownloads : 0),
      0,
    );
    const expectedSize = indexMods.reduce(
      (sum, mod) => sum + (Number.isInteger(mod.totalSizeBytes) ? mod.totalSizeBytes : 0),
      0,
    );
    if (totals.mods !== indexMods.length) {
      errors.push('summary.totals.mods 与 index 模组数不一致');
    }
    if (totals.releases !== expectedReleases) {
      errors.push('summary.totals.releases 与 index 合计不一致');
    }
    if (totals.downloads !== expectedDownloads) {
      errors.push('summary.totals.downloads 与 index 合计不一致');
    }
    if (totals.sizeBytes !== expectedSize) {
      errors.push('summary.totals.sizeBytes 与 index 合计不一致');
    }
  }
  void warnings;
  return { rowCount: summary.mods.length };
}

export function validateSummaryCsv(text, summary, { errors } = {}) {
  if (typeof text !== 'string') {
    errors.push('summary.csv 缺失');
    return;
  }
  if (!text.startsWith('\uFEFF')) {
    errors.push('summary.csv 缺少 UTF-8 BOM');
  }
  const rows = parseCsv(text);
  if (rows.length === 0) {
    errors.push('summary.csv 为空');
    return;
  }
  if (JSON.stringify(rows[0]) !== JSON.stringify(SUMMARY_COLUMNS)) {
    errors.push('summary.csv 表头与约定不一致');
  }
  const dataRows = rows.slice(1);
  const mods = Array.isArray(summary?.mods) ? summary.mods : [];
  if (dataRows.length !== mods.length) {
    errors.push(
      `summary.csv 行数（${dataRows.length}）与 summary.json mods 数（${mods.length}）不一致`,
    );
    return;
  }
  const expected = mods.map((row) =>
    SUMMARY_COLUMNS.map((column) => summaryCell(row[column])),
  );
  for (const [index, row] of dataRows.entries()) {
    if (JSON.stringify(row) !== JSON.stringify(expected[index])) {
      errors.push(`summary.csv 第 ${index + 2} 行与 summary.json 不一致`);
      break;
    }
  }
}

export function validateRefreshStateData(state, { errors } = {}) {
  if (!isPlainObject(state)) {
    errors.push('state/refresh.json 顶层不是对象');
    return { modCount: 0 };
  }
  if (state.formatVersion !== 1) {
    errors.push(
      `state.formatVersion 应为 1，实际为 ${JSON.stringify(state.formatVersion)}`,
    );
  }
  if (!isIsoDate(state.updatedAt)) {
    errors.push('state.updatedAt 缺失或不是 ISO 时间');
  }
  if (!isPlainObject(state.mods)) {
    errors.push('state.mods 不是对象');
    return { modCount: 0 };
  }
  for (const [repo, entry] of Object.entries(state.mods)) {
    if (!repo.includes('/') || !isPlainObject(entry)) {
      errors.push(`state.mods.${repo} 形状非法`);
      continue;
    }
    if (entry.page1Etag !== null && typeof entry.page1Etag !== 'string') {
      errors.push(`state.mods.${repo}.page1Etag 应为字符串或 null`);
    }
    for (const field of ['page1FetchedAt', 'page2FetchedAt', 'fullFetchedAt', 'tagsFetchedAt']) {
      const value = entry[field];
      if (value !== undefined && value !== null && !isIsoDate(value)) {
        errors.push(`state.mods.${repo}.${field} 应为 ISO 时间或 null`);
      }
    }
    // 旧格式可能还有 pages 映射；新格式只存 page1/page2/full/tags 时间
    if (entry.pages !== undefined) {
      if (!isPlainObject(entry.pages)) {
        errors.push(`state.mods.${repo}.pages 不是对象`);
        continue;
      }
      for (const [page, fetchedAt] of Object.entries(entry.pages)) {
        if (!/^\d+$/.test(page) || Number(page) < 2 || !isIsoDate(fetchedAt)) {
          errors.push(`state.mods.${repo}.pages.${page} 形状非法`);
        }
      }
    }
  }
  return { modCount: Object.keys(state.mods).length };
}

// B4：status.json（运行日志性质，允许没有；存在时结构要稳定）
export function validateStatusData(status, { errors } = {}) {
  if (!isPlainObject(status)) {
    errors.push(`${STATUS_REL_PATH} 顶层不是对象`);
    return;
  }
  if (status.formatVersion !== 1) {
    errors.push(`${STATUS_REL_PATH}.formatVersion 应为 1`);
  }
  if (!isIsoDate(status.generatedAt)) {
    errors.push(`${STATUS_REL_PATH}.generatedAt 缺失或不是 ISO 时间`);
  }
  if (!isPlainObject(status.datasets)) {
    errors.push(`${STATUS_REL_PATH}.datasets 不是对象`);
  } else {
    for (const key of DATASET_KEYS) {
      const entry = status.datasets[key];
      if (entry === null || entry === undefined) {
        continue;
      }
      if (!isPlainObject(entry)) {
        errors.push(`${STATUS_REL_PATH}.datasets.${key} 不是对象`);
        continue;
      }
      if (entry.updatedAt !== null && !isIsoDate(entry.updatedAt)) {
        errors.push(`${STATUS_REL_PATH}.datasets.${key}.updatedAt 应为 ISO 时间或 null`);
      }
      for (const field of ['modCount', 'releaseCount']) {
        if (entry[field] !== null && (!Number.isInteger(entry[field]) || entry[field] < 0)) {
          errors.push(`${STATUS_REL_PATH}.datasets.${key}.${field} 应为非负整数或 null`);
        }
      }
      if (!Array.isArray(entry.skipped)) {
        errors.push(`${STATUS_REL_PATH}.datasets.${key}.skipped 不是数组`);
      }
    }
  }
  if (!isPlainObject(status.api)) {
    errors.push(`${STATUS_REL_PATH}.api 不是对象`);
  } else {
    if (!Number.isInteger(status.api.requests) || status.api.requests < 0) {
      errors.push(`${STATUS_REL_PATH}.api.requests 应为非负整数`);
    }
    if (
      status.api.remaining !== null &&
      (!Number.isInteger(status.api.remaining) || status.api.remaining < 0)
    ) {
      errors.push(`${STATUS_REL_PATH}.api.remaining 应为非负整数或 null`);
    }
    if (status.api.resetAt !== null && !isIsoDate(status.api.resetAt)) {
      errors.push(`${STATUS_REL_PATH}.api.resetAt 应为 ISO 时间或 null`);
    }
  }
  if (!isPlainObject(status.validate)) {
    errors.push(`${STATUS_REL_PATH}.validate 不是对象`);
  } else {
    for (const field of ['errors', 'warnings']) {
      if (!Number.isInteger(status.validate[field]) || status.validate[field] < 0) {
        errors.push(`${STATUS_REL_PATH}.validate.${field} 应为非负整数`);
      }
    }
    if (!Array.isArray(status.validate.presentFiles)) {
      errors.push(`${STATUS_REL_PATH}.validate.presentFiles 不是数组`);
    }
  }
}

// B5：changes.json（滚动变更流，最多 500 条）
export function validateChangesData(changes, { errors, warnings } = {}) {
  if (!Array.isArray(changes)) {
    errors.push(`${CHANGES_REL_PATH} 顶层不是数组`);
    return { count: 0 };
  }
  if (changes.length > MAX_CHANGES) {
    errors.push(`${CHANGES_REL_PATH} 超过 ${MAX_CHANGES} 条（实际 ${changes.length}）`);
  }
  for (const [index, entry] of changes.entries()) {
    const where = `${CHANGES_REL_PATH}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    if (!isIsoDate(entry.at)) {
      errors.push(`${where}.at 缺失或不是 ISO 时间`);
    }
    if (entry.dataset !== 'official' && entry.dataset !== 'community') {
      errors.push(`${where}.dataset 非法：${JSON.stringify(entry.dataset)}`);
    }
    if (typeof entry.repo !== 'string' || !/^[^/]+\/[^/]+$/.test(entry.repo)) {
      errors.push(`${where}.repo 非法`);
    }
    if (!CHANGE_ACTIONS.includes(entry.action)) {
      errors.push(`${where}.action 非法：${JSON.stringify(entry.action)}`);
    }
    for (const field of ['tag', 'version', 'namePlain']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        errors.push(`${where}.${field} 应为字符串`);
      }
    }
  }
  return { count: changes.length };
}

// ---------- heat（热度表） ----------

const HEAT_SOURCE_VALUES = ['official', 'community'];

function isFiniteNumberOrNull(value, { allowNull = false } = {}) {
  if (value === null && allowNull) {
    return true;
  }
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateHeatIndexData(
  heat,
  { expectedRepos = null, hasJavaByRepo = null, errors } = {},
) {
  if (!isPlainObject(heat)) {
    errors.push(`${HEAT_INDEX_REL_PATH} 顶层不是对象`);
    return { modCount: 0 };
  }
  if (heat.formatVersion !== 1) {
    errors.push(`${HEAT_INDEX_REL_PATH}.formatVersion 应为 1`);
  }
  if (!isIsoDate(heat.generatedAt)) {
    errors.push(`${HEAT_INDEX_REL_PATH}.generatedAt 缺失或不是 ISO 时间`);
  }
  if (!isPlainObject(heat.source)) {
    errors.push(`${HEAT_INDEX_REL_PATH}.source 缺失`);
  } else {
    for (const field of ['official', 'community']) {
      if (!Number.isInteger(heat.source[field]) || heat.source[field] < 0) {
        errors.push(`${HEAT_INDEX_REL_PATH}.source.${field} 应为非负整数`);
      }
    }
  }
  if (!Array.isArray(heat.mods)) {
    errors.push(`${HEAT_INDEX_REL_PATH}.mods 不是数组`);
    return { modCount: 0 };
  }
  const repos = new Set();
  let downloadShareSum = 0;
  let starShareSum = 0;
  for (const [index, entry] of heat.mods.entries()) {
    const where = `${HEAT_INDEX_REL_PATH}.mods[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} 不是对象`);
      continue;
    }
    if (typeof entry.repo !== 'string' || !/^[^/]+\/[^/]+$/.test(entry.repo)) {
      errors.push(`${where}.repo 非法`);
    } else if (repos.has(entry.repo.toLowerCase())) {
      errors.push(`${where}.repo 重复：${entry.repo}`);
    } else {
      repos.add(entry.repo.toLowerCase());
    }
    if (typeof entry.namePlain !== 'string') {
      errors.push(`${where}.namePlain 应为字符串`);
    }
    if (!HEAT_SOURCE_VALUES.includes(entry.source)) {
      errors.push(`${where}.source 非法`);
    }
    for (const field of ['totalDownloads', 'totalStars']) {
      if (!isFiniteNumberOrNull(entry[field]) || entry[field] < 0) {
        errors.push(`${where}.${field} 应为非负数字`);
      }
    }
    for (const field of ['stockShare', 'stockMag', 'stockScore']) {
      const stock = entry[field];
      if (!isPlainObject(stock)) {
        errors.push(`${where}.${field} 不是对象`);
        continue;
      }
      for (const metric of ['downloads', 'stars']) {
        if (!isFiniteNumberOrNull(stock[metric])) {
          errors.push(`${where}.${field}.${metric} 应为有限数字`);
        }
      }
    }
    if (isPlainObject(entry.stockShare)) {
      for (const metric of ['downloads', 'stars']) {
        const share = entry.stockShare[metric];
        if (isFiniteNumberOrNull(share)) {
          if (share < 0 || share > 1 + 1e-9) {
            errors.push(`${where}.stockShare.${metric} 应在 [0, 1]`);
          }
          if (metric === 'downloads') {
            downloadShareSum += share;
          } else {
            starShareSum += share;
          }
        }
      }
    }
    for (const field of ['stockMag', 'stockScore']) {
      if (!isPlainObject(entry[field])) {
        continue;
      }
      for (const metric of ['downloads', 'stars']) {
        const value = entry[field][metric];
        if (isFiniteNumberOrNull(value) && (value < 0 || value > 1 + 1e-9)) {
          errors.push(`${where}.${field}.${metric} 应在 [0, 1]`);
        }
      }
    }
    // 下载缺失标记与重归一权重
    if (typeof entry.downloadsMissing !== 'boolean') {
      errors.push(`${where}.downloadsMissing 应为布尔值`);
    }
    if (!isPlainObject(entry.effectiveWeights)) {
      errors.push(`${where}.effectiveWeights 不是对象`);
    } else {
      const weights = entry.effectiveWeights;
      for (const field of ['downloads', 'stars', 'update']) {
        if (!isFiniteNumberOrNull(weights[field])) {
          errors.push(`${where}.effectiveWeights.${field} 应为有限数字`);
        }
      }
      if (
        isFiniteNumberOrNull(weights.downloads) &&
        isFiniteNumberOrNull(weights.stars) &&
        isFiniteNumberOrNull(weights.update)
      ) {
        const sum = weights.downloads + weights.stars + weights.update;
        if (Math.abs(sum - 1) > 1e-3) {
          errors.push(`${where}.effectiveWeights 之和应≈1（实际 ${sum.toFixed(6)}）`);
        }
        if (entry.downloadsMissing === true) {
          if (weights.downloads !== 0) {
            errors.push(`${where}.effectiveWeights.downloads 在下载缺失时应为 0`);
          }
          if (Math.abs(weights.stars - 0.5 / 0.6) > 1e-3) {
            errors.push(`${where}.effectiveWeights.stars 应为 0.8333（0.5/0.6）`);
          }
          if (Math.abs(weights.update - 0.1 / 0.6) > 1e-3) {
            errors.push(`${where}.effectiveWeights.update 应为 0.1667（0.1/0.6）`);
          }
        } else if (
          Math.abs(weights.downloads - 0.4) > 1e-3 ||
          Math.abs(weights.stars - 0.5) > 1e-3 ||
          Math.abs(weights.update - 0.1) > 1e-3
        ) {
          errors.push(`${where}.effectiveWeights 与正常权重 0.4/0.5/0.1 不一致`);
        }
      }
    }
    if (hasJavaByRepo && typeof entry.repo === 'string') {
      const hasJava = hasJavaByRepo.get(entry.repo.toLowerCase());
      const expectedMissing =
        hasJava === false && (Number(entry.totalDownloads) || 0) === 0;
      if (entry.downloadsMissing !== expectedMissing) {
        errors.push(
          `${where}.downloadsMissing 与 index 元数据不一致（hasJava=${hasJava}，totalDownloads=${entry.totalDownloads}）`,
        );
      }
    }
    for (const field of ['downloadChanges', 'starChanges']) {
      const windows = entry[field];
      if (!isPlainObject(windows)) {
        errors.push(`${where}.${field} 不是对象`);
        continue;
      }
      for (const window of HEAT_WINDOWS) {
        if (!isFiniteNumberOrNull(windows[window])) {
          errors.push(`${where}.${field}.${window} 应为数字`);
        }
      }
    }
    for (const field of ['releaseUpdates', 'commits']) {
      const windows = entry[field];
      if (!isPlainObject(windows)) {
        errors.push(`${where}.${field} 不是对象`);
        continue;
      }
      for (const window of UPDATE_WINDOWS) {
        if (!isFiniteNumberOrNull(windows[window])) {
          errors.push(`${where}.${field}.${window} 应为数字`);
        }
      }
    }
    for (const field of ['releaseActivityRaw', 'commitActivityRaw']) {
      if (!isFiniteNumberOrNull(entry[field]) || entry[field] < 0) {
        errors.push(`${where}.${field} 应为非负有限数字`);
      }
    }
    for (const field of ['releaseActivity', 'commitActivity']) {
      if (!isFiniteNumberOrNull(entry[field]) || entry[field] < 0 || entry[field] > 1 + 1e-9) {
        errors.push(`${where}.${field} 应在 [0, 1]`);
      }
    }
    for (const field of ['downloadsScore', 'starsScore', 'updateScore', 'newModMultiplier', 'penalty', 'score']) {
      if (!isFiniteNumberOrNull(entry[field])) {
        errors.push(`${where}.${field} 应为有限数字（NaN/Infinity 不允许）`);
      }
    }
    if (isFiniteNumberOrNull(entry.newModMultiplier)) {
      if (entry.newModMultiplier < 1 - 1e-9 || entry.newModMultiplier > 1.325 + 1e-9) {
        errors.push(`${where}.newModMultiplier 应在 [1, 1.325]`);
      }
    }
    if (isFiniteNumberOrNull(entry.penalty)) {
      if (entry.penalty < 0 || entry.penalty > 1) {
        errors.push(`${where}.penalty 应在 [0, 1]`);
      }
    }
    if (!Number.isInteger(entry.rank) || entry.rank < 1) {
      errors.push(`${where}.rank 应为正整数`);
    }
  }
  // 占比总和：所有模组的 share 之和应≈1（全量全 0 时为 0）
  if (heat.mods.length > 0) {
    const hasDownloads = heat.mods.some(
      (entry) => isFiniteNumberOrNull(entry?.totalDownloads) && entry.totalDownloads > 0,
    );
    const hasStars = heat.mods.some(
      (entry) => isFiniteNumberOrNull(entry?.totalStars) && entry.totalStars > 0,
    );
    if (hasDownloads && Math.abs(downloadShareSum - 1) > 1e-3) {
      errors.push(`${HEAT_INDEX_REL_PATH} 的 downloads stockShare 之和应≈1（实际 ${downloadShareSum.toFixed(6)}）`);
    }
    if (hasStars && Math.abs(starShareSum - 1) > 1e-3) {
      errors.push(`${HEAT_INDEX_REL_PATH} 的 stars stockShare 之和应≈1（实际 ${starShareSum.toFixed(6)}）`);
    }
  }
  // 排名：1..N 唯一，按分数降序
  const ranks = heat.mods.map((entry) => entry?.rank).filter((value) => Number.isInteger(value));
  const uniqueRanks = new Set(ranks);
  if (ranks.length !== heat.mods.length || uniqueRanks.size !== heat.mods.length) {
    errors.push(`${HEAT_INDEX_REL_PATH} 的 rank 不是 1..N 唯一`);
  } else {
    for (let index = 0; index < heat.mods.length; index += 1) {
      if (heat.mods[index].rank !== index + 1) {
        errors.push(`${HEAT_INDEX_REL_PATH}.mods[${index}].rank 应为 ${index + 1}`);
      }
      if (index > 0) {
        const previous = heat.mods[index - 1].score;
        const current = heat.mods[index].score;
        if (isFiniteNumberOrNull(previous) && isFiniteNumberOrNull(current) && previous < current) {
          errors.push(`${HEAT_INDEX_REL_PATH}.mods[${index}] 没有按 score 降序`);
        }
      }
    }
  }
  if (expectedRepos) {
    const expected = new Set([...expectedRepos].map((repo) => repo.toLowerCase()));
    const missing = [...expected].filter((repo) => !repos.has(repo));
    const extra = [...repos].filter((repo) => !expected.has(repo));
    if (missing.length > 0) {
      errors.push(`${HEAT_INDEX_REL_PATH} 缺少 ${missing.length} 个 index 里的 repo（如 ${missing.slice(0, 3).join('、')}）`);
    }
    if (extra.length > 0) {
      errors.push(`${HEAT_INDEX_REL_PATH} 多出 ${extra.length} 个不在 index 里的 repo（如 ${extra.slice(0, 3).join('、')}）`);
    }
  }
  return { modCount: heat.mods.length };
}

export function validateHeatHistorySnapshot(snapshot, { where, errors }) {
  if (!isPlainObject(snapshot)) {
    errors.push(`${where} 顶层不是对象`);
    return;
  }
  if (snapshot.formatVersion !== 1) {
    errors.push(`${where}.formatVersion 应为 1`);
  }
  if (!isIsoDate(snapshot.generatedAt)) {
    errors.push(`${where}.generatedAt 缺失或不是 ISO 时间`);
  }
  if (!isPlainObject(snapshot.mods)) {
    errors.push(`${where}.mods 不是对象`);
    return;
  }
  for (const [repo, value] of Object.entries(snapshot.mods)) {
    if (!/^[^/]+\/[^/]+$/.test(repo) || !isPlainObject(value)) {
      errors.push(`${where}.mods.${repo} 形状非法`);
      continue;
    }
    for (const field of ['stars', 'totalDownloads']) {
      if (!isFiniteNumberOrNull(value[field]) || value[field] < 0) {
        errors.push(`${where}.mods.${repo}.${field} 应为非负数字`);
      }
    }
  }
}

export function validateHeatCommitState(state, { errors } = {}) {
  if (!isPlainObject(state)) {
    errors.push(`${HEAT_COMMIT_STATE_REL_PATH} 顶层不是对象`);
    return;
  }
  if (state.formatVersion !== 1) {
    errors.push(`${HEAT_COMMIT_STATE_REL_PATH}.formatVersion 应为 1`);
  }
  if (state.fetchedAt !== null && !isIsoDate(state.fetchedAt)) {
    errors.push(`${HEAT_COMMIT_STATE_REL_PATH}.fetchedAt 应为 ISO 时间或 null`);
  }
  if (typeof state.complete !== 'boolean') {
    errors.push(`${HEAT_COMMIT_STATE_REL_PATH}.complete 应为布尔值`);
  }
  if (!isPlainObject(state.stats)) {
    errors.push(`${HEAT_COMMIT_STATE_REL_PATH}.stats 不是对象`);
    return;
  }
  for (const [repo, weeks] of Object.entries(state.stats)) {
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      errors.push(`${HEAT_COMMIT_STATE_REL_PATH}.stats.${repo} repo 非法`);
      continue;
    }
    if (!Array.isArray(weeks) || weeks.length !== 52) {
      errors.push(`${HEAT_COMMIT_STATE_REL_PATH}.stats.${repo} 应为 52 周数组`);
      continue;
    }
    if (!weeks.every((value) => isFiniteNumberOrNull(value))) {
      errors.push(`${HEAT_COMMIT_STATE_REL_PATH}.stats.${repo} 含非数字`);
    }
  }
}

export function validateHeatCreatedState(state, { errors } = {}) {
  if (!isPlainObject(state)) {
    errors.push(`${HEAT_CREATED_STATE_REL_PATH} 顶层不是对象`);
    return;
  }
  if (state.formatVersion !== 1) {
    errors.push(`${HEAT_CREATED_STATE_REL_PATH}.formatVersion 应为 1`);
  }
  if (state.updatedAt !== null && !isIsoDate(state.updatedAt)) {
    errors.push(`${HEAT_CREATED_STATE_REL_PATH}.updatedAt 应为 ISO 时间或 null`);
  }
  if (!isPlainObject(state.repos)) {
    errors.push(`${HEAT_CREATED_STATE_REL_PATH}.repos 不是对象`);
    return;
  }
  for (const [repo, value] of Object.entries(state.repos)) {
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      errors.push(`${HEAT_CREATED_STATE_REL_PATH}.repos.${repo} repo 非法`);
      continue;
    }
    if (value !== null && !isIsoDate(value)) {
      errors.push(`${HEAT_CREATED_STATE_REL_PATH}.repos.${repo} 应为 ISO 时间或 null`);
    }
  }
}

async function readJsonIfPresent(file) {  try {
    return { exists: true, data: JSON.parse(await readFile(file, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, data: null };
    }
    return { exists: true, data: null, error };
  }
}

async function readTextIfPresent(file) {
  try {
    return { exists: true, text: await readFile(file, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, text: null };
    }
    return { exists: true, text: null, error };
  }
}

export async function validateDir(dir) {
  const outDir = path.resolve(dir);
  const errors = [];
  const warnings = [];
  const releaseFiles = new Set(await listReleaseFiles(outDir));
  const result = {
    errors,
    warnings,
    modCount: 0,
    releaseFileCount: releaseFiles.size,
    versionsCount: 0,
    latestBe: null,
    gates: { mod: null, java: null },
    summaryRowCount: 0,
    refreshStateModCount: 0,
    communityModCount: 0,
    communityReleaseFileCount: 0,
    communitySummaryRowCount: 0,
    communityStateModCount: 0,
    changesCount: 0,
    scoreModCount: 0,
    scoreHistoryCounts: { daily: 0, weekly: 0, monthly: 0 },
    present: [],
  };

  const indexFile = await readJsonIfPresent(path.join(outDir, INDEX_FILE));
  const indexFullFile = await readJsonIfPresent(path.join(outDir, FULL_INDEX_REL_PATH));
  const versionsFile = await readJsonIfPresent(path.join(outDir, VERSIONS_REL_PATH));
  const modGateFile = await readJsonIfPresent(path.join(outDir, GATE_REL_PATHS.mod));
  const javaGateFile = await readJsonIfPresent(path.join(outDir, GATE_REL_PATHS.java));
  const heartbeatFile = await readJsonIfPresent(
    path.join(outDir, HEARTBEAT_REL_PATH),
  );
  const summaryFile = await readJsonIfPresent(path.join(outDir, 'summary.json'));
  const summaryCsvFile = await readTextIfPresent(path.join(outDir, 'summary.csv'));
  const refreshStateFile = await readJsonIfPresent(
    path.join(outDir, REFRESH_STATE_REL_PATH),
  );
  const communityIndexFile = await readJsonIfPresent(
    path.join(outDir, COMMUNITY_DIR, 'index.json'),
  );
  const communityFullIndexFile = await readJsonIfPresent(
    path.join(outDir, COMMUNITY_FULL_INDEX_REL_PATH),
  );
  const communitySummaryFile = await readJsonIfPresent(
    path.join(outDir, COMMUNITY_DIR, 'summary.json'),
  );
  const communitySummaryCsvFile = await readTextIfPresent(
    path.join(outDir, COMMUNITY_DIR, 'summary.csv'),
  );
  const communityStateFile = await readJsonIfPresent(
    path.join(outDir, COMMUNITY_STATE_REL_PATH),
  );
  const statusFile = await readJsonIfPresent(path.join(outDir, STATUS_REL_PATH));
  const changesFile = await readJsonIfPresent(path.join(outDir, CHANGES_REL_PATH));
  const heatIndexFile = await readJsonIfPresent(path.join(outDir, HEAT_INDEX_REL_PATH));
  const heatSummaryCsvFile = await readTextIfPresent(
    path.join(outDir, HEAT_SUMMARY_REL_PATH),
  );
  const heatCommitStateFile = await readJsonIfPresent(
    path.join(outDir, HEAT_COMMIT_STATE_REL_PATH),
  );
  const heatCreatedStateFile = await readJsonIfPresent(
    path.join(outDir, HEAT_CREATED_STATE_REL_PATH),
  );
  const heatHistoryFiles = {};
  for (const kind of ['daily', 'weekly', 'monthly']) {
    try {
      heatHistoryFiles[kind] = (await readdir(path.join(outDir, HEAT_HISTORY_DIR, kind))).filter(
        (name) => name.endsWith('.json'),
      );
    } catch {
      heatHistoryFiles[kind] = [];
    }
  }
  const gameVersions = gameVersionsFromFile(versionsFile.data);

  if (
    !indexFile.exists &&
    !versionsFile.exists &&
    !modGateFile.exists &&
    !javaGateFile.exists &&
    !communityIndexFile.exists
  ) {
    errors.push(
      `找不到任何数据文件（${INDEX_FILE} / ${COMMUNITY_DIR}/index.json / ${VERSIONS_REL_PATH} / ${GATE_REL_PATHS.mod} / ${GATE_REL_PATHS.java}）`,
    );
    return result;
  }

  if (indexFile.exists) {
    result.present.push(INDEX_FILE);
    if (indexFile.error) {
      errors.push(`${INDEX_FILE} 无法解析：${indexFile.error.message}`);
    } else {
      if (!indexFullFile.exists) {
        errors.push(`缺少 ${FULL_INDEX_REL_PATH}（全量列表）`);
      } else if (indexFullFile.error) {
        errors.push(`${FULL_INDEX_REL_PATH} 无法解析：${indexFullFile.error.message}`);
      } else {
        result.present.push(FULL_INDEX_REL_PATH);
        validateIndexData(indexFullFile.data, { errors, warnings, releaseFiles });
        validateDefaultListConsistency(indexFile.data, indexFullFile.data, {
          label: INDEX_FILE,
          errors,
        });
      }
      validateIndexData(indexFile.data, { errors, warnings });
      const officialFullData =
        indexFullFile.exists && !indexFullFile.error ? indexFullFile.data : indexFile.data;
      const loaded = new Map();
      for (const relPath of releaseFiles) {
        try {
          loaded.set(relPath, JSON.parse(await readFile(path.join(outDir, relPath), 'utf8')));
        } catch (error) {
          errors.push(`${relPath} 无法解析：${error.message}`);
        }
      }
      const usedFiles = new Set();
      const mods = Array.isArray(officialFullData?.mods) ? officialFullData.mods : [];
      for (const mod of mods) {
        if (!isPlainObject(mod) || typeof mod.repo !== 'string') {
          continue;
        }
        if (!isValidReleasesPath(mod.releasesPath)) {
          continue;
        }
        const pageMetas = Array.isArray(mod.pages) && mod.pages.length > 0 ? mod.pages : null;
        const pagePaths = pageMetas ? pageMetas.map((page) => page?.path) : [mod.releasesPath];
        const pageFiles = [];
        for (const pagePath of pagePaths) {
          if (!isValidReleasesPath(pagePath)) {
            errors.push(`${mod.repo} 的 pages.path 非法：${JSON.stringify(pagePath)}`);
            continue;
          }
          const pageFile = loaded.get(pagePath);
          if (!pageFile) {
            errors.push(`${pagePath} 文件不存在（index 引用了不存在的 per-mod 文件）`);
            continue;
          }
          usedFiles.add(pagePath);
          const fileErrors = [];
          validateReleaseFileData(pageFile, { expectedRepo: mod.repo, errors: fileErrors });
          for (const message of fileErrors) {
            errors.push(`${pagePath}：${message}`);
          }
          pageFiles.push(pageFile);
        }
        if (pageFiles.length === 0) {
          continue;
        }
        const file = pageFiles[0];
        // 校验 pages 元数据与页文件一致
        if (pageMetas) {
          if (pageMetas.length > 5) {
            errors.push(`${mod.repo} 的 pages 超过 5 页`);
          }
          let total = 0;
          for (const [pageIndex, page] of pageMetas.entries()) {
            if (page?.page !== pageIndex + 1) {
              errors.push(`${mod.repo} 的 pages 页码不连续`);
            }
            const pageFile = pageFiles[pageIndex];
            const pageVersions = Array.isArray(pageFile?.versions) ? pageFile.versions : [];
            if (page?.count !== pageVersions.length) {
              errors.push(`${mod.repo} 的 page-${pageIndex + 1} count 与 versions 数量不一致`);
            }
            if (
              pageFile?.gameVersionRanges !== undefined &&
              JSON.stringify(page?.gameVersionRanges ?? []) !==
                JSON.stringify(pageFile?.gameVersionRanges ?? [])
            ) {
              errors.push(`${mod.repo} 的 page-${pageIndex + 1} gameVersionRanges 与页文件不一致`);
            }
            total += pageVersions.length;
          }
          if (total > 1000) {
            errors.push(`${mod.repo} 的版本总数超过 1000`);
          }
        }
        if (file.formatVersion === 3) {
          const versions = pageFiles.flatMap((pageFile) =>
            Array.isArray(pageFile?.versions) ? pageFile.versions : [],
          );
          const releaseCount = versions.filter((item) => item.kind === 'release').length;
          if (releaseCount !== mod.releaseCount) {
            errors.push(`${mod.repo} 的 releaseCount（${mod.releaseCount}）与文件 release 版本数（${releaseCount}）不一致`);
          }
          if (mod.modType !== 'java' && versions.length !== mod.tagCount) {
            errors.push(`${mod.repo} 的 tagCount（${mod.tagCount}）与 versions 数量（${versions.length}）不一致`);
          }
          continue;
        }
        if (!Array.isArray(file.releases)) {
          continue;
        }
        const releaseEntries = file.releases.filter(
          (entry) => entry?.hasRelease !== false,
        );
        if (mod.releaseCount !== releaseEntries.length) {
          errors.push(
            `mods ${mod.repo} 的 releaseCount（${mod.releaseCount}）与 hasRelease=true 条数（${releaseEntries.length}）不一致`,
          );
        }
        if (mod.tagCount !== file.releases.length) {
          errors.push(
            `mods ${mod.repo} 的 tagCount（${mod.tagCount}）与文件条数（${file.releases.length}）不一致`,
          );
        }
        const removedEntries = file.releases.filter((entry) => entry?.removed === true).length;
        if (mod.removedCount !== removedEntries) {
          errors.push(
            `mods ${mod.repo} 的 removedCount（${mod.removedCount}）与文件条数（${removedEntries}）不一致`,
          );
        }
        const compat = Array.isArray(file.compat) ? file.compat : [];
        if (mod.compatRanges !== compat.length) {
          errors.push(
            `mods ${mod.repo} 的 compatRanges（${mod.compatRanges}）与 compat 条数（${compat.length}）不一致`,
          );
        }
        const expectedLatestCompatible = latestCompatibleTag(compat, gameVersions);
        if (mod.latestCompatible !== expectedLatestCompatible) {
          errors.push(
            `mods ${mod.repo} 的 latestCompatible（${mod.latestCompatible}）与 compat 重算（${expectedLatestCompatible}）不一致`,
          );
        }
        const firstTag =
          (releaseEntries.find((entry) => entry?.removed !== true) ?? releaseEntries[0])
            ?.tag ?? null;
        if ((mod.latestRelease?.tag ?? null) !== firstTag) {
          errors.push(
            `mods ${mod.repo} 的 latestRelease.tag（${mod.latestRelease?.tag ?? null}）与文件首个未删除 Release 条目（${firstTag}）不一致`,
          );
        }
        if (mod.releaseDataUpdatedAt !== file.generatedAt) {
          errors.push(`mods ${mod.repo} 的 releaseDataUpdatedAt 与文件 generatedAt 不一致`);
        }
        // 统计字段可由 per-mod 的 releases 重算核对
        const stats = computeModStats(file.releases, mod.hasJava === true);
        for (const field of ['totalDownloads', 'allAssetsDownloads', 'latestDownloads', 'latestSizeBytes', 'totalSizeBytes']) {
          if (mod[field] !== stats[field]) {
            errors.push(`mods ${mod.repo} 的 ${field} 与 per-mod 数据重算不一致`);
          }
        }
        if (mod.latestRelease && typeof mod.latestRelease === 'object') {
          if (mod.latestRelease.downloads !== stats.latestDownloads) {
            errors.push(`mods ${mod.repo} 的 latestRelease.downloads 与重算不一致`);
          }
          if (mod.latestRelease.sizeBytes !== stats.latestSizeBytes) {
            errors.push(`mods ${mod.repo} 的 latestRelease.sizeBytes 与重算不一致`);
          }
        }
      }
      for (const relPath of releaseFiles) {
        if (isLegacyReleasesPath(relPath)) {
          warnings.push(`${relPath} 是旧 flat 路径（迁移未完成）`);
        } else if (!usedFiles.has(relPath)) {
          warnings.push(`${relPath} 没有被 index 引用`);
        }
      }
      result.modCount = mods.length;

      // 总表：与 index 一致 + CSV 行数/内容一致
      if (!summaryFile.exists) {
        warnings.push('缺少 summary.json（可能是旧数据 / 尚未重新生成）');
      } else if (summaryFile.error) {
        errors.push(`summary.json 无法解析：${summaryFile.error.message}`);
      } else {
        result.present.push('summary.json');
        const summaryResult = validateSummaryData(summaryFile.data, {
          index: officialFullData,
          errors,
          warnings,
        });
        result.summaryRowCount = summaryResult.rowCount;
        if (!summaryCsvFile.exists) {
          errors.push('缺少 summary.csv');
        } else if (summaryCsvFile.error) {
          errors.push(`summary.csv 无法读取：${summaryCsvFile.error.message}`);
        } else {
          result.present.push('summary.csv');
          validateSummaryCsv(summaryCsvFile.text, summaryFile.data, { errors });
        }
      }
    }
  } else {
    warnings.push(`找不到 ${INDEX_FILE}（模组索引尚未生成）`);
  }

  // ---------- 社区模组（community/，可选） ----------
  if (communityIndexFile.exists) {
    result.present.push(`${COMMUNITY_DIR}/index.json`);
    if (communityIndexFile.error) {
      errors.push(`${COMMUNITY_DIR}/index.json 无法解析：${communityIndexFile.error.message}`);
    } else {
      let communityReleaseFiles = new Set();
      try {
        const relativeFiles = await listReleaseFiles(path.join(outDir, COMMUNITY_DIR));
        communityReleaseFiles = new Set(
          relativeFiles.map((relPath) => `${COMMUNITY_DIR}/${relPath}`),
        );
      } catch (error) {
        errors.push(`${COMMUNITY_DIR}/releases 枚举失败：${error.message}`);
      }
      result.communityReleaseFileCount = communityReleaseFiles.size;
      const officialFullData =
        indexFullFile.exists && !indexFullFile.error ? indexFullFile.data : indexFile.data;
      const officialMods = Array.isArray(officialFullData?.mods) ? officialFullData.mods : [];
      const officialRepos = new Set(
        officialMods
          .filter((mod) => typeof mod?.repo === 'string')
          .map((mod) => mod.repo.toLowerCase()),
      );
      if (!communityFullIndexFile.exists) {
        errors.push(`缺少 ${COMMUNITY_FULL_INDEX_REL_PATH}（社区全量列表）`);
      } else if (communityFullIndexFile.error) {
        errors.push(`${COMMUNITY_FULL_INDEX_REL_PATH} 无法解析：${communityFullIndexFile.error.message}`);
      } else {
        result.present.push(COMMUNITY_FULL_INDEX_REL_PATH);
        validateIndexData(communityFullIndexFile.data, {
          errors,
          warnings,
          releaseFiles: communityReleaseFiles,
          mode: 'community',
          officialRepos,
        });
        validateDefaultListConsistency(communityIndexFile.data, communityFullIndexFile.data, {
          label: `${COMMUNITY_DIR}/index.json`,
          errors,
        });
      }
      validateIndexData(communityIndexFile.data, {
        errors,
        warnings,
        mode: 'community',
        officialRepos,
      });
      const communityFullData =
        communityFullIndexFile.exists && !communityFullIndexFile.error
          ? communityFullIndexFile.data
          : communityIndexFile.data;

      const loaded = new Map();
      for (const relPath of communityReleaseFiles) {
        try {
          loaded.set(relPath, JSON.parse(await readFile(path.join(outDir, relPath), 'utf8')));
        } catch (error) {
          errors.push(`${relPath} 无法解析：${error.message}`);
        }
      }
      const usedFiles = new Set();
      const communityMods = Array.isArray(communityFullData?.mods)
        ? communityFullData.mods
        : [];
      for (const mod of communityMods) {
        if (
          !isPlainObject(mod) ||
          typeof mod.repo !== 'string' ||
          typeof mod.releasesPath !== 'string'
        ) {
          continue;
        }
        const pagePaths =
          Array.isArray(mod.pages) && mod.pages.length > 0
            ? mod.pages.map((page) => page?.path)
            : [mod.releasesPath];
        const pageFiles = [];
        for (const pagePath of pagePaths) {
          const pageFile = loaded.get(pagePath);
          if (!pageFile) {
            errors.push(`${pagePath} 文件不存在（index 引用了不存在的 per-mod 文件）`);
            continue;
          }
          usedFiles.add(pagePath);
          const fileErrors = [];
          validateReleaseFileData(pageFile, { expectedRepo: mod.repo, errors: fileErrors });
          for (const message of fileErrors) {
            errors.push(`${pagePath}：${message}`);
          }
          pageFiles.push(pageFile);
        }
        if (pageFiles.length === 0) {
          continue;
        }
        const file = pageFiles[0];
        if (file.formatVersion === 3) {
          const versions = pageFiles.flatMap((pageFile) =>
            Array.isArray(pageFile?.versions) ? pageFile.versions : [],
          );
          const releaseCount = versions.filter((item) => item.kind === 'release').length;
          if (releaseCount !== mod.releaseCount) {
            errors.push(`${mod.repo} 的 releaseCount（${mod.releaseCount}）与文件 release 版本数（${releaseCount}）不一致`);
          }
          if (mod.modType !== 'java' && versions.length !== mod.tagCount) {
            errors.push(`${mod.repo} 的 tagCount（${mod.tagCount}）与 versions 数量（${versions.length}）不一致`);
          }
          continue;
        }
        if (!Array.isArray(file.releases)) {
          continue;
        }
        const releaseEntries = file.releases.filter((entry) => entry?.hasRelease !== false);
        if (mod.releaseCount !== releaseEntries.length) {
          errors.push(
            `community ${mod.repo} 的 releaseCount（${mod.releaseCount}）与 hasRelease=true 条数（${releaseEntries.length}）不一致`,
          );
        }
        if (mod.tagCount !== file.releases.length) {
          errors.push(
            `community ${mod.repo} 的 tagCount（${mod.tagCount}）与文件条数（${file.releases.length}）不一致`,
          );
        }
        const removedEntries = file.releases.filter((entry) => entry?.removed === true).length;
        if (mod.removedCount !== removedEntries) {
          errors.push(
            `community ${mod.repo} 的 removedCount（${mod.removedCount}）与文件条数（${removedEntries}）不一致`,
          );
        }
        const compat = Array.isArray(file.compat) ? file.compat : [];
        if (mod.compatRanges !== compat.length) {
          errors.push(
            `community ${mod.repo} 的 compatRanges（${mod.compatRanges}）与 compat 条数（${compat.length}）不一致`,
          );
        }
        const expectedLatestCompatible = latestCompatibleTag(compat, gameVersions);
        if (mod.latestCompatible !== expectedLatestCompatible) {
          errors.push(
            `community ${mod.repo} 的 latestCompatible（${mod.latestCompatible}）与 compat 重算（${expectedLatestCompatible}）不一致`,
          );
        }
        const firstTag =
          (releaseEntries.find((entry) => entry?.removed !== true) ?? releaseEntries[0])
            ?.tag ?? null;
        if ((mod.latestRelease?.tag ?? null) !== firstTag) {
          errors.push(
            `community ${mod.repo} 的 latestRelease.tag 与文件首个未删除 Release 条目（${firstTag}）不一致`,
          );
        }
        if (mod.releaseDataUpdatedAt !== file.generatedAt) {
          errors.push(`community ${mod.repo} 的 releaseDataUpdatedAt 与文件 generatedAt 不一致`);
        }
        const stats = computeModStats(file.releases, mod.hasJava === true);
        for (const field of ['totalDownloads', 'allAssetsDownloads', 'latestDownloads', 'latestSizeBytes', 'totalSizeBytes']) {
          if (mod[field] !== stats[field]) {
            errors.push(`community ${mod.repo} 的 ${field} 与 per-mod 数据重算不一致`);
          }
        }
        if (mod.latestRelease && typeof mod.latestRelease === 'object') {
          if (mod.latestRelease.downloads !== stats.latestDownloads) {
            errors.push(`community ${mod.repo} 的 latestRelease.downloads 与重算不一致`);
          }
          if (mod.latestRelease.sizeBytes !== stats.latestSizeBytes) {
            errors.push(`community ${mod.repo} 的 latestRelease.sizeBytes 与重算不一致`);
          }
        }
      }
      for (const relPath of communityReleaseFiles) {
        if (!usedFiles.has(relPath)) {
          warnings.push(`${relPath} 没有被 community index 引用`);
        }
      }
      result.communityModCount = communityMods.length;

      if (communitySummaryFile.exists) {
        result.present.push(`${COMMUNITY_DIR}/summary.json`);
        if (communitySummaryFile.error) {
          errors.push(`${COMMUNITY_DIR}/summary.json 无法解析：${communitySummaryFile.error.message}`);
        } else {
          const summaryResult = validateSummaryData(communitySummaryFile.data, {
            index: communityFullData,
            errors,
            warnings,
          });
          result.communitySummaryRowCount = summaryResult.rowCount;
          if (!communitySummaryCsvFile.exists) {
            errors.push('缺少 community/summary.csv');
          } else if (communitySummaryCsvFile.error) {
            errors.push(`community/summary.csv 无法读取：${communitySummaryCsvFile.error.message}`);
          } else {
            result.present.push(`${COMMUNITY_DIR}/summary.csv`);
            validateSummaryCsv(communitySummaryCsvFile.text, communitySummaryFile.data, {
              errors,
            });
          }
        }
      }
    }
  }

  if (communityStateFile.exists) {
    result.present.push(COMMUNITY_STATE_REL_PATH);
    if (communityStateFile.error) {
      errors.push(`${COMMUNITY_STATE_REL_PATH} 无法解析：${communityStateFile.error.message}`);
    } else {
      result.communityStateModCount = validateRefreshStateData(communityStateFile.data, {
        errors,
      }).modCount;
    }
  }

  if (refreshStateFile.exists) {
    result.present.push(REFRESH_STATE_REL_PATH);
    if (refreshStateFile.error) {
      errors.push(`${REFRESH_STATE_REL_PATH} 无法解析：${refreshStateFile.error.message}`);
    } else {
      result.refreshStateModCount = validateRefreshStateData(refreshStateFile.data, {
        errors,
      }).modCount;
    }
  }

  if (versionsFile.exists) {
    result.present.push(VERSIONS_REL_PATH);
    if (versionsFile.error) {
      errors.push(`${VERSIONS_REL_PATH} 无法解析：${versionsFile.error.message}`);
    } else {
      const versionsResult = validateVersionsData(versionsFile.data, {
        errors,
        warnings,
      });
      result.versionsCount = versionsResult.releaseCount;
      result.latestBe = versionsResult.latestBe;
    }
  }

  const anyGatePresent = modGateFile.exists || javaGateFile.exists;
  for (const type of ['mod', 'java']) {
    const gateFile = type === 'mod' ? modGateFile : javaGateFile;
    const relPath = GATE_REL_PATHS[type];
    if (!gateFile.exists) {
      if (anyGatePresent || versionsFile.exists) {
        warnings.push(`缺少 ${relPath}（门禁尚未生成或仍是旧合并格式）`);
      }
      continue;
    }
    result.present.push(relPath);
    if (gateFile.error) {
      errors.push(`${relPath} 无法解析：${gateFile.error.message}`);
    } else {
      const gateResult = validateGateData(gateFile.data, { type, errors });
      result.gates[type] = {
        versionCount: gateResult.versionCount,
        ruleCount: gateResult.ruleCount,
      };
    }
  }

  if (heartbeatFile.exists) {
    result.present.push(HEARTBEAT_REL_PATH);
    if (heartbeatFile.error) {
      errors.push(`${HEARTBEAT_REL_PATH} 无法解析：${heartbeatFile.error.message}`);
    } else {
      validateHeartbeatData(heartbeatFile.data, { errors });
    }
  }

  // B4/B5：运行状态与变更流（允许缺失；存在时校验结构）
  if (statusFile.exists) {
    result.present.push(STATUS_REL_PATH);
    if (statusFile.error) {
      errors.push(`${STATUS_REL_PATH} 无法解析：${statusFile.error.message}`);
    } else {
      validateStatusData(statusFile.data, { errors });
    }
  } else {
    warnings.push(`缺少 ${STATUS_REL_PATH}（可能是尚未运行过新版本）`);
  }
  if (changesFile.exists) {
    result.present.push(CHANGES_REL_PATH);
    if (changesFile.error) {
      errors.push(`${CHANGES_REL_PATH} 无法解析：${changesFile.error.message}`);
    } else {
      result.changesCount = validateChangesData(changesFile.data, { errors, warnings }).count;
    }
  } else {
    warnings.push(`缺少 ${CHANGES_REL_PATH}（可能是尚未运行过新版本）`);
  }

  // heat 已合并进 index.json / community/index.json / summary；这里做全局排名与旧文件一致性校验
  const officialFullForHeat =
    indexFullFile.exists && !indexFullFile.error ? indexFullFile.data : indexFile.data;
  const communityFullForHeat =
    communityFullIndexFile.exists && !communityFullIndexFile.error
      ? communityFullIndexFile.data
      : communityIndexFile.data;
  const officialModsForHeat = Array.isArray(officialFullForHeat?.mods)
    ? officialFullForHeat.mods
    : [];
  const communityModsForHeat = Array.isArray(communityFullForHeat?.mods)
    ? communityFullForHeat.mods
    : [];
  const allHeatEntries = [];
  for (const mod of [...officialModsForHeat, ...communityModsForHeat]) {
    if (isPlainObject(mod) && typeof mod.repo === 'string' && isPlainObject(mod.score)) {
      allHeatEntries.push({ repo: mod.repo, rank: mod.ranks?.heat });
    }
  }
  result.scoreModCount = allHeatEntries.length;
  const seenRanks = new Set();
  for (const { rank } of allHeatEntries) {
    if (Number.isInteger(rank)) {
      if (seenRanks.has(rank)) {
        errors.push(`${HEAT_INDEX_REL_PATH} 全局 score.rank 重复：${rank}`);
      }
      seenRanks.add(rank);
    }
  }
  if (allHeatEntries.length > 0) {
    if (seenRanks.size !== allHeatEntries.length) {
      errors.push('index.json / community/index.json 的全局 score.rank 不是 1..N 唯一');
    }
    for (const rank of seenRanks) {
      if (rank < 1 || rank > allHeatEntries.length) {
        errors.push(`index.json / community/index.json 的 score.rank 超出 1..N：${rank}`);
      }
    }
  }
  if (heatIndexFile.exists) {
    warnings.push(
      '旧 heat/index.json 已废弃（热度已合并进 index.json / community/index.json）；运行 heat 数据集会自动清理',
    );
  }
  if (heatSummaryCsvFile.exists) {
    warnings.push(
      '旧 heat/summary.csv 已废弃（热度列已合并进 summary.csv）；运行 heat 数据集会自动清理',
    );
  }
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const files = heatHistoryFiles[kind];
    result.scoreHistoryCounts[kind] = files.length;
    if (files.length > HISTORY_LIMITS[kind]) {
      errors.push(
        `${HEAT_HISTORY_DIR}/${kind} 超过保留数量（${files.length} > ${HISTORY_LIMITS[kind]}）`,
      );
    }
    for (const file of files) {
      const relPath = path.join(HEAT_HISTORY_DIR, kind, file);
      const pattern =
        kind === 'daily'
          ? /^\d{4}-\d{2}-\d{2}\.json$/
          : kind === 'weekly'
            ? /^\d{4}-W\d{2}\.json$/
            : /^\d{4}-\d{2}\.json$/;
      if (!pattern.test(file)) {
        errors.push(`${relPath} 文件名不符合 ${kind} 格式`);
      }
      const snapshotFile = await readJsonIfPresent(path.join(outDir, relPath));
      if (snapshotFile.error) {
        errors.push(`${relPath} 无法解析：${snapshotFile.error.message}`);
      } else {
        validateHeatHistorySnapshot(snapshotFile.data, { where: relPath, errors });
      }
    }
  }
  if (heatCommitStateFile.exists) {
    result.present.push(HEAT_COMMIT_STATE_REL_PATH);
    if (heatCommitStateFile.error) {
      errors.push(`${HEAT_COMMIT_STATE_REL_PATH} 无法解析：${heatCommitStateFile.error.message}`);
    } else {
      validateHeatCommitState(heatCommitStateFile.data, { errors });
    }
  }
  if (heatCreatedStateFile.exists) {
    result.present.push(HEAT_CREATED_STATE_REL_PATH);
    if (heatCreatedStateFile.error) {
      errors.push(`${HEAT_CREATED_STATE_REL_PATH} 无法解析：${heatCreatedStateFile.error.message}`);
    } else {
      validateHeatCreatedState(heatCreatedStateFile.data, { errors });
    }
  }

  return result;
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

  const result = await validateDir(dir);
  console.log(`校验目录：${path.resolve(dir)}`);
  if (result.present.length > 0) {
    console.log(`数据文件：${result.present.join('、')}`);
  }
  if (result.present.includes(INDEX_FILE)) {
    console.log(`index.json：${result.modCount} 个模组，${result.releaseFileCount} 个 releases 文件`);
  }
  if (result.present.includes('summary.json')) {
    console.log(`summary：${result.summaryRowCount} 行（summary.json + summary.csv）`);
  }
  if (result.present.includes(REFRESH_STATE_REL_PATH)) {
    console.log(`state/refresh.json：${result.refreshStateModCount} 个模组分页缓存`);
  }
  if (result.present.includes(`${COMMUNITY_DIR}/index.json`)) {
    console.log(
      `community：${result.communityModCount} 个模组，${result.communityReleaseFileCount} 个 releases 文件` +
        (result.communitySummaryRowCount > 0 ? `，summary ${result.communitySummaryRowCount} 行` : ''),
    );
  }
  if (result.present.includes(COMMUNITY_STATE_REL_PATH)) {
    console.log(`state/community-refresh.json：${result.communityStateModCount} 个模组分页缓存`);
  }
  if (result.present.includes(STATUS_REL_PATH)) {
    console.log(`status.json：已生成（数据集 ${DATASET_KEYS.filter((key) => result.present.length > 0).length} 类）`);
  }
  if (result.present.includes(CHANGES_REL_PATH)) {
    console.log(`changes.json：${result.changesCount} 条变更`);
  }
  if (result.present.includes(HEAT_INDEX_REL_PATH)) {
    const { daily, weekly, monthly } = result.scoreHistoryCounts;
    console.log(
      `heat：${result.scoreModCount} 个模组，历史快照 daily ${daily} / weekly ${weekly} / monthly ${monthly}`,
    );
  }
  if (result.present.includes(VERSIONS_REL_PATH)) {
    console.log(
      `versions.json：${result.versionsCount} 条正式版，最新 BE ${result.latestBe ?? '无'}`,
    );
  }
  for (const type of ['mod', 'java']) {
    const relPath = GATE_REL_PATHS[type];
    if (!result.present.includes(relPath) || !result.gates[type]) {
      continue;
    }
    const { versionCount, ruleCount } = result.gates[type];
    console.log(`${relPath}：${versionCount} 个版本 / ${ruleCount} 条规则`);
  }
  for (const warning of result.warnings) {
    console.warn(`警告：${warning}`);
  }
  for (const error of result.errors) {
    console.error(`错误：${error}`);
  }
  console.log(`错误 ${result.errors.length} 个，警告 ${result.warnings.length} 个`);
  return result.errors.length === 0 ? 0 : 1;
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
