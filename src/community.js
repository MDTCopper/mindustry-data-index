// 社区模组：收录标准过滤、完整元数据、图标探测、index 条目构造

import { rawFileUrlVariants } from './releases.js';
import { fetchCommunityModMetadata } from './mod-meta.js';
import { assertRepo } from './paths.js';
import { isBlacklisted } from './blacklist.js';
import { latestCompatibleTag } from './compat.js';
import { plainFields } from './plain.js';
import { computeModStats } from './stats.js';
import { releasesFromVersions, summarizeVersions } from './model-v3.js';

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
  {
    relPath,
    oldEntry = null,
    stats = null,
    gameVersions = [],
    modType = null,
    repoStats = null,
  } = {},
) {
  const hasFile = Array.isArray(file?.releases) || Array.isArray(file?.versions);
  const releases = Array.isArray(file?.releases)
    ? file.releases
    : Array.isArray(file?.versions)
      ? releasesFromVersions(file)
      : [];
  const meta = file?.meta && typeof file.meta === 'object' ? file.meta : null;
  const effectiveModType = modType ?? file?.modType ?? 'json';
  const versions = Array.isArray(file?.versions) ? file.versions : [];
  const summary = summarizeVersions(versions);
  const plain = plainFields({
    name: meta?.name ?? mod.name,
    author: meta?.author ?? mod.author,
    description: meta?.description ?? mod.description,
  });
  const latestVersion = versions.find((item) => item.removed !== true) ?? versions[0] ?? null;
  const latestRelease = releases.find((entry) => entry.removed !== true) ?? releases[0] ?? null;
  const computed = stats ?? computeModStats(releases, effectiveModType === 'java');
  const releaseCount = hasFile ? summary.releaseCount : (oldEntry?.releaseCount ?? 0);
  const tagCount = hasFile ? summary.tagCount : (oldEntry?.tagCount ?? releaseCount);
  const releaseUpdatedAt =
    summary.releaseUpdatedAt ??
    latestRelease?.publishedAt ??
    oldEntry?.releaseUpdatedAt ??
    null;
  const result = {
    repo: mod.repo,
    source: COMMUNITY_SOURCE,
    internalName: null,
    name: meta?.name ?? mod.name,
    namePlain: plain.namePlain,
    author: meta?.author ?? mod.author,
    authorPlain: plain.authorPlain,
    description: meta?.description ?? mod.description ?? '',
    descriptionPlain: plain.descriptionPlain,
    version: latestVersion?.modVersion ?? meta?.version ?? mod.version ?? null,
    minGameVersion:
      latestVersion?.minGameVersion ?? meta?.minGameVersion ?? mod.minGameVersion ?? null,
    modType: effectiveModType,
    gameVersionRanges: hasFile ? summary.gameVersionRanges : (oldEntry?.gameVersionRanges ?? []),
    stars: Number(repoStats?.stars ?? mod.stars) || 0,
    hasIcon: mod.hasIcon,
    iconUrl: mod.iconUrl ?? null,
    iconHash: null,
    releasesPath: hasFile
      ? `${COMMUNITY_DIR}/${relPath}`
      : (oldEntry?.releasesPath ?? (file ? `${COMMUNITY_DIR}/${relPath}` : null)),
    releaseCount,
    ...(effectiveModType === 'java' ? {} : { tagCount }),
    releaseUpdatedAt,
    commitUpdatedAt: repoStats?.pushedAt ?? oldEntry?.commitUpdatedAt ?? null,
    totalDownloads: computed.totalDownloads,
    allAssetsDownloads: computed.allAssetsDownloads,
    releaseDataUpdatedAt: file?.generatedAt ?? oldEntry?.releaseDataUpdatedAt ?? null,
    ...(mod.defaultBranch ? { defaultBranch: mod.defaultBranch } : {}),
  };
  if (meta?.copper === true) {
    result.copper = true;
  }
  return result;
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
