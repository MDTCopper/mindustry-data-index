// 社区模组发现：GitHub topic 搜索（与 Anuken/MindustryMods 相同查询），
// 单查询最多 1000 条，需要按 pushed 时间窗分区取全并去重。

export const TOPIC_QUERY_BASE = 'mindustry-mod in:topics archived:false template:false';
export const SEARCH_PER_PAGE = 100;
export const SEARCH_MAX_RESULTS = 1000;
export const SEARCH_SINCE = '2022-05-01';

export function searchApiUrl({ query, page = 1, sort = 'updated', order = 'desc', perPage = SEARCH_PER_PAGE }) {
  return (
    'https://api.github.com/search/repositories' +
    `?q=${encodeURIComponent(query)}` +
    `&sort=${sort}&order=${order}&per_page=${perPage}&page=${page}`
  );
}

export function topicQueryForWindow(since, until, base = TOPIC_QUERY_BASE) {
  return `${base} pushed:${since}..${until}`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

// 2022-05 至今按半年切窗（每窗通常 <1000；运行时若仍 >1000 会继续二分）
export function buildSearchWindows({ since = SEARCH_SINCE, now = new Date(), months = 6 } = {}) {
  const start = new Date(`${since}T00:00:00Z`);
  const windows = [];
  let cursor = start;
  while (cursor < now) {
    let end = addMonths(cursor, months);
    if (end > now) {
      end = now;
    }
    windows.push({
      since: isoDate(cursor),
      until: isoDate(end),
      query: topicQueryForWindow(isoDate(cursor), isoDate(end)),
    });
    if (end.getTime() >= now.getTime()) {
      break;
    }
    cursor = end;
  }
  return windows;
}

export function normalizeSearchItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const repos = [];
  for (const item of items) {
    if (!item || typeof item.full_name !== 'string' || !item.full_name.includes('/')) {
      continue;
    }
    repos.push({
      repo: item.full_name,
      archived: item.archived === true,
      template: item.is_template === true,
      fork: item.fork === true,
      pushedAt: item.pushed_at ?? null,
      updatedAt: item.updated_at ?? null,
      stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
      description: typeof item.description === 'string' ? item.description : '',
      defaultBranch: typeof item.default_branch === 'string' ? item.default_branch : 'main',
    });
  }
  return repos;
}

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchSearchPage(apiClient, { query, page = 1, throttleMs = 0 }) {
  await sleep(throttleMs);
  const response = await apiClient.get(searchApiUrl({ query, page }));
  if (response.status !== 200) {
    const error = new Error(`搜索接口返回 HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`搜索接口返回的 JSON 无法解析：${error.message}`);
  }
  return {
    totalCount: Number.isInteger(data.total_count) ? data.total_count : 0,
    incomplete: data.incomplete_results === true,
    items: normalizeSearchItems(data.items),
  };
}

function splitWindow(window) {
  const start = new Date(`${window.since}T00:00:00Z`).getTime();
  const end = new Date(`${window.until}T00:00:00Z`).getTime();
  if (end - start <= 24 * 60 * 60 * 1000) {
    return null;
  }
  const mid = new Date(start + (end - start) / 2);
  const midDate = isoDate(mid);
  const nextStart = new Date(mid.getTime());
  const nextSince = isoDate(nextStart);
  return [
    {
      since: window.since,
      until: midDate,
      query: topicQueryForWindow(window.since, midDate),
    },
    {
      since: nextSince,
      until: window.until,
      query: topicQueryForWindow(nextSince, window.until),
    },
  ];
}

// 分区取全：窗口 total_count > 1000 时二分时间窗；每窗最多 10 页
export async function discoverCommunityRepos(
  apiClient,
  {
    windows = buildSearchWindows(),
    perPage = SEARCH_PER_PAGE,
    maxPages = Math.ceil(SEARCH_MAX_RESULTS / SEARCH_PER_PAGE),
    maxWindows = null,
    maxCandidates = null,
    throttleMs = 0,
    log = () => {},
  } = {},
) {
  const byRepo = new Map();
  const stats = { requests: 0, windows: 0, duplicates: 0, incomplete: false };
  let searchWindows = windows;
  if (maxWindows !== null) {
    searchWindows = searchWindows.slice(0, Math.max(0, maxWindows));
  }
  const queue = [...searchWindows];
  while (queue.length > 0) {
    const window = queue.shift();
    stats.windows += 1;
    const first = await fetchSearchPage(apiClient, {
      query: window.query,
      page: 1,
      throttleMs,
    });
    stats.requests += 1;
    if (first.incomplete) {
      stats.incomplete = true;
    }
    let pages;
    if (first.totalCount > SEARCH_MAX_RESULTS) {
      const halves = splitWindow(window);
      if (halves) {
        log(
          `[community] 时间窗 ${window.since}..${window.until} 有 ${first.totalCount} 条，继续二分`,
        );
        queue.unshift(...halves);
        continue;
      }
      log(`[警告] [community] 时间窗 ${window.since}..${window.until} 超过 1000 条且无法再拆`);
    }
    pages = Math.min(Math.ceil(first.totalCount / perPage), maxPages);
    for (const repo of first.items) {
      addRepo(byRepo, repo, stats);
    }
    for (let page = 2; page <= pages; page += 1) {
      if (maxCandidates !== null && byRepo.size >= maxCandidates) {
        break;
      }
      const result = await fetchSearchPage(apiClient, {
        query: window.query,
        page,
        throttleMs,
      });
      stats.requests += 1;
      for (const repo of result.items) {
        addRepo(byRepo, repo, stats);
      }
    }
    if (maxCandidates !== null && byRepo.size >= maxCandidates) {
      break;
    }
  }
  let candidates = [...byRepo.values()];
  if (maxCandidates !== null) {
    candidates = candidates.slice(0, maxCandidates);
  }
  return { candidates, stats };
}

function addRepo(byRepo, repo, stats) {
  const key = repo.repo.toLowerCase();
  if (byRepo.has(key)) {
    stats.duplicates += 1;
    return;
  }
  byRepo.set(key, repo);
}
