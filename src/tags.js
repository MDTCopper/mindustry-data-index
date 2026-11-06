// Git tag 列表抓取：releases API 只返回建了 Release 的 tag，这里补全全部 git tag

import { assertRepo } from './paths.js';

export const TAGS_PER_PAGE = 100;
const MAX_TAG_PAGES = 100;

export function apiTagsUrl(repo, page = 1) {
  return `https://api.github.com/repos/${assertRepo(repo)}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`;
}

// API 返回 [{ name, commit, ... }]；只保留 tag 名并去重（保持 API 顺序）
export function normalizeTags(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const names = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item?.name !== 'string' || item.name.length === 0) {
      continue;
    }
    if (seen.has(item.name)) {
      continue;
    }
    seen.add(item.name);
    names.push(item.name);
  }
  return names;
}

export async function fetchTagsPage(client, repo, page) {
  const response = await client.get(apiTagsUrl(repo, page));
  return normalizeTags(JSON.parse(response.text ?? '[]'));
}

// 按计划抓指定 tag 页（页 1 每 2 小时、页 2 每周、页 3+ 每月全量）
export async function fetchTagPages(client, repo, pages = []) {
  const results = [];
  for (const page of pages) {
    const names = await fetchTagsPage(client, repo, page);
    results.push({
      page,
      names,
      // 不足 100 条说明后面没有更多 tag 页
      complete: names.length < TAGS_PER_PAGE,
    });
  }
  return results;
}

// 分页取全部 tag；最后一页不足 100 条即结束
export async function fetchAllTags(client, repo, { maxPages = MAX_TAG_PAGES } = {}) {
  const tags = [];
  let pageCount = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const names = await fetchTagsPage(client, repo, page);
    pageCount = page;
    tags.push(...names);
    if (names.length < TAGS_PER_PAGE) {
      break;
    }
  }
  return { tags, pageCount };
}
