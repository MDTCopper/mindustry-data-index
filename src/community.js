// 社区模组：收录标准过滤、完整元数据、图标探测、index 条目构造

import { rawFileUrlVariants } from './releases.js';
import { fetchCommunityModMetadata } from './mod-meta.js';
import { assertRepo } from './paths.js';
import { isBlacklisted } from './blacklist.js';
import { latestCompatibleTag } from './compat.js';

export const COMMUNITY_DIR = 'community';
export const COMMUNITY_STATE_REL_PATH = 'state/community-refresh.json';
export const COMMUNITY_SOURCE = 'topic';
export const COMMUNITY_MIN_GAME_VERSION = 136;
export const COMMUNITY_ICON_CANDIDATES = ['icon.png', 'assets/icon.png'];

// search 结果先按仓库状态与黑名单过滤；元数据阶段再按收录标准过滤
export function prefilterCandidate(candidate, { officialRepos, blacklist, stats = null }) {
  const key = candidate.repo.toLowerCase();
  if (officialRepos?.has(key)) {
    if (stats) {
      stats.official += 1;
    }
    return null;
  }
  if (candidate.archived) {
    if (stats) {
      stats.archived += 1;
    }
    return null;
  }
  if (candidate.template) {
    if (stats) {
      stats.template += 1;
    }
    return null;
  }
  if (
    isBlacklisted(
      {
        repo: candidate.repo,
        name: candidate.repo.split('/')[1] ?? '',
        description: candidate.description ?? '',
      },
      blacklist,
    )
  ) {
    if (stats) {
      stats.blacklisted += 1;
    }
    return null;
  }
  return candidate;
}

function parseMinGameVersion(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const match = String(value).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// 元数据阶段过滤：minGameVersion >= 136、hideBrowser、元数据可解析，且名称/描述不命中 globalBlacklist
export function checkEligibility(candidate, metadata, blacklist, stats = null) {
  if (!metadata) {
    if (stats) {
      stats.noMetadata += 1;
    }
    return null;
  }
  const minGameVersion = parseMinGameVersion(metadata.minGameVersion);
  if (minGameVersion === null || minGameVersion < COMMUNITY_MIN_GAME_VERSION) {
    if (stats) {
      stats.lowVersion += 1;
    }
    return null;
  }
  if (metadata.hideBrowser) {
    if (stats) {
      stats.hidden += 1;
    }
    return null;
  }
  const name = metadata.name ?? candidate.repo.split('/')[1] ?? '';
  if (isBlacklisted({ repo: candidate.repo, name, description: metadata.description ?? '' }, blacklist)) {
    if (stats) {
      stats.blacklisted += 1;
    }
    return null;
  }
  return { candidate, metadata, minGameVersion };
}

// 图标：root icon.png 优先，其次 assets/icon.png（raw GET 200 才算命中）
export async function detectCommunityIcon(client, { repo, ref }) {
  for (const filePath of COMMUNITY_ICON_CANDIDATES) {
    const urls = rawFileUrlVariants(repo, ref, filePath);
    for (const url of urls) {
      let response;
      try {
        response = await client.get(url);
      } catch {
        continue;
      }
      if (response.status === 404) {
        continue;
      }
      if (response.status === 200) {
        return {
          iconUrl: `https://raw.githubusercontent.com/${assertRepo(repo)}/${encodeURIComponent(ref)}/${filePath}`,
          iconPath: filePath,
        };
      }
      break;
    }
  }
  return { iconUrl: null, iconPath: null };
}

export function buildCommunityMod({ candidate, metadata, iconUrl }) {
  const [owner] = candidate.repo.split('/');
  return {
    repo: candidate.repo,
    source: COMMUNITY_SOURCE,
    internalName: null,
    name: metadata.name ?? candidate.repo.split('/')[1],
    author: metadata.author ?? owner,
    version: metadata.modVersion ?? null,
    minGameVersion: metadata.minGameVersion ?? null,
    description: metadata.description ?? '',
    lastUpdated: candidate.updatedAt ?? candidate.pushedAt ?? null,
    stars: candidate.stars ?? 0,
    hasIcon: iconUrl !== null,
    hasScripts: metadata.hasScripts === true,
    hasJava: metadata.hasJava === true,
    iconUrl,
    iconHash: null,
    defaultBranch: candidate.defaultBranch ?? 'main',
  };
}

export function buildCommunityIndexEntry(
  mod,
  file,
  { relPath, oldEntry = null, stats = null, compat = null, gameVersions = [] } = {},
) {
  const hasFile = Array.isArray(file?.releases);
  const releases = hasFile ? file.releases : [];
  const releaseEntries = releases.filter((entry) => entry?.hasRelease !== false);
  const first =
    releaseEntries.find((entry) => entry.removed !== true) ??
    releaseEntries[0] ??
    null;
  const releaseCount = hasFile
    ? releaseEntries.length
    : (oldEntry?.releaseCount ?? 0);
  const tagCount = hasFile ? releases.length : (oldEntry?.tagCount ?? releaseCount);
  const fileCompat = Array.isArray(compat)
    ? compat
    : (Array.isArray(file?.compat) ? file.compat : []);
  const computed = stats ?? {
    totalDownloads: 0,
    allAssetsDownloads: 0,
    latestDownloads: 0,
    latestSizeBytes: null,
    totalSizeBytes: null,
  };
  const latestRelease = first
    ? {
        tag: first.tag,
        name: first.name,
        prerelease: first.prerelease,
        publishedAt: first.publishedAt,
        downloads: computed.latestDownloads,
        sizeBytes: computed.latestSizeBytes,
      }
    : hasFile
      ? null
      : (oldEntry?.latestRelease ?? null);

  return {
    repo: mod.repo,
    source: COMMUNITY_SOURCE,
    internalName: null,
    name: mod.name,
    author: mod.author,
    version: mod.version,
    minGameVersion: mod.minGameVersion,
    description: mod.description ?? '',
    lastUpdated: mod.lastUpdated,
    stars: mod.stars,
    hasIcon: mod.hasIcon,
    hasScripts: mod.hasScripts,
    hasJava: mod.hasJava,
    iconUrl: mod.iconUrl ?? null,
    iconHash: null,
    releasesPath: hasFile
      ? `${COMMUNITY_DIR}/${relPath}`
      : (oldEntry?.releasesPath ?? (file ? `${COMMUNITY_DIR}/${relPath}` : null)),
    releaseCount,
    tagCount,
    removedCount: hasFile
      ? releases.filter((entry) => entry?.removed === true).length
      : (oldEntry?.removedCount ?? 0),
    totalDownloads: computed.totalDownloads,
    allAssetsDownloads: computed.allAssetsDownloads,
    latestDownloads: computed.latestDownloads,
    latestSizeBytes: computed.latestSizeBytes,
    totalSizeBytes: computed.totalSizeBytes,
    latestRelease,
    latestCompatible: latestCompatibleTag(fileCompat, gameVersions),
    compatRanges: fileCompat.length,
    releaseDataUpdatedAt: file?.generatedAt ?? oldEntry?.releaseDataUpdatedAt ?? null,
  };
}

export async function probeAndFilterCandidates({
  candidates,
  rawClient,
  apiClient,
  officialRepos,
  blacklist,
  log = () => {},
  maxCandidates = null,
}) {
  const stats = {
    official: 0,
    archived: 0,
    template: 0,
    blacklisted: 0,
    noMetadata: 0,
    lowVersion: 0,
    hidden: 0,
    probed: 0,
    eligible: 0,
  };
  const eligible = [];
  for (const candidate of candidates) {
    const pre = prefilterCandidate(candidate, { officialRepos, blacklist, stats });
    if (!pre) {
      continue;
    }
    if (maxCandidates !== null && stats.probed >= maxCandidates) {
      break;
    }
    stats.probed += 1;
    const result = await fetchCommunityModMetadata(rawClient, {
      repo: candidate.repo,
      ref: candidate.defaultBranch,
    });
    const checked = checkEligibility(candidate, result.found ? result.metadata : null, blacklist, stats);
    if (!checked) {
      continue;
    }
    let iconUrl = null;
    try {
      const icon = await detectCommunityIcon(rawClient, {
        repo: candidate.repo,
        ref: candidate.defaultBranch,
      });
      iconUrl = icon.iconUrl;
    } catch (error) {
      log(`[警告] [community] ${candidate.repo} 图标探测失败：${error.message}`);
    }
    eligible.push({ candidate, metadata: result.metadata, minGameVersion: checked.minGameVersion, iconUrl });
    stats.eligible += 1;
  }
  return { eligible, stats };
}

// 校验社区仓库名（来自 search 的 full_name）
export function normalizeCommunityCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    try {
      assertRepo(candidate.repo);
    } catch {
      continue;
    }
    const key = candidate.repo.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
