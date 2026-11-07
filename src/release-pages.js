// 版本列表分页：每页 200 个版本、最多 5 页（1000 个），只保留最新 1000 个。
// 单页（<=200）沿用 releases/<owner>/<repo>.json；多页用 releases/<owner>/<repo>/page-N.json。

import { mergeGameVersionRanges } from './model-v3.js';

export const VERSION_PAGE_SIZE = 200;
export const VERSION_MAX_PAGES = 5;
export const VERSION_HARD_CAP = VERSION_PAGE_SIZE * VERSION_MAX_PAGES;

// 只保留最新 1000 个；versions 需已按最新在前排序
export function capVersions(versions) {
  return (Array.isArray(versions) ? versions : []).slice(0, VERSION_HARD_CAP);
}

export function pageCountFor(total) {
  return Math.max(1, Math.ceil(Math.min(total, VERSION_HARD_CAP) / VERSION_PAGE_SIZE));
}

// 每页的适配版本范围 = 该页 versions 区间并集
function rangesFor(chunk) {
  return mergeGameVersionRanges(
    chunk.flatMap((version) => (Array.isArray(version?.gameVersionRanges) ? version.gameVersionRanges : [])),
  );
}

// 拆页，返回 [{page,count,gameVersionRanges,versions}]
export function splitVersionsIntoPages(versions) {
  const capped = capVersions(versions);
  const pages = [];
  for (let index = 0; index < capped.length; index += VERSION_PAGE_SIZE) {
    const chunk = capped.slice(index, index + VERSION_PAGE_SIZE);
    pages.push({
      page: pages.length + 1,
      count: chunk.length,
      gameVersionRanges: rangesFor(chunk),
      versions: chunk,
    });
  }
  if (pages.length === 0) {
    pages.push({ page: 1, count: 0, gameVersionRanges: [], versions: [] });
  }
  return pages;
}

export function pageFileBody({ file, page }) {
  return {
    formatVersion: file.formatVersion,
    repo: file.repo,
    generatedAt: file.generatedAt,
    modType: file.modType,
    ...(file.meta ? { meta: file.meta } : {}),
    page: page.page,
    count: page.count,
    gameVersionRanges: page.gameVersionRanges,
    versions: page.versions,
  };
}

export function pagesMetadata(pages, pathForPage) {
  return pages.map((page) => ({
    page: page.page,
    count: page.count,
    gameVersionRanges: page.gameVersionRanges,
    path: pathForPage(page.page),
  }));
}
