// 分页调度缓存（state/refresh.json）：只存 ETag 与深层页最近抓取时间，不存 release 数据。
// 这样「下载量变了」只改 per-mod 的 releases 文件，每日的调度时间戳只改这一个小文件。

export const REFRESH_STATE_REL_PATH = 'state/refresh.json';
const DAY_MS = 24 * 60 * 60 * 1000;

// 按页分档：第 1 页每天、第 2 页每 7 天、第 3 页每 30 天、第 4 页起每 90 天
export const REFRESH_TIERS = [
  { fromPage: 1, intervalMs: 1 * DAY_MS },
  { fromPage: 2, intervalMs: 7 * DAY_MS },
  { fromPage: 3, intervalMs: 30 * DAY_MS },
  { fromPage: 4, intervalMs: 90 * DAY_MS },
];

export function pageRefreshIntervalMs(page) {
  let interval = REFRESH_TIERS[0].intervalMs;
  for (const tier of REFRESH_TIERS) {
    if (page >= tier.fromPage) {
      interval = tier.intervalMs;
    }
  }
  return interval;
}

export function isPageDue(fetchedAt, page, now = Date.now()) {
  if (typeof fetchedAt !== 'string' || !fetchedAt) {
    return true;
  }
  const time = Date.parse(fetchedAt);
  if (Number.isNaN(time)) {
    return true;
  }
  return now - time >= pageRefreshIntervalMs(page);
}

// git tag 列表每天全量抓一次（分页取全；与 releases 分档独立）
export const TAGS_REFRESH_INTERVAL_MS = DAY_MS;

export function isTagsDue(tagsFetchedAt, now = Date.now()) {
  if (typeof tagsFetchedAt !== 'string' || !tagsFetchedAt) {
    return true;
  }
  const time = Date.parse(tagsFetchedAt);
  if (Number.isNaN(time)) {
    return true;
  }
  return now - time >= TAGS_REFRESH_INTERVAL_MS;
}

function emptyModState() {
  return { page1Etag: null, page1FetchedAt: null, pages: {}, tagsFetchedAt: null };
}

// state 文件清洗；格式不对按空 state 处理（首次运行/迁移）
export function normalizeRefreshState(raw) {
  const mods = {};
  const sourceMods = raw && typeof raw === 'object' ? raw.mods : null;
  if (sourceMods && typeof sourceMods === 'object' && !Array.isArray(sourceMods)) {
    for (const [repo, entry] of Object.entries(sourceMods)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const pages = {};
      if (entry.pages && typeof entry.pages === 'object' && !Array.isArray(entry.pages)) {
        for (const [page, fetchedAt] of Object.entries(entry.pages)) {
          const pageNumber = Number(page);
          if (Number.isInteger(pageNumber) && pageNumber >= 2 && typeof fetchedAt === 'string') {
            pages[String(pageNumber)] = fetchedAt;
          }
        }
      }
      mods[repo] = {
        page1Etag: typeof entry.page1Etag === 'string' ? entry.page1Etag : null,
        page1FetchedAt:
          typeof entry.page1FetchedAt === 'string' ? entry.page1FetchedAt : null,
        pages,
        tagsFetchedAt:
          typeof entry.tagsFetchedAt === 'string' ? entry.tagsFetchedAt : null,
      };
    }
  }
  return {
    formatVersion: 1,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    mods,
  };
}

export function cloneModState(entry) {
  if (!entry) {
    return emptyModState();
  }
  return {
    page1Etag: entry.page1Etag ?? null,
    page1FetchedAt: entry.page1FetchedAt ?? null,
    pages: { ...entry.pages },
    tagsFetchedAt: entry.tagsFetchedAt ?? null,
  };
}

// 旧 per-mod 文件的 source.releasesEtag / releasesFetchedAt 视为第 1 页缓存；
// 深层页按 releases 数量推断，把时间记成同一次抓取，避免升级后立刻全量重抓。
export function bootstrapModState({ legacySource, releaseCount, fallbackFetchedAt }) {
  const state = emptyModState();
  const fetchedAt =
    (typeof legacySource?.releasesFetchedAt === 'string'
      ? legacySource.releasesFetchedAt
      : null) ?? fallbackFetchedAt ?? null;
  state.page1Etag =
    typeof legacySource?.releasesEtag === 'string' ? legacySource.releasesEtag : null;
  state.page1FetchedAt = fetchedAt;
  const pageCount = Math.ceil((releaseCount ?? 0) / 100);
  for (let page = 2; page <= pageCount; page += 1) {
    if (fetchedAt) {
      state.pages[String(page)] = fetchedAt;
    }
  }
  return state;
}

export function stateBodyChanged(previous, next) {
  if (!previous) {
    return true;
  }
  return JSON.stringify(previous.mods) !== JSON.stringify(next.mods);
}

export function buildRefreshStateFile({ mods, updatedAt }) {
  return {
    formatVersion: 1,
    updatedAt,
    mods,
  };
}
