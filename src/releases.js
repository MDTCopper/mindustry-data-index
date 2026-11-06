// releases：拉全部分页、规范化单条 release、挑下载链接、与旧数据合并

import { assertRepo } from './paths.js';

const PER_PAGE = 100;
const MAX_PAGES = 100;

export function apiReleasesUrl(repo, page, perPage = PER_PAGE) {
  return `https://api.github.com/repos/${assertRepo(repo)}/releases?per_page=${perPage}&page=${page}`;
}

// 源码归档：tag 里的 `/`、空格等全部转义，否则会被当成路径分隔符
export function sourceArchiveUrl(repo, tag) {
  return `https://github.com/${assertRepo(repo)}/archive/refs/tags/${encodeURIComponent(tag)}.zip`;
}

// raw 文件地址：tag 要转义但保留 `/`（tag 里可能带斜杠）
export function rawFileUrl(repo, tag, filePath) {
  const ref = encodeURIComponent(tag).replace(/%2F/gi, '/');
  return `https://raw.githubusercontent.com/${assertRepo(repo)}/${ref}/${filePath}`;
}

// 启动器口径：hasJava 取 jar、否则取 zip，多个按体积取最大；都没有就回落源码归档
export function pickDownloadUrl(assets, { hasJava, archiveUrl }) {
  const extension = hasJava ? '.jar' : '.zip';
  const candidates = assets
    .filter((asset) => asset.name.toLowerCase().endsWith(extension))
    .sort((a, b) => b.size - a.size);
  return candidates.length > 0 ? candidates[0].downloadUrl : archiveUrl;
}

export function normalizeRelease(raw, { repo, hasJava }) {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  if (raw.draft === true) {
    return null;
  }
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
  if (!tag) {
    return null;
  }

  const assets = (Array.isArray(raw.assets) ? raw.assets : [])
    .filter((asset) => asset && typeof asset === 'object')
    .map((asset) => ({
      name: asset.name ?? '',
      size: typeof asset.size === 'number' ? asset.size : 0,
      downloadCount:
        typeof asset.download_count === 'number' ? asset.download_count : 0,
      downloadUrl: asset.browser_download_url ?? '',
    }));
  const archiveUrl = sourceArchiveUrl(repo, tag);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';

  return {
    tag,
    // 官方数据里有 name 带尾随空格的 release，空名回退 tag
    name: name || tag,
    prerelease: raw.prerelease === true,
    publishedAt: raw.published_at ?? null,
    htmlUrl: raw.html_url ?? null,
    modVersion: null,
    minGameVersion: null,
    metadataPath: null,
    metadataStatus: null,
    downloadUrl: pickDownloadUrl(assets, { hasJava, archiveUrl }),
    sourceArchiveUrl: archiveUrl,
    assets,
  };
}

export function normalizeReleases(raws, { repo, hasJava }) {
  if (!Array.isArray(raws)) {
    throw new Error(`${repo} 的 release 数据不是数组`);
  }
  const releases = [];
  for (const raw of raws) {
    const release = normalizeRelease(raw, { repo, hasJava });
    if (release) {
      releases.push(release);
    }
  }
  return releases;
}

// Link 头里有没有 rel="next"；没有 Link 头时由「不足一页」判断
export function hasNextPage(linkHeader) {
  if (!linkHeader) {
    return null;
  }
  return /rel="next"/.test(linkHeader);
}

// 拉全部 release：第一页带旧 ETag，304 直接整份复用
export async function fetchReleases(client, repo, { etag = null } = {}) {
  const items = [];
  let latestEtag = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await client.get(apiReleasesUrl(repo, page), {
      etag: page === 1 ? etag : null,
    });
    if (response.status === 304) {
      if (page !== 1) {
        throw new Error(`${repo} 第 ${page} 页意外返回 304`);
      }
      return { notModified: true };
    }
    if (response.status !== 200) {
      const error = new Error(
        `${repo} 的 release 接口返回 HTTP ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    let pageItems;
    try {
      pageItems = JSON.parse(response.text);
    } catch (error) {
      throw new Error(`${repo} 第 ${page} 页返回的 JSON 无法解析：${error.message}`);
    }
    if (!Array.isArray(pageItems)) {
      throw new Error(`${repo} 第 ${page} 页返回的不是数组`);
    }
    if (page === 1) {
      latestEtag = response.etag ?? null;
    }
    items.push(...pageItems);

    const next = hasNextPage(response.headers?.get?.('link'));
    if (next === false) {
      break;
    }
    if (pageItems.length < PER_PAGE) {
      break;
    }
    if (page === MAX_PAGES) {
      console.warn(
        `[警告] ${repo} 的 release 超过 ${MAX_PAGES * PER_PAGE} 条，已到分页上限，可能不完整`,
      );
    }
  }
  return { notModified: false, raws: items, etag: latestEtag };
}

// 只有新 tag 或旧元数据没抓成功的 tag 才请求 mod.hjson；旧条目元数据原样复用
export async function mergeReleaseMetadata({
  previousReleases = [],
  releases,
  fetchMetadata,
}) {
  const previousByTag = new Map();
  for (const old of previousReleases) {
    if (old && typeof old.tag === 'string') {
      previousByTag.set(old.tag, old);
    }
  }

  let metaFetched = 0;
  let metaReused = 0;
  const merged = [];
  for (const release of releases) {
    const old = previousByTag.get(release.tag);
    if (old && old.metadataStatus === 'ok') {
      release.modVersion = old.modVersion ?? null;
      release.minGameVersion = old.minGameVersion ?? null;
      release.metadataPath = old.metadataPath ?? null;
      release.metadataStatus = 'ok';
      metaReused += 1;
      merged.push(release);
      continue;
    }

    let metadata;
    try {
      metadata = await fetchMetadata(release.tag);
    } catch {
      // 网络等失败也记为 unparsed，下次更新会重试（见 docs/schema.md）
      metadata = {
        modVersion: null,
        minGameVersion: null,
        metadataPath: null,
        metadataStatus: 'unparsed',
      };
    }
    release.modVersion = metadata.modVersion ?? null;
    release.minGameVersion = metadata.minGameVersion ?? null;
    release.metadataPath = metadata.metadataPath ?? null;
    release.metadataStatus = metadata.metadataStatus;
    metaFetched += 1;
    merged.push(release);
  }

  return { releases: merged, metaFetched, metaReused };
}

export function buildReleasesFile({ repo, releases, etag, fetchedAt }) {
  return {
    formatVersion: 1,
    repo,
    generatedAt: fetchedAt,
    source: {
      releasesEtag: etag ?? null,
      releasesFetchedAt: fetchedAt,
    },
    releases,
  };
}
