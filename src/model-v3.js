// 数据模型 v3：per-mod versions、modType、游戏版本闭区间、时间与字段收敛
//
// 内部仍复用 v2 的 Release/tag 缓存结构；写盘与 index 构建时转换成 v3。

import { regularVersions } from './mod-gate.js';
import { gateValueForVersion } from './compat.js';
import { isReleaseEntry, pickDownloadUrl, sourceArchiveUrl } from './releases.js';

export const MODEL_V3_FORMAT_VERSION = 3;

function toText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

// 游戏版本字符串（保留 . 小数）；接受 compat.js 的 [{tag,version}] 或 versions.json
export function gameVersionList(versionsInput) {
  if (Array.isArray(versionsInput)) {
    return versionsInput
      .filter((item) => Number.isFinite(Number(item?.version)))
      .map((item) => ({ value: Number(item.version), text: String(item.version) }))
      .sort((a, b) => a.value - b.value);
  }
  return regularVersions(versionsInput?.releases).map((item) => ({
    value: item.version,
    text: String(item.version),
  }));
}

export function gateValueFor(gateFile, version) {
  return gateValueForVersion(gateFile, version);
}

// 按 Version.isAtLeast 语义解析 minGameVersion：major[.minor]，非法/缺失返回 null
export function parseMinVersion(minGameVersion) {
  const text = toText(minGameVersion);
  if (!text) return null;
  const match = /^(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return { major: Number(match[1]), minor: match[2] === undefined ? 0 : Number(match[2]) };
}

function gateMajor(value) {
  return Number.isInteger(value) ? value : Math.trunc(Number(value) || 0);
}

// 根据 minGameVersion 与门禁，取游戏版本的连续闭区间
export function computeGameVersionRanges({
  minGameVersion,
  gameVersions,
  gateFile = null,
}) {
  const min = parseMinVersion(minGameVersion);
  if (!min || !Array.isArray(gameVersions)) {
    return [];
  }
  const list = gameVersions
    .map((item) => {
      const value = Number(item?.value ?? item?.version);
      if (!Number.isFinite(value)) return null;
      const major = Math.trunc(value);
      const minor = Math.round((value - major) * 10);
      return { value, major, minor, text: String(item?.text ?? item?.version) };
    })
    .filter(Boolean)
    .sort((left, right) => left.value - right.value);
  const ranges = [];
  let current = null;
  for (const item of list) {
    const gateValue = gateValueForVersion(gateFile, item.value);
    const atLeast = item.major > min.major || (item.major === min.major && item.minor >= min.minor);
    const passes = atLeast && (gateValue === null || gateMajor(gateValue) <= min.major);
    if (passes) {
      if (!current) {
        current = { from: item.text, to: item.text };
        ranges.push(current);
      } else {
        current.to = item.text;
      }
    } else {
      current = null;
    }
  }
  return ranges;
}

// 多段区间取并集（合并重叠/相邻）
export function mergeGameVersionRanges(ranges) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({ from: Number(range?.from), to: Number(range?.to) }))
    .filter((range) => Number.isFinite(range.from) && Number.isFinite(range.to))
    .sort((a, b) => a.from - b.from);
  const merged = [];
  for (const range of list) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 1e-9) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.map((range) => ({ from: String(range.from), to: String(range.to) }));
}

export function modTypeOf({ meta, releases = [] }) {
  // 游戏语义：java = meta.java 或 main 非空；js = root scripts/ 有 .js（探测后写入 meta.hasScripts）；
  // 官方列表的 hasJava/hasScripts 是 bot 启发式，不再使用。
  if (meta?.java === true || (typeof meta?.main === 'string' && meta.main.trim().length > 0)) {
    return 'java';
  }
  if (meta?.hasScripts === true) return 'js';
  const hasJar = releases.some(
    (entry) =>
      Array.isArray(entry?.assets) &&
      entry.assets.some((asset) => String(asset?.name ?? '').toLowerCase().endsWith('.jar')),
  );
  if (hasJar) return 'java';
  return 'json';
}

function latestMetadataMin(releases) {
  for (const entry of releases) {
    const min = toText(entry?.minGameVersion);
    if (min) return min;
  }
  return null;
}

// v2 release/tag 条目 → v3 version 条目
export function buildV3Versions({
  repo,
  releases,
  meta,
  modType,
  gameVersions,
  gateFile = null,
}) {
  const versions = [];
  for (const entry of Array.isArray(releases) ? releases : []) {
    const tag = toText(entry?.tag);
    if (!tag) continue;
    const minGameVersion = toText(entry?.minGameVersion);
    // 没有 minGameVersion（或数组/非法值）的版本直接丢弃
    if (!minGameVersion || parseMinVersion(minGameVersion) === null) continue;
    const assets = Array.isArray(entry?.assets) ? entry.assets : [];
    const isRelease = isReleaseEntry(entry);
    const hasAssets = assets.length > 0;
    let kind;
    if (isRelease && hasAssets) {
      kind = 'release';
    } else if (modType !== 'java') {
      // 非 Java：无资产的 Release 也按源码归档下载（等价 tag 条目）
      kind = 'tag';
    } else {
      continue;
    }
    const archiveUrl = sourceArchiveUrl(repo, tag);
    const downloadUrl =
      kind === 'release'
        ? pickDownloadUrl(assets, { hasJava: modType === 'java', archiveUrl })
        : archiveUrl;
    const ranges = computeGameVersionRanges({
      minGameVersion,
      gameVersions,
      gateFile,
    });
    const version = {
      tag,
      kind,
      minGameVersion,
      gameVersionRanges: ranges,
      downloadUrl: downloadUrl || archiveUrl,
    };
    const modVersion = toText(entry.modVersion) ?? toText(meta?.version);
    if (modVersion) version.modVersion = modVersion;
    const sizeBytes = assets.reduce((sum, asset) => sum + (Number(asset?.size) || 0), 0);
    const downloadCount = assets.reduce(
      (sum, asset) => sum + (Number(asset?.downloadCount ?? asset?.download_count) || 0),
      0,
    );
    if (kind === 'release' && sizeBytes > 0) version.sizeBytes = sizeBytes;
    if (kind === 'release' && downloadCount > 0) version.downloadCount = downloadCount;
    const releasedAt = toText(entry?.publishedAt);
    if (releasedAt) version.releasedAt = releasedAt;
    const committedAt = toText(entry?.committedAt);
    if (committedAt) version.committedAt = committedAt;
    if (entry?.prerelease === true) version.prerelease = true;
    if (entry?.removed === true) {
      version.removed = true;
      const removedAt = toText(entry?.removedAt);
      if (removedAt) version.removedAt = removedAt;
    }
    versions.push(version);
  }
  versions.sort((a, b) => {
    const aTime = a.releasedAt ? Date.parse(a.releasedAt) : Number.NaN;
    const bTime = b.releasedAt ? Date.parse(b.releasedAt) : Number.NaN;
    if (!Number.isNaN(aTime) || !Number.isNaN(bTime)) {
      const av = Number.isNaN(aTime) ? -Infinity : aTime;
      const bv = Number.isNaN(bTime) ? -Infinity : bTime;
      if (av !== bv) return bv - av;
    }
    // 都没有 releasedAt：按自然版本号降序（v2.0 应排在 v1.0 前），避免字典序把最新版排到后面
    const byNatural = String(a.tag).localeCompare(String(b.tag), 'en', {
      numeric: true,
      sensitivity: 'base',
    });
    return byNatural !== 0 ? -byNatural : String(a.tag) < String(b.tag) ? -1 : 1;
  });
  return versions;
}

// v3 per-mod 文件 → 内部 v2 风格 release/tag 条目（继续复用刷新/合并逻辑）
export function releasesFromVersions(file) {
  const versions = Array.isArray(file?.versions) ? file.versions : [];
  return versions.map((version) => {
    const kind = version?.kind === 'release' ? 'release' : 'tag';
    return {
      tag: version.tag,
      name: version.tag,
      hasRelease: kind === 'release',
      prerelease: version.prerelease === true ? true : null,
      publishedAt: version.releasedAt ?? null,
      committedAt: version.committedAt ?? null,
      htmlUrl: `https://github.com/${file.repo}/tree/${encodeURIComponent(version.tag)}`,
      modVersion: version.modVersion ?? null,
      minGameVersion: version.minGameVersion ?? null,
      metadataPath: null,
      metadataStatus: version.minGameVersion ? 'ok' : null,
      downloadUrl: version.downloadUrl ?? null,
      sourceArchiveUrl: sourceArchiveUrl(file.repo, version.tag),
      assets:
        kind === 'release' && Number.isFinite(version.sizeBytes)
          ? [
              {
                name: version.downloadUrl?.split('/').pop() ?? version.tag,
                size: version.sizeBytes,
                downloadCount: version.downloadCount ?? 0,
                downloadUrl: version.downloadUrl,
              },
            ]
          : [],
      removed: version.removed === true,
      removedAt: version.removedAt ?? null,
    };
  });
}

export function buildModelV3File({
  repo,
  generatedAt,
  modType,
  versions,
  meta = null,
}) {
  return {
    formatVersion: MODEL_V3_FORMAT_VERSION,
    repo,
    generatedAt,
    modType,
    versions,
    ...(meta ? { meta } : {}),
  };
}

// 汇总 mod 级 v3 字段
export function summarizeVersions(versions) {
  const releaseVersions = versions.filter((item) => item.kind === 'release');
  const visible = versions.filter((item) => item.removed !== true);
  const latest = visible[0] ?? versions[0] ?? null;
  const releaseUpdatedAt =
    visible
      .map((item) => item.releasedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  return {
    releaseCount: releaseVersions.length,
    tagCount: versions.length,
    latestMinGameVersion: latest?.minGameVersion ?? latestMetadataMin(versions) ?? null,
    releaseUpdatedAt,
    gameVersionRanges: mergeGameVersionRanges(
      versions.flatMap((item) => item.gameVersionRanges ?? []),
    ),
  };
}
