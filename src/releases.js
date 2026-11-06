// releases：拉全部分页、规范化单条 release、挑下载链接、与旧数据合并

import { assertRepo } from './paths.js';

export const PER_PAGE = 100;
const MAX_PAGES = 100;

export function apiReleasesUrl(repo, page, perPage = PER_PAGE) {
  return `https://api.github.com/repos/${assertRepo(repo)}/releases?per_page=${perPage}&page=${page}`;
}

// 源码归档：tag 里的 `/`、空格等全部转义，否则会被当成路径分隔符
export function sourceArchiveUrl(repo, tag) {
  return `https://github.com/${assertRepo(repo)}/archive/refs/tags/${encodeURIComponent(tag)}.zip`;
}

// raw 文件地址：优先整个 tag 走 encodeURIComponent（CJK、+、/ 都实测可取）；
// tag 含特殊字符时再准备「原样 tag」与 refs/tags 两种回退，见 rawFileUrlVariants
export function rawFileUrl(repo, tag, filePath) {
  const ref = encodeURIComponent(tag);
  return `https://raw.githubusercontent.com/${assertRepo(repo)}/${ref}/${filePath}`;
}

export function rawFileUrlVariants(repo, tag, filePath) {
  const base = `https://raw.githubusercontent.com/${assertRepo(repo)}`;
  const encoded = encodeURIComponent(tag);
  const urls = [`${base}/${encoded}/${filePath}`];
  if (encoded !== tag) {
    urls.push(`${base}/${tag}/${filePath}`);
  }
  // 特殊 tag 才需要 refs/tags 兜底，普通 tag 不额外增加请求
  if (/[^\x20-\x7e]|[/+#?]/.test(tag)) {
    urls.push(`${base}/refs/tags/${encoded}/${filePath}`);
  }
  return [...new Set(urls)];
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
    hasRelease: true,
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

// 旧文件没有 hasRelease 字段 → 视作 release 条目
export function isReleaseEntry(entry) {
  return Boolean(entry) && entry.hasRelease !== false;
}

// 无 GitHub Release 的 git tag：不能判定 prerelease/发布时间，下载地址用源码归档
export function buildTagOnlyRelease({ repo, tag }) {
  const archiveUrl = sourceArchiveUrl(repo, tag);
  return {
    tag,
    name: tag,
    hasRelease: false,
    prerelease: null,
    publishedAt: null,
    htmlUrl: `https://github.com/${assertRepo(repo)}/tree/${encodeURIComponent(tag)}`,
    modVersion: null,
    minGameVersion: null,
    metadataPath: null,
    metadataStatus: null,
    downloadUrl: archiveUrl,
    sourceArchiveUrl: archiveUrl,
    assets: [],
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

// tag 名自然比较（v1.10 > v1.9），用于 tag-only 条目排序
function naturalCompare(left, right) {
  const chunks = (value) => String(value).match(/\d+|\D+/g) ?? [];
  const a = chunks(left);
  const b = chunks(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const chunkA = a[index];
    const chunkB = b[index];
    const digitsA = /^\d+$/.test(chunkA);
    const digitsB = /^\d+$/.test(chunkB);
    if (digitsA && digitsB) {
      const diff = Number(chunkA) - Number(chunkB);
      if (diff !== 0) {
        return diff;
      }
    } else if (chunkA !== chunkB) {
      return chunkA < chunkB ? -1 : 1;
    }
  }
  return a.length - b.length;
}

// 排序：有 Release 的条目在前（publishedAt 降序、同时间 tag 升序），
// tag-only 条目在后（tag 名称自然降序）
export function sortReleases(releases) {
  return [...releases].sort((a, b) => {
    const releaseA = isReleaseEntry(a);
    const releaseB = isReleaseEntry(b);
    if (releaseA !== releaseB) {
      return releaseA ? -1 : 1;
    }
    if (!releaseA) {
      return -naturalCompare(a?.tag ?? '', b?.tag ?? '');
    }
    const timeA = a?.publishedAt ? Date.parse(a.publishedAt) : Number.NaN;
    const timeB = b?.publishedAt ? Date.parse(b.publishedAt) : Number.NaN;
    const valueA = Number.isNaN(timeA) ? -Infinity : timeA;
    const valueB = Number.isNaN(timeB) ? -Infinity : timeB;
    if (valueA !== valueB) {
      return valueB - valueA;
    }
    const tagA = String(a?.tag ?? '');
    const tagB = String(b?.tag ?? '');
    return tagA < tagB ? -1 : tagA > tagB ? 1 : 0;
  });
}

// 按 tag 合并：API 返回的 release 覆盖缓存同 tag 条目（下载量必须更新），
// 缓存里不在这几页的旧条目保留；保留条目的元数据不会被重抓。
export function mergeReleasesByTag(previousReleases = [], fetchedReleases = []) {
  const byTag = new Map();
  for (const release of previousReleases) {
    if (release && typeof release.tag === 'string') {
      byTag.set(release.tag, release);
    }
  }
  for (const release of fetchedReleases) {
    if (release && typeof release.tag === 'string') {
      byTag.set(release.tag, release);
    }
  }
  return sortReleases([...byTag.values()]);
}

async function fetchReleasesPage(client, repo, page, { etag = null } = {}) {
  const response = await client.get(apiReleasesUrl(repo, page), { etag });
  if (response.status === 304) {
    return { notModified: true, items: [], etag: response.etag ?? etag };
  }
  if (response.status !== 200) {
    const error = new Error(`${repo} 的 release 接口第 ${page} 页返回 HTTP ${response.status}`);
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
  return {
    notModified: false,
    items: pageItems,
    etag: response.etag ?? null,
  };
}

// 全量抓取（首次运行 / --no-cache）：从第 1 页抓到不足一页为止
export async function fetchAllReleasePages(client, repo, { maxPages = MAX_PAGES } = {}) {
  const pages = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchReleasesPage(client, repo, page);
    pages.push({ page, ...result });
    if (result.items.length < PER_PAGE) {
      break;
    }
    if (page === maxPages) {
      console.warn(
        `[警告] ${repo} 的 release 超过 ${MAX_PAGES * PER_PAGE} 条，已到分页上限，可能不完整`,
      );
    }
  }
  return pages;
}

// 按计划抓指定页（页 → 旧 ETag）；到期判断在调用方做
export async function fetchReleasePages(client, repo, { pages = [], etags = {} } = {}) {
  const results = [];
  for (const page of pages) {
    const result = await fetchReleasesPage(client, repo, page, {
      etag: etags[page] ?? null,
    });
    results.push({ page, ...result });
  }
  return results;
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

// per-mod 文件只存数据：ETag/调度时间放到 state/refresh.json，避免每日仅因 ETag 变化重写 991 个文件
export function buildReleasesFile({ repo, releases, generatedAt }) {
  return {
    formatVersion: 1,
    repo,
    generatedAt,
    releases,
  };
}
