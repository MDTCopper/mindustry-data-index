// Mindustry 可用版本列表：官方 Mindustry 正式版 + MindustryBuilds 最新 BE，
// 字段形状与启动器 remote/mindustry_versions.json 快照兼容

import { API_HOST } from './github.js';

export const VERSIONS_API =
  'https://api.github.com/repos/Anuken/Mindustry/releases';
export const BUILDS_API =
  'https://api.github.com/repos/Anuken/MindustryBuilds/releases';
export const VERSIONS_REL_PATH = 'mindustry/versions.json';

const PER_PAGE = 100;
const MAX_PAGES = 30;

function assertApiUrl(url) {
  if (new URL(url).hostname !== API_HOST) {
    throw new Error(`版本列表只能来自 GitHub API：${url}`);
  }
  return url;
}

export function versionsApiUrl(page, perPage = PER_PAGE) {
  return `${assertApiUrl(VERSIONS_API)}?per_page=${perPage}&page=${page}`;
}

export function latestBeApiUrl() {
  // 多取几条：最新 build 可能是失败产物（没有桌面 jar），跳过它用下一条可用 build
  return `${assertApiUrl(BUILDS_API)}?per_page=5`;
}

export function isUsableBeRelease(raw) {
  const assets = Array.isArray(raw?.assets) ? raw.assets : [];
  return assets.some(
    (asset) =>
      typeof asset?.name === 'string' &&
      asset.name.toLowerCase().endsWith('.jar') &&
      Number(asset.size) > 0,
  );
}

function assetSha256(asset) {
  const digest = asset?.digest;
  if (typeof digest === 'string') {
    const match = /^sha256:([a-f0-9]{64})$/i.exec(digest.trim());
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function trimAssets(assets) {
  return (Array.isArray(assets) ? assets : [])
    .filter((asset) => asset && typeof asset === 'object')
    .map((asset) => ({
      name: asset.name ?? '',
      size: typeof asset.size === 'number' ? asset.size : 0,
      download_count:
        typeof asset.download_count === 'number' ? asset.download_count : 0,
      browser_download_url: asset.browser_download_url ?? '',
      sha256: assetSha256(asset),
    }));
}

// 与启动器 generate_mindustry_versions.dart 的精简口径一致：
// body 一律空串；reactions 只留 total_count 且必须存在（null 表示 BE）
export function trimRelease(raw) {
  const reactions = raw?.reactions;
  return {
    name: raw?.name ?? null,
    tag_name: raw?.tag_name ?? null,
    published_at: raw?.published_at ?? null,
    body: '',
    reactions: {
      total_count:
        reactions && typeof reactions.total_count === 'number'
          ? reactions.total_count
          : 0,
    },
    assets: trimAssets(raw?.assets),
  };
}

// BE 版：没有 reactions 键（启动器靠它区分 BE）
export function trimLatestBe(raw) {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  return {
    name: raw.name ?? null,
    tag_name: raw.tag_name ?? null,
    published_at: raw.published_at ?? null,
    body: '',
    assets: trimAssets(raw.assets),
  };
}

export function buildVersionsFile({ releases, latestBe, etags, updateTime }) {
  return {
    update_time: updateTime,
    source: VERSIONS_API,
    releases,
    latest_be: latestBe,
    // 增量缓存：只给下一次请求带 If-None-Match 用，启动器忽略
    etags: {
      releases: etags?.releases ?? null,
      latestBe: etags?.latestBe ?? null,
    },
  };
}

// 数据主体是否变化：update_time / etags 变化不算，避免每次运行都重写
export function versionsBodyChanged(previous, next) {
  if (!previous) {
    return true;
  }
  if (previous.source !== next.source) {
    return true;
  }
  if (JSON.stringify(previous.releases) !== JSON.stringify(next.releases)) {
    return true;
  }
  return JSON.stringify(previous.latest_be) !== JSON.stringify(next.latest_be);
}

// 拉单页正式版；304 由调用方判断
async function fetchVersionsPage(client, page, { etag = null } = {}) {
  const response = await client.get(versionsApiUrl(page), { etag });
  if (response.status === 304) {
    if (page !== 1) {
      throw new Error(`Mindustry 版本列表第 ${page} 页意外返回 304`);
    }
    return { notModified: true };
  }
  if (response.status !== 200) {
    const error = new Error(
      `Mindustry 版本列表第 ${page} 页返回 HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  let pageItems;
  try {
    pageItems = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`Mindustry 版本列表第 ${page} 页 JSON 无法解析：${error.message}`);
  }
  if (!Array.isArray(pageItems)) {
    throw new Error(`Mindustry 版本列表第 ${page} 页不是数组`);
  }
  return {
    notModified: false,
    raws: pageItems,
    etag: response.etag ?? null,
  };
}

// 拉全部正式版：第一页带 ETag，304 直接复用，不再发后续页
export async function fetchAllVersions(client, { etag = null, maxPages = null } = {}) {
  const pageLimit = maxPages ?? MAX_PAGES;
  const firstPage = await fetchVersionsPage(client, 1, { etag });
  if (firstPage.notModified) {
    return { notModified: true };
  }
  const raws = [...firstPage.raws];
  let fetchedPages = 1;

  if (firstPage.raws.length >= PER_PAGE) {
    for (let page = 2; page <= pageLimit; page += 1) {
      const current = await fetchVersionsPage(client, page);
      raws.push(...current.raws);
      fetchedPages += 1;
      if (current.raws.length < PER_PAGE) {
        break;
      }
      if (maxPages !== null && page === pageLimit) {
        console.warn(
          `[警告] --versions-pages=${pageLimit} 只抓了前 ${pageLimit * PER_PAGE} 条版本，不是全量`,
        );
      }
    }
  }
  return { notModified: false, raws, etag: firstPage.etag, fetchedPages };
}

// 轻量增量：常规每轮只发 1 次 API（第一页）。
// 第一页里全是已知 release 时用「第一页 + 本地其余」拼回完整列表；
// 出现未知 release id（或本地还没有列表）时才翻后面几页重建。
export async function fetchVersionsIncremental(
  client,
  { etag = null, localReleases = null, maxPages = null } = {},
) {
  const local =
    Array.isArray(localReleases) && localReleases.length > 0
      ? localReleases
      : null;
  const firstPage = await fetchVersionsPage(client, 1, { etag });
  if (firstPage.notModified) {
    return { notModified: true };
  }

  const firstBatch = firstPage.raws.map(trimRelease);
  if (local) {
    const localTags = new Set(local.map((item) => item.tag_name));
    const hasUnknown = firstBatch.some((item) => !localTags.has(item.tag_name));
    if (!hasUnknown) {
      const firstTags = new Set(firstBatch.map((item) => item.tag_name));
      return {
        notModified: false,
        rebuilt: false,
        fetchedPages: 1,
        etag: firstPage.etag,
        releases: [...firstBatch, ...local.filter((item) => !firstTags.has(item.tag_name))],
      };
    }
  }

  const pageLimit = maxPages ?? MAX_PAGES;
  const raws = [...firstPage.raws];
  let fetchedPages = 1;
  if (firstPage.raws.length >= PER_PAGE) {
    for (let page = 2; page <= pageLimit; page += 1) {
      const current = await fetchVersionsPage(client, page);
      raws.push(...current.raws);
      fetchedPages += 1;
      if (current.raws.length < PER_PAGE) {
        break;
      }
      if (maxPages !== null && page === pageLimit) {
        console.warn(
          `[警告] --versions-pages=${pageLimit} 只抓了前 ${pageLimit * PER_PAGE} 条版本，不是全量`,
        );
      }
    }
  }
  return {
    notModified: false,
    rebuilt: true,
    fetchedPages,
    etag: firstPage.etag,
    releases: raws.map(trimRelease),
  };
}

// 最新一条 BE release（per_page=1 只取一条）
export async function fetchLatestBe(client, { etag = null } = {}) {
  const response = await client.get(latestBeApiUrl(), { etag });
  if (response.status === 304) {
    return { notModified: true };
  }
  if (response.status !== 200) {
    const error = new Error(
      `MindustryBuilds 最新 release 返回 HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  let items;
  try {
    items = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`MindustryBuilds 最新 release JSON 无法解析：${error.message}`);
  }
  if (!Array.isArray(items)) {
    throw new Error('MindustryBuilds 最新 release 不是数组');
  }
  const usable = items.find(isUsableBeRelease) ?? null;
  return {
    notModified: false,
    release: usable ? trimLatestBe(usable) : null,
    etag: response.etag ?? null,
  };
}
