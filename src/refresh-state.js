// 刷新调度缓存（state/refresh.json）：只存 ETag 与最近抓取时间，不存 release 数据。
// 频率：最新 100 tag（releases/tags 第 1 页）每 2 小时；第 2 页每周；全量（所有页）每月。

export const REFRESH_STATE_REL_PATH = 'state/refresh.json';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// 分档：第 1 页 2 小时、第 2 页每周、全量（第 3 页起 + 所有 tags 页）每月
export const REFRESH_TIERS = [
  { page: 1, intervalMs: TWO_HOURS_MS, label: '2h' },
  { page: 2, intervalMs: WEEK_MS, label: 'week' },
  { page: 'full', intervalMs: MONTH_MS, label: 'month' },
];

export const PAGE1_INTERVAL_MS = TWO_HOURS_MS;
export const PAGE2_INTERVAL_MS = WEEK_MS;
export const FULL_INTERVAL_MS = MONTH_MS;

export function pageRefreshIntervalMs(page) {
  if (page === 1) {
    return PAGE1_INTERVAL_MS;
  }
  if (page === 2) {
    return PAGE2_INTERVAL_MS;
  }
  return FULL_INTERVAL_MS;
}

function isDue(fetchedAt, intervalMs, now) {
  if (typeof fetchedAt !== 'string' || !fetchedAt) {
    return true;
  }
  const time = Date.parse(fetchedAt);
  if (Number.isNaN(time)) {
    return true;
  }
  return now - time >= intervalMs;
}

// 第 1/2 页与全量的到期判断（now 可注入，便于测试）
export function isPageDue(fetchedAt, page, now = Date.now()) {
  return isDue(fetchedAt, pageRefreshIntervalMs(page), now);
}

export const isPage1Due = (fetchedAt, now = Date.now()) =>
  isDue(fetchedAt, PAGE1_INTERVAL_MS, now);
export const isPage2Due = (fetchedAt, now = Date.now()) =>
  isDue(fetchedAt, PAGE2_INTERVAL_MS, now);
export const isFullDue = (fetchedAt, now = Date.now()) =>
  isDue(fetchedAt, FULL_INTERVAL_MS, now);

// 兼容旧调用：tag 列表跟随 page1 tier（2h）；page2/full 的 tags 页跟随对应 tier
export function isTagsDue(tagsFetchedAt, now = Date.now()) {
  return isDue(tagsFetchedAt, PAGE1_INTERVAL_MS, now);
}

function emptyModState() {
  return {
    page1Etag: null,
    page1FetchedAt: null,
    page2FetchedAt: null,
    fullFetchedAt: null,
    tagsFetchedAt: null,
  };
}

function latestPageTimestamp(pages) {
  let latest = null;
  for (const fetchedAt of Object.values(pages ?? {})) {
    if (typeof fetchedAt !== 'string') {
      continue;
    }
    if (latest === null || Date.parse(fetchedAt) > Date.parse(latest)) {
      latest = fetchedAt;
    }
  }
  return latest;
}

// state 文件清洗；兼容旧格式（pages 映射 + 24h/7d/30d/90d 分档）迁移
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
      const page1FetchedAt =
        typeof entry.page1FetchedAt === 'string' ? entry.page1FetchedAt : null;
      // 旧格式：pages["2"] / 更深页 → page2FetchedAt / fullFetchedAt
      const legacyDeep = Object.fromEntries(
        Object.entries(pages).filter(([page]) => Number(page) >= 3),
      );
      const page2FetchedAt =
        typeof entry.page2FetchedAt === 'string'
          ? entry.page2FetchedAt
          : (pages['2'] ?? null);
      const fullFetchedAt =
        typeof entry.fullFetchedAt === 'string'
          ? entry.fullFetchedAt
          : (latestPageTimestamp(legacyDeep) ?? page2FetchedAt ?? page1FetchedAt);
      mods[repo] = {
        page1Etag: typeof entry.page1Etag === 'string' ? entry.page1Etag : null,
        page1FetchedAt,
        page2FetchedAt,
        fullFetchedAt,
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
    page2FetchedAt: entry.page2FetchedAt ?? null,
    fullFetchedAt: entry.fullFetchedAt ?? null,
    tagsFetchedAt: entry.tagsFetchedAt ?? null,
  };
}

// 旧 per-mod 文件迁移：第 1 页沿用旧 source 时间；旧数据默认视为「已拿到当时完整页」，
// page2/full 时间跟第 1 页一致，避免升级后立刻全量重抓
export function bootstrapModState({ legacySource, releaseCount, fallbackFetchedAt }) {
  const state = emptyModState();
  const fetchedAt =
    (typeof legacySource?.releasesFetchedAt === 'string'
      ? legacySource.releasesFetchedAt
      : null) ?? fallbackFetchedAt ?? null;
  state.page1Etag =
    typeof legacySource?.releasesEtag === 'string' ? legacySource.releasesEtag : null;
  state.page1FetchedAt = fetchedAt;
  const count = releaseCount ?? 0;
  if (count > 0) {
    // 旧数据视为已拿到当时完整的页：page2/full 同一起算点，避免升级后立刻抓第 2 页/全量
    state.fullFetchedAt = fetchedAt;
    state.page2FetchedAt = fetchedAt;
  }
  return state;
}

// 最近一次刷新时间（API 不足时排队用：越久没刷新越优先）
export function lastRefreshedAt(entry) {
  const values = [
    entry?.page1FetchedAt,
    entry?.page2FetchedAt,
    entry?.fullFetchedAt,
    entry?.tagsFetchedAt,
  ].filter((value) => typeof value === 'string' && value);
  let latest = 0;
  for (const value of values) {
    const time = Date.parse(value);
    if (!Number.isNaN(time) && time > latest) {
      latest = time;
    }
  }
  return latest;
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
