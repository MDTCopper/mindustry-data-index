// Git tag 列表抓取：releases API 只返回建了 Release 的 tag，这里补全全部 git tag。
// 每条 tag 同时保留 commit sha（tag 被删后可用 archive/<sha>.zip 兜底下载）。

import { assertRepo } from './paths.js';

export const TAGS_PER_PAGE = 100;
const MAX_TAG_PAGES = 100;

export function apiTagsUrl(repo, page = 1) {
  return `https://api.github.com/repos/${assertRepo(repo)}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`;
}

// API 返回 [{ name, commit: { sha } }]；保留 tag 名与 commit sha，按 name 去重（保持 API 顺序）
export function normalizeTagEntries(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const entries = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item?.name !== 'string' || item.name.length === 0) {
      continue;
    }
    if (seen.has(item.name)) {
      continue;
    }
    seen.add(item.name);
    entries.push({
      name: item.name,
      commitSha: typeof item.commit?.sha === 'string' ? item.commit.sha : null,
    });
  }
  return entries;
}

// 兼容旧调用：只要 tag 名数组
export function normalizeTags(items) {
  return normalizeTagEntries(items).map((entry) => entry.name);
}

export async function fetchTagEntriesPage(client, repo, page) {
  const response = await client.get(apiTagsUrl(repo, page));
  return normalizeTagEntries(JSON.parse(response.text ?? '[]'));
}

export async function fetchTagsPage(client, repo, page) {
  return (await fetchTagEntriesPage(client, repo, page)).map((entry) => entry.name);
}

// 按计划抓指定 tag 页（页 1 每 2 小时、页 2 每周、页 3+ 每月全量）
export async function fetchTagPages(client, repo, pages = []) {
  const results = [];
  for (const page of pages) {
    const entries = await fetchTagEntriesPage(client, repo, page);
    results.push({
      page,
      entries,
      names: entries.map((entry) => entry.name),
      // 不足 100 条说明后面没有更多 tag 页
      complete: entries.length < TAGS_PER_PAGE,
    });
  }
  return results;
}

// 分页取全部 tag（含 commit sha）；最后一页不足 100 条即结束
export async function fetchAllTagEntries(client, repo, { maxPages = MAX_TAG_PAGES } = {}) {
  const entries = [];
  let pageCount = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const pageEntries = await fetchTagEntriesPage(client, repo, page);
    pageCount = page;
    entries.push(...pageEntries);
    if (pageEntries.length < TAGS_PER_PAGE) {
      break;
    }
  }
  return { entries, pageCount };
}

// 兼容旧调用：只要 tag 名与页数
export async function fetchAllTags(client, repo, { maxPages = MAX_TAG_PAGES } = {}) {
  const { entries, pageCount } = await fetchAllTagEntries(client, repo, { maxPages });
  return { tags: entries.map((entry) => entry.name), pageCount };
}
