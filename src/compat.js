// 预计算「游戏版本 → 推荐 tag」兼容区间（官方与社区同构）
//
// 语义：gameVersion ∈ [minGameVersion, maxGameVersion) 时该 tag 是推荐版本；
// 门禁规则：release 的 minGameVersion 为 M，它只能用在 gate(G) <= M 的游戏版本上，
// 上界取「门禁值第一次超过 M 的游戏版本」；同时不能盖过更新的 release 的 minGameVersion。

import { regularVersions } from './mod-gate.js';
import { isReleaseEntry } from './releases.js';

export function gameVersionsFromFile(versionsFile) {
  const releases = Array.isArray(versionsFile?.releases) ? versionsFile.releases : [];
  return regularVersions(releases);
}

export function gateValueForVersion(gateFile, version) {
  const direct = Array.isArray(gateFile?.versions)
    ? gateFile.versions.find((item) => item?.version === version)
    : null;
  if (direct && Number.isInteger(direct.value)) {
    return direct.value;
  }
  for (const rule of Array.isArray(gateFile?.rules) ? gateFile.rules : []) {
    if (
      Number.isFinite(rule?.min) &&
      version >= rule.min &&
      (rule.max === null || rule.max === undefined || version < rule.max)
    ) {
      return Number.isInteger(rule.value) ? rule.value : null;
    }
  }
  return null;
}

export function parseGameVersion(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const match = String(value).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function publishedTime(entry) {
  if (!entry?.publishedAt) {
    return Number.NaN;
  }
  return Date.parse(entry.publishedAt);
}

// 更新的 release 优先；没有发布时间（tag-only）的按 tag 自然降序兜底
function compareNewestFirst(left, right) {
  const timeA = publishedTime(left.entry);
  const timeB = publishedTime(right.entry);
  const valueA = Number.isNaN(timeA) ? -Infinity : timeA;
  const valueB = Number.isNaN(timeB) ? -Infinity : timeB;
  if (valueA !== valueB) {
    return valueB - valueA;
  }
  return String(right.entry.tag).localeCompare(String(left.entry.tag), undefined, {
    numeric: true,
  });
}

function subtractRange(start, end, intervals) {
  let pieces = [[start, end]];
  for (const interval of intervals) {
    const coveredStart = interval.min;
    const coveredEnd = interval.max ?? Infinity;
    const next = [];
    for (const [pieceStart, pieceEnd] of pieces) {
      if (pieceEnd <= coveredStart || pieceStart >= coveredEnd) {
        next.push([pieceStart, pieceEnd]);
        continue;
      }
      if (pieceStart < coveredStart) {
        next.push([pieceStart, Math.min(pieceEnd, coveredStart)]);
      }
      if (pieceEnd > coveredEnd) {
        next.push([Math.max(pieceStart, coveredEnd), pieceEnd]);
      }
    }
    pieces = next;
  }
  return pieces.filter(([pieceStart, pieceEnd]) => pieceEnd > pieceStart);
}

export function buildCompat({ entries, gameVersions = [], gateFile = null }) {
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.tag !== 'string' || entry.removed === true) {
      continue;
    }
    const min = parseGameVersion(entry.minGameVersion);
    if (min === null) {
      continue;
    }
    candidates.push({ entry, min });
  }
  const releases = candidates.filter((item) => isReleaseEntry(item.entry)).sort(compareNewestFirst);
  const tagOnly = candidates.filter((item) => !isReleaseEntry(item.entry)).sort(compareNewestFirst);

  const gateCutoff = (min) => {
    for (const game of gameVersions) {
      if (game.version < min) {
        continue;
      }
      const value = gateValueForVersion(gateFile, game.version);
      if (value !== null && value > min) {
        return game.version;
      }
    }
    return null;
  };

  const intervals = [];
  let newerCoverageStart = null;
  const addInterval = (entry, min, max) => {
    if (max !== null && max <= min) {
      return;
    }
    intervals.push({ entry, min, max });
  };

  for (const candidate of releases) {
    const cutoff = gateCutoff(candidate.min);
    let max = cutoff;
    if (newerCoverageStart !== null) {
      max = max === null ? newerCoverageStart : Math.min(max, newerCoverageStart);
    }
    addInterval(candidate.entry, candidate.min, max);
    newerCoverageStart =
      newerCoverageStart === null
        ? candidate.min
        : Math.min(newerCoverageStart, candidate.min);
  }

  // tag-only 条目填补 release 未覆盖的游戏版本区间（推荐优先 hasRelease=true）
  for (const candidate of tagOnly) {
    const cutoff = gateCutoff(candidate.min);
    const end = cutoff === null ? Infinity : cutoff;
    if (end <= candidate.min) {
      continue;
    }
    const pieces = subtractRange(candidate.min, end, intervals);
    for (const [pieceStart, pieceEnd] of pieces) {
      intervals.push({
        entry: candidate.entry,
        min: pieceStart,
        max: pieceEnd === Infinity ? null : pieceEnd,
        tagOnly: true,
      });
    }
  }

  return intervals
    .sort((left, right) => left.min - right.min)
    .map(({ entry, min, max }) => ({
      tag: entry.tag,
      modVersion: entry.modVersion ?? null,
      minGameVersion: entry.minGameVersion ?? String(min),
      maxGameVersion: max,
      hasRelease: isReleaseEntry(entry),
    }));
}

// 当前最新游戏版本下的推荐 tag
export function latestCompatibleTag(compat, gameVersions = []) {
  if (!Array.isArray(compat) || compat.length === 0 || gameVersions.length === 0) {
    return null;
  }
  const latest = gameVersions[gameVersions.length - 1].version;
  let found = null;
  for (const item of compat) {
    const min = parseGameVersion(item.minGameVersion);
    if (min === null || latest < min) {
      continue;
    }
    if (item.maxGameVersion === null || latest < item.maxGameVersion) {
      found = item;
    }
  }
  return found ? found.tag : null;
}
