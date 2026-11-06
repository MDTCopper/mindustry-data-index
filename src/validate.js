#!/usr/bin/env node
// 产物校验 CLI：检查 index.json / releases/*.json / mindustry/versions.json / mindustry/mod-gate.json

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { INDEX_FILE, RELEASES_DIR, listReleaseFiles } from './writer.js';
import { MOD_ICON_BASE } from './mods-source.js';
import { VERSIONS_REL_PATH, VERSIONS_API } from './versions.js';
import {
  GATE_REL_PATH,
  GATE_REPO,
  GATE_BASELINE_URL,
  GATE_CONSTANTS,
  gateStartVersion,
  mergeGateRules,
} from './mod-gate.js';

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
    if (mod.hasIcon !== null && typeof mod.hasIcon !== 'boolean') {
      errors.push(`${where}.hasIcon 应为布尔值或 null`);
    }
    for (const field of ['hasScripts', 'hasJava']) {
      if (typeof mod[field] !== 'boolean') {
        errors.push(`${where}.${field} 应为布尔值`);
      }
    }
    // iconUrl 与 repo / hasIcon 必须一致；iconHash 可为 null 或字符串
    if (mod.iconUrl !== null && typeof mod.iconUrl !== 'string') {
      errors.push(`${where}.iconUrl 应为字符串或 null`);
    } else if (typeof mod.repo === 'string' && /^[^/]+\/[^/]+$/.test(mod.repo)) {
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

export function validateGateData(file, { errors } = {}) {
  if (!isPlainObject(file)) {
    errors.push('mod-gate.json 顶层不是对象');
    return { versionCount: 0, ruleCount: 0 };
  }
  if (file.formatVersion !== 1) {
    errors.push(`mod-gate.formatVersion 应为 1，实际为 ${JSON.stringify(file.formatVersion)}`);
  }
  if (!isIsoDate(file.generatedAt)) {
    errors.push('mod-gate.generatedAt 缺失或不是 ISO 时间');
  }
  if (!isPlainObject(file.source)) {
    errors.push('mod-gate.source 缺失');
  } else {
    if (file.source.repo !== GATE_REPO) {
      errors.push(`mod-gate.source.repo 应为 ${GATE_REPO}`);
    }
    if (
      typeof file.source.baseline !== 'string' ||
      !file.source.baseline.startsWith('https://')
    ) {
      errors.push('mod-gate.source.baseline 应为 https 地址');
    }
    if (file.source.baseline !== GATE_BASELINE_URL) {
      errors.push(`mod-gate.source.baseline 应为 ${GATE_BASELINE_URL}`);
    }
    if (
      !Array.isArray(file.source.constants) ||
      GATE_CONSTANTS.some((name) => !file.source.constants.includes(name))
    ) {
      errors.push('mod-gate.source.constants 缺少门禁常量名');
    }
    if (
      !Array.isArray(file.source.resolvedPaths) ||
      file.source.resolvedPaths.some((item) => typeof item !== 'string')
    ) {
      errors.push('mod-gate.source.resolvedPaths 应为字符串数组');
    }
  }

  if (!Array.isArray(file.rules) || file.rules.length === 0) {
    errors.push('mod-gate.rules 不是非空数组');
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
    for (const field of ['mod', 'java']) {
      if (!Number.isInteger(rule[field])) {
        errors.push(`${where}.${field} 应为整数`);
      }
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
    if (
      next !== undefined &&
      rule?.mod === next?.mod &&
      rule?.java === next?.java
    ) {
      errors.push(`rules[${index}] 与下一条门禁值相同，未合并`);
    }
  }
  const lastRule = rules[rules.length - 1];
  if (isPlainObject(lastRule) && lastRule.max !== null) {
    errors.push('最后一条规则的 max 应为 null');
  }

  if (!Array.isArray(file.versions) || file.versions.length === 0) {
    errors.push('mod-gate.versions 不是非空数组');
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
    for (const field of ['mod', 'java']) {
      if (!Number.isInteger(item[field])) {
        errors.push(`${where}.${field} 应为整数`);
      }
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

async function readJsonIfPresent(file) {
  try {
    return { exists: true, data: JSON.parse(await readFile(file, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, data: null };
    }
    return { exists: true, data: null, error };
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
    gateVersionCount: 0,
    gateRuleCount: 0,
    present: [],
  };

  const indexFile = await readJsonIfPresent(path.join(outDir, INDEX_FILE));
  const versionsFile = await readJsonIfPresent(path.join(outDir, VERSIONS_REL_PATH));
  const gateFile = await readJsonIfPresent(path.join(outDir, GATE_REL_PATH));
  const heartbeatFile = await readJsonIfPresent(
    path.join(outDir, HEARTBEAT_REL_PATH),
  );

  if (!indexFile.exists && !versionsFile.exists && !gateFile.exists) {
    errors.push(
      `找不到任何数据文件（${INDEX_FILE} / ${VERSIONS_REL_PATH} / ${GATE_REL_PATH}）`,
    );
    return result;
  }

  if (indexFile.exists) {
    result.present.push(INDEX_FILE);
    if (indexFile.error) {
      errors.push(`${INDEX_FILE} 无法解析：${indexFile.error.message}`);
    } else {
      validateIndexData(indexFile.data, { errors, warnings, releaseFiles });
      const loaded = new Map();
      for (const relPath of releaseFiles) {
        try {
          loaded.set(relPath, JSON.parse(await readFile(path.join(outDir, relPath), 'utf8')));
        } catch (error) {
          errors.push(`${relPath} 无法解析：${error.message}`);
        }
      }
      const usedFiles = new Set();
      const mods = Array.isArray(indexFile.data?.mods) ? indexFile.data.mods : [];
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
      result.modCount = mods.length;
    }
  } else {
    warnings.push(`找不到 ${INDEX_FILE}（模组索引尚未生成）`);
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

  if (gateFile.exists) {
    result.present.push(GATE_REL_PATH);
    if (gateFile.error) {
      errors.push(`${GATE_REL_PATH} 无法解析：${gateFile.error.message}`);
    } else {
      const gateResult = validateGateData(gateFile.data, { errors });
      result.gateVersionCount = gateResult.versionCount;
      result.gateRuleCount = gateResult.ruleCount;
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
  if (result.present.includes(VERSIONS_REL_PATH)) {
    console.log(
      `versions.json：${result.versionsCount} 条正式版，最新 BE ${result.latestBe ?? '无'}`,
    );
  }
  if (result.present.includes(GATE_REL_PATH)) {
    console.log(
      `mod-gate.json：${result.gateVersionCount} 个版本 / ${result.gateRuleCount} 条规则`,
    );
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
